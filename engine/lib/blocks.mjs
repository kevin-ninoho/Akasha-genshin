// 原神工作台 · 结构化答案块
//
// 为什么要有这一层：
//   纯文本回答解决的是「说得对不对」，解决不了「拿不拿得到东西」。
//   用户说「给我胡桃的立绘」，回他一段描述立绘长相的文字是没用的 —— 他要的是图。
//   用户说「胡桃用什么武器」，回他一段散文，不如给一张能直接看懂的推荐表。
//
// 两个设计原则：
//   1) **路由是确定性的**，不让模型猜。模型只负责「说人话」，
//      「该不该出图/出表」由规则决定 —— 否则小模型会漏、会乱出。
//   2) **块是附加的，不是替代的**。模型照常回答，块在旁边把可操作的东西给出来。
//      块挂了不影响回答，回答失败也不影响块。
//
// 块是**纯数据**，不含渲染逻辑；URL 全部是相对路径（/v1/...），
// 客户端自己拼服务器前缀 —— 这样远端模式和本地模式共用同一份块。

import { voiceGroupOf, VOICE_GROUP_ORDER } from './v1-data.mjs';
import { parseEntryModules } from './obc-modules.mjs';
// 「问句 → 观测枢 kind」「kind → 中文」「哪些 kind 有本地图标」全部来自
// lib/obc-kinds.mjs —— 块这边原先各有一份副本（OBC_KINDS / OBC_KIND_LABEL_CN），
// 补采后 menu 从 7 涨到 53，副本一过期标签就变成英文 slug。
import { OBC_PICK_KINDS, OBC_ICON_KINDS, OBC_DOMAIN_TRIGGERS, obcLabel } from './obc-kinds.mjs';
import { canonicalizeNames } from './nicknames.mjs';

/** 六种块。客户端按 kind 分派渲染器。 */
export const BLOCK_KINDS = [
  'image', 'voice-list', 'relation-graph', 'stat-table', 'list',
  'talent', 'constellation', 'ascension',
  'video-scenes',
];

// 数据来源说明：块里的结构化数据全部来自观测枢**页面 JSON 的模块**，
// 由 lib/obc-modules.mjs 解析。覆盖率实测（136 个角色）：
//   天赋（含倍率表）135/136 · 角色突破（培养材料）136/136 · 推荐装备 136/136
//   命之座 134/136，但其中**只有 53 个是完整的 6 个**，81 个观测枢只填了第 1 个。
//   已核对：实时调用官方接口也是同样结果，所以那是源头缺口，不是采集丢了。
const MODULE_SOURCE_NOTE = '数据来源：米游社观测枢';

// ------------------------------------------------------------------ 容量上限
// 块是给人看的，不是导出。超过上限就截断并标 truncated，客户端提示「还有 N 条」。
const LIMIT = {
  voiceGroups: 4, voiceLines: 8,
  relationNodes: 24,
  statSlots: 3, statRows: 6,
  listRows: 20,
  talentMultiplierRows: 12,
  ascensionStages: 6,
};

// ------------------------------------------------------------------ 意图路由
// 注意：一条问题可以命中多个意图（「胡桃的立绘和语音」），所以返回数组。
// 顺序即优先级 —— **具体的排前面，笼统的排后面**。
// 「圣遗物推荐」必须命中 artifact 而不是 build，否则会把武器也一起端出来（实测踩过）。
const RULES = [
  { id:'video', re:[/\bpv\b/i,/视频/,/预告/,/过场动画/] },
  { id: 'art', re: [/立绘/, /头像/, /图标/, /画像/, /原画/, /长什么样/, /长啥样/, /什么样子/, /什么模样/, /形象/, /外观/, /图片/, /照片/, /截图/, /看看.*样/] },
  // 「这个角色是谁」—— 给一张紧凑立绘 + 基础档案（元素/武器类型/生日/CV/命座）。
  // 单列一条是因为它以前**没有任何意图命中**：问「胡桃是谁」「介绍一下胡桃」
  // 一个块都不出，而问「胡桃的推荐武器」反而会附一张立绘 —— 正好反了。
  { id: 'profile', re: [/是谁/, /什么人/, /什么角色/, /介绍/, /资料/, /档案/, /基本信息/, /这个人/, /什么来历/, /角色卡/, /图鉴/] },
  { id: 'voice', re: [/语音/, /配音/, /声优/, /说过什么/, /说过啥/, /口头禅/, /台词/, /\bcv\b/i] },
  { id: 'relation', re: [/关系/, /和谁/, /跟谁/, /认识谁/, /亲友/, /师徒/, /同伴/, /羁绊/, /交集/, /关联/, /联系/] },
  // —— 以下五个是「角色养成」域，从具体到笼统
  { id: 'constellation', re: [/命座/, /命之座/, /几命/, /满命/, /一命/, /二命/, /六命/] },
  { id: 'talent', re: [/天赋/, /技能/, /倍率/, /元素战技/, /元素爆发/, /普通攻击/, /普攻/, /\be技能\b/i, /\bq技能\b/i] },
  { id: 'ascension', re: [/突破材料/, /培养材料/, /升级材料/, /进阶材料/, /要什么材料/, /需要什么材料/, /材料.*(刷|打|获取|在哪)/, /怎么突破/, /突破要/] },
  { id: 'weapon', re: [/武器/, /用什么剑/, /用什么枪/, /带什么/, /适合.*(武器|装备)/] },
  { id: 'artifact', re: [/圣遗物/, /套装/, /词条/, /沙漏/, /杯子/, /头冠/] },
  { id: 'build', re: [/配装/, /培养/, /怎么练/, /配队/, /阵容/, /搭配/, /推荐/, /面板/, /数值/, /属性/] },
  { id: 'list', re: [/有哪些/, /都有谁/, /一共.*(多少|几)/, /多少个/, /多少位/, /多少把/, /列表/, /全部/, /所有/, /列举/, /盘点/, /清单/] },
];

/**
 * 判断问题在要哪几类结构化结果。
 * @returns {{ intents: string[], matched: Record<string,string> }} matched 记录命中的原词，便于排查
 */
export function routeIntents(question) {
  const s = String(question || '');
  const intents = [];
  const matched = {};
  for (const r of RULES) {
    for (const re of r.re) {
      const m = s.match(re);
      if (m) {
        intents.push(r.id);
        matched[r.id] = m[0];
        break;
      }
    }
  }
  return { intents, matched };
}

// ------------------------------------------------------------------ 过滤条件抽取
const FILTERS = [
  { col: 'element', vals: ['火', '水', '风', '雷', '草', '冰', '岩'] },
  { col: 'weapon', vals: ['单手剑', '双手剑', '长柄武器', '弓', '法器'] },
  { col: 'region', vals: ['蒙德', '璃月', '稻妻', '须弥', '枫丹', '纳塔', '至冬', '坎瑞亚'] },
];
// 星级：中文里「五星」和「5星」一样常见，只认阿拉伯数字会漏掉前者。
const RARITY_RE = /([45]|[四五])\s*星/;
const RARITY_NORM = { 四: '4', 五: '5', 4: '4', 5: '5' };

/** 从问题里抽出「列角色」的过滤条件。抽不到就返回空（即「全部角色」）。 */
export function extractCharacterFilter(question) {
  const s = String(question || '');
  const where = [];
  for (const f of FILTERS) {
    for (const v of f.vals) {
      if (s.includes(v)) { where.push(`${f.col}:${v}`); break; }
    }
  }
  const rm = s.match(RARITY_RE);
  if (rm) where.push(`rarity:${RARITY_NORM[rm[1]] || rm[1]}`);
  return where;
}

/** 从问题里抽「列观测枢图鉴」的 kind（顺序即优先级，见 lib/obc-kinds.mjs 的 OBC_PICK_ORDER）。 */
export function extractObcKind(question) {
  const s = String(question || '');
  if (/材料|道具/.test(s)) return 'item';
  if (/食物|料理|食谱/.test(s)) return 'food';
  for (const t of OBC_DOMAIN_TRIGGERS) if (t.re.test(s)) return t.kinds[0];
  for (const k of OBC_PICK_KINDS) if (k.re.test(s)) return k.kind;
  return '';
}

// ------------------------------------------------------------------ 工具

/** 从锚点/实体里找出问题指向的那个角色。返回 { id, row } 或 null。 */
function targetCharacter(v1, anchors = [], entities = []) {
  const names = [];
  for (const a of anchors) if (a && a.kind === 'character' && a.name) names.push(a.name);
  for (const e of entities) if (e && e.name) names.push(e.name);
  for (const n of names) {
    const id = v1.resolveCharacterId(n);
    if (id) {
      try { const row = v1.db.prepare('SELECT * FROM characters WHERE id = ? AND game_id = 1').get(id); if (row) return { id, row }; }
      catch { /* 忽略 */ }
    }
  }
  return null;
}

const cut = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; };

// ------------------------------------------------------------------ 六种块

/** ① 图片：立绘 / 缩略图 / 头像。
 *  compact=true 时只给头像+半身像 —— 用于「没明确要立绘，但问到了某个角色」的场合，
 *  当视觉锚点用，不该占掉整屏。 */
function buildImage(v1, char, compact = false) {
  if (!char) return null;
  const { id, row } = char;
  const items = [];
  if (row.has_full_art) {
    if (!compact) items.push({ size: 'display', label: '全身立绘', url: `/v1/asset/character/${id}?size=display` });
    items.push({ size: 'thumb', label: compact ? '立绘' : '半身像', url: `/v1/asset/character/${id}?size=thumb` });
  }
  if (row.has_icon) items.push({ size: 'icon', label: '头像', url: `/v1/asset/character/${id}?size=icon` });
  if (!items.length) return null;
  const sub = [row.rarity ? `${row.rarity}★` : '', row.element, row.weapon, row.faction].filter(Boolean).join(' · ');
  return { kind: 'image', title: `${row.name}${compact ? '' : ' · 立绘'}`, subtitle: sub, compact, items };
}

/** ② 语音列表：按名字重新分组（不能直接用 grp，会塌成一组）。 */
function buildVoice(v1, char) {
  if (!char) return null;
  let rows;
  try {
    rows = v1.db.prepare('SELECT name, text, ord FROM voice_lines WHERE character_id = ? ORDER BY ord ASC').all(char.id);
  } catch { return null; }
  if (!rows.length) return null;

  const buckets = new Map();
  for (const r of rows) {
    const g = voiceGroupOf(r.name);
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(r);
  }
  const ordered = [...buckets.entries()].sort(
    (a, b) => VOICE_GROUP_ORDER.indexOf(a[0]) - VOICE_GROUP_ORDER.indexOf(b[0]),
  );
  const groups = ordered.slice(0, LIMIT.voiceGroups).map(([name, list]) => ({
    name,
    count: list.length,
    lines: list.slice(0, LIMIT.voiceLines).map((r) => ({ name: r.name, text: cut(r.text, 160) })),
  }));
  return {
    kind: 'voice-list',
    title: `${char.row.name} · 语音`,
    total: rows.length,
    groupCount: buckets.size,
    groups,
    truncated: ordered.length > LIMIT.voiceGroups || buckets.size > LIMIT.voiceGroups,
  };
}

/** ③ 关系图：nodes + edges。边带 quote 作为依据，客户端可点开看原话。 */
function buildRelation(v1, char) {
  if (!char) return null;
  let rows;
  try {
    rows = v1.db.prepare('SELECT target_id, target_name, quote FROM relations WHERE src_id = ? ORDER BY id ASC').all(char.id);
  } catch { return null; }
  if (!rows.length) return null;

  const selfNode = { id: `c${char.id}`, name: char.row.name, kind: 'character', self: true };
  const nodes = [selfNode];
  const seen = new Set([selfNode.id]);
  const edges = [];
  for (const r of rows) {
    const name = String(r.target_name || '').trim();
    if (!name) continue;
    // target_id 有值 = 库内角色（可跳转）；没值 = 概念/物品（只作为文字节点）
    const nid = r.target_id ? `c${r.target_id}` : `t:${name}`;
    if (!seen.has(nid)) {
      seen.add(nid);
      nodes.push({ id: nid, name, kind: r.target_id ? 'character' : 'concept', linkable: !!r.target_id });
    }
    edges.push({ from: selfNode.id, to: nid, quote: cut(r.quote, 120) });
    if (edges.length >= LIMIT.relationNodes) break;
  }
  if (edges.length <= 1 && !nodes.some((n) => n.kind === 'character' && !n.self)) return null;
  return {
    kind: 'relation-graph',
    title: `${char.row.name} · 关系网`,
    total: rows.length,
    nodes,
    edges,
    truncated: rows.length > edges.length,
  };
}

/** ④ 数据表：基础档案 + 观测枢配装推荐。
 *  slotFilter 非空时只出该 slot —— 问「圣遗物」就不该把武器端出来。 */
function buildStat(v1, char, slotFilter = null) {
  if (!char) return null;
  const r = char.row;
  const profile = [
    ['元素', r.element], ['武器', r.weapon], ['稀有度', r.rarity ? `${r.rarity}★` : ''],
    ['命之座', r.constellation], ['所属', r.faction], ['地区', r.region],
    ['生日', r.birthday], ['CV', r.cv_cn],
  ].filter(([, v]) => v).map(([k, v]) => ({ k, v: String(v) }));

  const tables = [];
  try {
    // 注意：obc_recommend.src_id 是**观测枢条目 id**，不是主库 characters.id。
    // （安柏在观测枢是 54，在主库是 42。）所以只能按名字关联，按 id 会全查空。
    const recs = v1.obc.prepare(
      'SELECT slot, target_name, reason, affix FROM obc_recommend WHERE src_name = ? AND src_kind = ? ORDER BY id ASC',
    ).all(r.name, 'character');
    const bySlot = new Map();
    for (const it of recs) {
      if (slotFilter && it.slot !== slotFilter) continue;
      if (!bySlot.has(it.slot)) bySlot.set(it.slot, []);
      bySlot.get(it.slot).push(it);
    }
    // 优先「武器推荐 / 圣遗物推荐」，其次是别的 slot
    const order = ['武器推荐', '圣遗物推荐'];
    const slots = [...bySlot.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // 推荐条目 → 观测枢同名条目（武器/圣遗物）的 id，用来取缩略图。
    // 用户要的是「武器信息 + **武器图片**」——只给一串名字不够。
    const iconStmt = v1.obc.prepare(
      `SELECT id FROM obc_entries WHERE name = ? AND kind IN (${OBC_ICON_KINDS.map(() => '?').join(',')}) LIMIT 1`,
    );
    const iconOf = (name) => {
      try {
        const e = iconStmt.get(name, ...OBC_ICON_KINDS);
        return e ? `/v1/asset/obc/${e.id}` : '';
      } catch { return ''; }
    };
    for (const slot of slots.slice(0, LIMIT.statSlots)) {
      const list = bySlot.get(slot);
      tables.push({
        slot,
        total: list.length,
        columns: ['名称', '推荐理由'],
        // 第一格给对象（文字 + 缩略图），前端认对象就画图；认不出来也不影响纯文字。
        rows: list.slice(0, LIMIT.statRows).map((it) => [
          { text: it.target_name, icon: iconOf(it.target_name) },
          cut(it.reason, 90),
        ]),
        truncated: list.length > LIMIT.statRows,
      });
    }
  } catch { /* 观测枢推荐缺失不影响档案 */ }

  if (!profile.length && !tables.length) return null;
  const only = slotFilter || '';
  // 指定了具体方面（「推荐武器」「推荐圣遗物」）时就**不带档案**。
  // 档案（元素/武器类型/生日/CV/命座…）是"这个角色是谁"的内容，
  // 用户明确问武器时把生日和 CV 一起端出来就是"多给了"。
  // 早先的理由是"档案只有 8 项不占地方"，那是从**体积**考虑的；
  // 用户的诉求是**贴题**，不是省地方。
  // 问「配装」这种笼统的（slotFilter 为空）仍然带 —— 那时角色概览本身就是上下文。
  return {
    kind: 'stat-table',
    title: `${r.name} · ${only || '数据与配装'}`,
    profile: slotFilter ? [] : profile,
    tables,
    source: tables.length ? '米游社观测枢' : '',
  };
}

// ------------------------------------------------------------------ 角色养成模块
// 这三个块的数据来自观测枢词条的**模块**（raw_json），不是推荐表。
// 解析逻辑在 lib/obc-modules.mjs —— 那批数据早就在库里，只是之前没拆出来。

/** 取角色的观测枢词条并解析出模块。取不到就返回 null。 */
function modulesOf(v1, char) {
  if (!char) return null;
  try {
    const row = v1.obc.prepare(
      "SELECT id, raw_json FROM obc_entries WHERE kind = 'character' AND name = ?",
    ).get(char.row.name);
    if (!row || !row.raw_json) return null;
    return parseEntryModules(row.raw_json, { id: row.id });
  } catch { return null; }
}

/** ⑦ 天赋 / 技能：名称 + 描述 + LV1~LVn 倍率表。 */
function buildTalent(v1, char) {
  if (!char) return null;
  const m = modulesOf(v1, char);
  if (!m || !m.talents.length) return null;
  const items = m.talents.map((t) => ({
    tab: t.tab,
    title: t.title,
    icon: t.icon,
    desc: cut(t.desc, 420),
    // 倍率表可能很宽（LV1~LV13），只保留表头和前若干行，客户端横向滚动
    multipliers: t.multipliers ? {
      header: t.multipliers.header,
      rows: t.multipliers.rows.slice(0, LIMIT.talentMultiplierRows),
      truncated: t.multipliers.rows.length > LIMIT.talentMultiplierRows,
    } : null,
  }));
  const withMul = items.filter((x) => x.multipliers).length;
  return {
    kind: 'talent',
    title: `${char.row.name} · 天赋与技能`,
    total: items.length,
    withMultipliers: withMul,
    items,
    source: MODULE_SOURCE_NOTE,
  };
}

/** ⑧ 命之座。观测枢对 81/136 个角色只填了第 1 个，如实告知而不是假装完整。 */
function buildConstellation(v1, char) {
  if (!char) return null;
  const m = modulesOf(v1, char);
  if (!m || !m.constellations.length) return null;
  const list = m.constellations;
  const incomplete = list.length < 6;
  return {
    kind: 'constellation',
    title: `${char.row.name} · 命之座`,
    total: list.length,
    // 观测枢源头缺口：实测实时调官方接口也是同样结果，不是我们采集丢了
    incomplete,
    note: incomplete
      ? `观测枢该词条只填了 ${list.length} 个命座（完整应为 6 个）。已核对官方接口，源头即如此。`
      : '',
    items: list.map((c) => ({ index: c.index, name: c.name, icon: c.icon, desc: cut(c.desc, 320) })),
    source: MODULE_SOURCE_NOTE,
  };
}

/** ⑨ 培养材料：分阶段 + 材料名 + 数量 + 图标。 */
function buildAscension(v1, char) {
  if (!char) return null;
  const m = modulesOf(v1, char);
  if (!m || !m.ascensions.length) return null;
  // 只保留「突破」阶段；「1级属性」「90级属性」这种属性段没有材料意义
  const stages = m.ascensions.filter((a) => a.materials.length && /突破/.test(a.stage));
  if (!stages.length) return null;
  return {
    kind: 'ascension',
    title: `${char.row.name} · 突破培养材料`,
    total: stages.length,
    items: stages.slice(0, LIMIT.ascensionStages).map((a) => ({
      stage: a.stage,
      materials: a.materials.map((x) => ({ name: x.name, amount: x.amount, icon: x.icon })),
    })),
    truncated: stages.length > LIMIT.ascensionStages,
    source: MODULE_SOURCE_NOTE,
  };
}

/**
 * ⑤ 列表：角色 / 观测枢图鉴 / 书籍。
 * 复用 v1.query（那层已被 39 项覆盖测试打过），不重复写 SQL。
 */
function buildList(v1, question) {
  const obcKind = extractObcKind(question);
  const wantsObc = !!obcKind;
  const charWhere = extractCharacterFilter(question);

  // 角色表：问题里有元素/地区/武器/星级这类词，或明确问「有哪些角色」
  const wantsChar = !wantsObc && (charWhere.length > 0 || /角色|人物/.test(question));

  if (wantsObc && !wantsChar) {
    const location = question.match(/蒙德|璃月|稻妻|须弥|枫丹|纳塔|至冬|坎瑞亚/)?.[0] || '';
    const res = v1.query({ domain: 'obc', where: `kind:${obcKind}`, q: location, limit: LIMIT.listRows });
    if (!res || !res.items.length) return null;
    const label = obcLabel(obcKind);
    return {
      kind: 'list',
      domain: 'obc',
      title: `官方图鉴 · ${label}（共 ${res.total} 条）`,
      total: res.total,
      columns: ['名称', '分类'],
      rows: res.items.map((it) => [it.name, it.label || it.kind || '']),
      truncated: res.truncated,
      source: '米游社观测枢',
    };
  }

  if (wantsChar) {
    const res = v1.query({ domain: 'character', where: charWhere.join(','), limit: LIMIT.listRows });
    if (!res || !res.items.length) return null;
    const desc = charWhere.map((w) => w.split(':')[1]).join(' · ');
    return {
      kind: 'list',
      domain: 'character',
      title: `${desc ? desc + ' · ' : ''}角色（共 ${res.total} 位）`,
      total: res.total,
      columns: ['角色', '元素', '武器', '稀有度', '地区'],
      rows: res.items.map((it) => [it.name, it.element, it.weapon, it.rarity ? `${it.rarity}★` : '', it.region]),
      truncated: res.truncated,
      source: '米游社观测枢',
    };
  }
  return null;
}

// ------------------------------------------------------------------ 对外入口

/**
 * 按意图造块。任何一块出问题都只丢它自己，不影响别的块，也不影响模型回答。
 *
 * @param {{v1:object, question:string, anchors?:Array, entities?:Array}} ctx
 * @returns {Array<object>} 块数组，可能为空
 */
export function buildBlocks({ v1, question, anchors = [], entities = [], videoIndex = null }) {
  question = canonicalizeNames(question);
  const out = [];
  let routed;
  try { routed = routeIntents(question); } catch { return out; }
  if (!routed.intents.length) return out;

  // 需要「某个角色」的几种块共用同一个解析结果
  let char = null;
  const NEED_CHAR = ['art', 'profile', 'voice', 'relation', 'weapon', 'artifact', 'build', 'talent', 'constellation', 'ascension'];
  const needsChar = routed.intents.some((i) => NEED_CHAR.includes(i));
  if (needsChar) {
    try { char = targetCharacter(v1, anchors, entities); } catch { char = null; }
  }

  // 角色图只在**问这个角色本身**时附上（「胡桃是谁」「胡桃长什么样」）。
  //
  // 问具体方面（武器 / 圣遗物 / 突破材料 / 天赋 / 命座 / 语音 / 关系）时**不附**——
  // 那些块自己带图：武器推荐给武器图，圣遗物推荐给圣遗物图。
  // 再叠一张角色立绘就是"多给了"。
  //
  // 这里改过一次方向：
  //   早先为了「别让用户觉得没图」给所有角色问题都附了紧凑立绘，
  //   结果用户问「胡桃的推荐武器」，收到的是胡桃立绘 + 一堆武器名字，
  //   直接反馈「不要把立绘给我，问什么给什么，不多不少」。
  const ASPECT_INTENTS = ['weapon', 'artifact', 'build', 'talent', 'constellation',
    'ascension', 'voice', 'relation'];
  const aspectAsk = routed.intents.some((i) => ASPECT_INTENTS.includes(i));
  if (char && !routed.intents.includes('art') && !aspectAsk) {
    try {
      const img = buildImage(v1, char, true);
      if (img) { img.reason = '角色锚点'; out.push(img); }
    } catch { /* 图片失败不影响别的块 */ }
  }

  for (const intent of routed.intents) {
    // 「推荐」这种笼统词会和具体词同时命中（「圣遗物推荐」= artifact + build）。
    // 具体项已经单独出块了，笼统的 build 再出一次就会把武器也端出来 —— 实测用户会问
    // 「我要圣遗物，你怎么把武器也给我了」。所以具体项命中时压掉 build。
    if (intent === 'build' && routed.intents.some((i) => i === 'weapon' || i === 'artifact' || i === 'ascension')) continue;

    let block = null;
    try {
      if (intent === 'art') block = buildImage(v1, char, false);
      else if (intent === 'profile') {
        // 「是谁 / 介绍一下」只要基础档案。buildStat 会把养成数据（武器推荐、
        // 圣遗物推荐）一起端出来，那不是这个问题要的 —— 问什么给什么。
        block = buildStat(v1, char, null);
        if (block) {
          block.tables = [];
          // 标题从 buildStat 算好的那个派生，别自己拼 ——
          // 外面这个 char 对象的字段名和 buildStat 内部用的不是一回事，
          // 直接 char.name 会得到 undefined（踩过）。
          block.title = String(block.title).replace(/\s*·\s*.*$/, ' · 基础档案');
          block.source = '';
        }
      }
      else if (intent === 'voice') block = buildVoice(v1, char);
      else if (intent === 'relation') block = buildRelation(v1, char);
      else if (intent === 'weapon') block = buildStat(v1, char, '武器推荐');
      else if (intent === 'artifact') block = buildStat(v1, char, '圣遗物推荐');
      else if (intent === 'build') block = buildStat(v1, char, null);
      else if (intent === 'talent') block = buildTalent(v1, char);
      else if (intent === 'constellation') block = buildConstellation(v1, char);
      else if (intent === 'ascension') block = buildAscension(v1, char);
      else if (intent === 'list') block = buildList(v1, question);
      else if (intent === 'video' && videoIndex?.configured) {
        const name = char?.row?.name || entities.find(e => e.name)?.name || '';
        const items = [...videoIndex.entries.entries()]
          .map(([key, item]) => {
            const [entryId, videoIndex] = key.split(':').map(Number);
            return { entryId, videoIndex, title: item.title };
          })
          .filter((item) => !name || item.title.includes(name))
          .slice(0, 6);
        if(items.length)block={kind:'video-scenes',title:'PV 片段选择',items,total:items.length,source:'米游社观测枢'};
      }
    } catch { block = null; }
    if (block) {
      block.reason = routed.matched[intent] || intent;
      // 同一回合里已经有图时，不要再塞一张重复的
      if (block.kind === 'image' && out.some((b) => b.kind === 'image')) continue;
      out.push(block);
    }
  }
  return out;
}

/** 块的概要，给 /v1/chat 的 done 事件和审计用（不含正文，只有形状）。 */
export function summarizeBlocks(blocks) {
  const shown = b => b.rows?.length ?? b.items?.length ?? b.edges?.length ?? b.groups?.reduce((n,g)=>n+(g.lines?.length||0),0) ?? b.talents?.length ?? b.stages?.length ?? b.tables?.reduce((n,t)=>n+(t.rows?.length||0),0) ?? 0;
  return (blocks || []).map((b) => ({
    kind: b.kind,
    title: b.title,
    count: b.total != null ? b.total : shown(b),
    shown: shown(b),
    truncated: b.truncated === true,
  }));
}

/** 提示词里告诉模型「已经出了这些块」，免得它用文字再描述一遍图片。 */
export function blockHintForPrompt(blocks, question = '') {
  if (!blocks || !blocks.length) return '';
  const parts = blocks.map((b) => {
    if (b.kind === 'image') return `图片（${b.title}）：立绘/头像已经直接展示给用户了`;
    if (b.kind === 'video-scenes') return `视频（${b.title}）：已列出 ${(b.items || []).length} 个视频并提供连续镜头选段工具；已展示的标题为 ${(b.items || []).map(i=>i.title).join('、')}。不要再次罗列这些标题，不要给整段视频链接；只补充角色 PV 与版本 PV 的区别或必要剧情背景`;
    if (b.kind === 'voice-list') return `语音列表（${b.title}）：共 ${b.total} 条，已按类分组展示`;
    if (b.kind === 'relation-graph') return `关系图（${b.title}）：已用图展示 ${b.edges ? b.edges.length : 0} 条关系`;
    if (b.kind === 'stat-table') {
      const slots = (b.tables || []).map((t) => t.slot).join('、');
      return `配装表（${b.title}）：${slots || '基础档案'}已用表格展示`;
    }
    if (b.kind === 'talent') return `天赋表（${b.title}）：${b.total} 个天赋${b.withMultipliers ? '（含倍率表）' : ''}已展示`;
    if (b.kind === 'constellation') return `命之座（${b.title}）：${b.total} 个命座已展示`;
    if (b.kind === 'ascension') return `培养材料表（${b.title}）：${b.total} 个突破阶段的材料已展示`;
    if (b.kind === 'list') return `列表（${b.title}）：共 ${b.total} 条，已用表格展示`;
    return b.title;
  });
  const videoListOnly = blocks.some(b=>b.kind==='video-scenes') && question && !/为什么|为何|因果|背景|剧情|解释|分析|区别|意义|怎么|如何/.test(question);
  return (videoListOnly ? `\n本轮只请求视频清单或选段。清单已完整覆盖，正文最多一至两句话，只补充一条有依据的必要背景或区别并引用资料；不要分小标题，不要再列举任何视频标题、配音名单或条目。\n` : '') + `\n\n【界面提示】这是给你判断用的背景，**不要**在回答里提到它的存在：\n` +
    `- 不许写「上面已经展示」「界面提示」「系统展示」「按资料补全」这类描述界面行为的话。用户要读的是答案本身，不是你的工作过程。\n` +
    `- 这一整段判断只在心里做，判断结果直接体现在回答内容上，不要说出来。\n\n` +
    `系统已经自动为用户展示了以下结构化内容，你**不要**再用文字把这些逐条复述一遍：\n- ${parts.join('\n- ')}\n` +
    `请只做它们没覆盖的部分：补充背景、解释因果、指出争议。\n` +
    `【但是】先判断一件事：**上面的块有没有回答用户问的东西？**\n` +
    `- 判断标准：块是否真的覆盖用户请求的字段或行为；名字相同不代表问题已回答。图片不覆盖剧情因果，档案不覆盖视频内容，视频标题也不覆盖剧情解释。\n` +
    `- 如果**没有**（典型例子：用户问「有哪些考据文章」，展示的却是角色列表；问某段剧情，展示的却是属性表）\n` +
    `  —— 那就**当这些块不存在**，照常完整作答，用检索到的资料回答用户真正问的问题。这种情况不要只写一句「上面就是全部」。\n` +
    `- 数组块的标题和内容都要看：标题是「蒙德 · 角色（共 24 位）」而用户在问「文章」，就是不匹配。`;
}
