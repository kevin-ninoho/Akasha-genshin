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
// 观测枢原文地址（回链官方来源；obc.mjs 不反向依赖本文件，无循环）
import { obcSourceUrl } from './obc.mjs';
import { canonicalizeNames } from './nicknames.mjs';
// 练度规划引擎。plan.mjs 只依赖 obc-modules / obc / resin-cost，不反向依赖本文件。
import { buildPlan } from './plan.mjs';
// 技能注册表。意图路由、优先级、互斥全部迁到那边（数据驱动），
// 本文件只保留**怎么造块**。注册表不 import 本文件，所以无循环依赖。
import { matchSkills, resolveSkills, buildFromSkills, needsCharacterSet } from './skills/index.mjs';
import { run as runStats } from './skills/stats.mjs';
import { videoCatalog } from './media-jobs.mjs';

/** 客户端按 kind 分派渲染器。 */
export const BLOCK_KINDS = [
  'image', 'voice-list', 'relation-graph', 'stat-table', 'list',
  'talent', 'constellation', 'ascension',
  'video-scenes',
  // 练度规划。由 POST /v1/plan 产出，形状见 lib/plan.mjs 的 buildPlan 返回。
  'plan',
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
//
// 原先这里有一个 RULES 数组（13 条正则）+ 散落在 buildBlocks 里的一串
// `if (intent === 'build' && ...) continue` 抑制规则。已经整体迁到
// **lib/skills/index.mjs** —— 优先级成了数字、互斥成了数据、技能目录成了可展示的元数据。
// 本文件从此只管「怎么造块」，不管「该不该造」。加新技能不用改这里。

/**
 * 判断问题在要哪几类结构化结果。
 *
 * 实现已迁到技能注册表（lib/skills/index.mjs）。**返回值契约不变** ——
 * v1-blocks-smoke 有 60+ 条断言钉着它，所以这里只做形状适配：
 *   intents  命中技能的 id，按优先级降序
 *   matched  id → 命中的原词
 */
export function routeIntents(question) {
  const s = String(question || '');
  let hits;
  try { hits = matchSkills(s); } catch { return { intents: [], matched: {} }; }
  const intents = [];
  const matched = {};
  for (const h of hits) {
    intents.push(h.skill.id);
    matched[h.skill.id] = h.matched;
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
    // 「定位」（如「爆发型输出角色」）来自观测枢角色页。构建器此前读的是语料里
    // 并不存在的「身份」字段，整列被丢弃 —— 这里也就一直没有这一项。
    ['定位', r.role],
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

  // 档案为空壳时的说明。
  //
  // 观测枢只收「可玩角色 / 形态」页，所以派蒙、戴因斯雷布、愚人众执行官这些角色
  // **没有独立角色页** —— 那是源头限制，不是我们没做全。
  // 直接端一张空表（或者干脆不出块）会让用户以为产品不全，考据党尤其在意
  // 「派蒙怎么没有档案」。所以要如实说明，并把他指到真正有资料的地方：台词。
  //
  // ⚠ 顺序要紧：这段必须在下面那个 return null **之前**算完。
  //   否则档案为空（profile.length === 0）的角色会先被判成「没内容」直接丢块，
  //   最需要解释的那几个反而什么都不显示。
  const thin = profile.length < 4;
  let incompleteNote = '';
  if (thin) {
    let lines = 0;
    try {
      lines = v1.db.prepare(
        'SELECT COUNT(*) AS c FROM dialogue_lines l JOIN dialogue_groups g ON g.id = l.group_id WHERE g.character_id = ?',
      ).get(r.id)?.c || 0;
    } catch { /* 台词统计失败不影响档案 */ }
    // 措辞保持「永远为真」：不猜它是剧情角色还是形态分页。
    // 旅行者是可玩的，只是观测枢按元素形态分页，说成「剧情角色」就不准。
    incompleteNote = r.obc_id
      ? `米游社观测枢该词条仅发布了 ${profile.length} 项档案字段。`
      : `米游社观测枢未收录「${r.name}」的独立角色页，因此没有可引用的角色档案。`;
    if (lines) incompleteNote += `本库已收录其剧情台词 ${lines} 条，可直接检索。`;
  }

  if (!profile.length && !tables.length && !incompleteNote) return null;
  const only = slotFilter || '';
  // 指定了具体方面（「推荐武器」「推荐圣遗物」）时就**不带档案**。
  // 档案（元素/武器类型/生日/CV/命座…）是「这个角色是谁」的内容，
  // 用户明确问武器时把生日和 CV 一起端出来就是「多给了」。
  // 问「配装」这种笼统的（slotFilter 为空）仍然带 —— 那时角色概览本身就是上下文。
  return {
    kind: 'stat-table',
    title: `${r.name} · ${only || '数据与配装'}`,
    profile: slotFilter ? [] : profile,
    tables,
    // 让前端把「档案不完整」如实显示出来，而不是留一张空表
    incomplete: !slotFilter && thin,
    note: slotFilter ? '' : incompleteNote,
    // 观测枢原文地址：档案取自官方，就该让用户能回官方核对
    sourceUrl: obcSourceUrl(r.obc_id),
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

/**
 * 「条目名 → 本地图标 URL」解析器。
 *
 * 返回 `/v1/asset/obc/<id>` 这种**同源**路径 —— 客户端有 CSP `img-src 'self'`，
 * 直接用米哈游 CDN 的原始 URL 会被浏览器拦掉，界面上就是一片灰块。
 * 本地文件缺失时返回空串，调用方可以退回原始 URL 或纯文字。
 *
 * 为什么需要一个「惰性 prepared statement」包着：这个函数会在每次造块时被调用，
 * 每次重新 prepare 会明显变慢，而模块级又不能提前拿到 v1。
 */
function makeIconResolver(v1) {
  if (!v1?.obc) return () => '';
  let stmt = null;
  return (name) => {
    if (!name) return '';
    try {
      if (!stmt) {
        stmt = v1.obc.prepare(
          `SELECT id FROM obc_entries WHERE name = ? AND kind IN (${OBC_ICON_KINDS.map(() => '?').join(',')}) LIMIT 1`,
        );
      }
      const e = stmt.get(String(name), ...OBC_ICON_KINDS);
      return e ? `/v1/asset/obc/${e.id}` : '';
    } catch { return ''; }
  };
}

/**
 * ⑨ 培养材料：分阶段 + 材料名 + 数量 + 图标。
 */
function buildAscension(v1, char) {
  if (!char) return null;
  const m = modulesOf(v1, char);
  if (!m || !m.ascensions.length) return null;
  // 只保留「突破」阶段；「1级属性」「90级属性」这种属性段没有材料意义
  const stages = m.ascensions.filter((a) => a.materials.length && /突破/.test(a.stage));
  if (!stages.length) return null;
  // 材料图标走本地 /v1/asset/obc/<id>（同源，CSP 放行）。
  // 模块数据里原本带的是米哈游 CDN 的原始 URL，客户端会拦掉 —— 只在本地缺图时退回它。
  const iconUrl = makeIconResolver(v1);
  return {
    kind: 'ascension',
    title: `${char.row.name} · 突破培养材料`,
    total: stages.length,
    items: stages.slice(0, LIMIT.ascensionStages).map((a) => ({
      stage: a.stage,
      materials: a.materials.map((x) => ({
        name: x.name,
        amount: x.amount,
        icon: iconUrl(x.name) || x.icon || '',
      })),
    })),
    truncated: stages.length > LIMIT.ascensionStages,
    source: MODULE_SOURCE_NOTE,
  };
}

/**
 * ⑩ 练度规划。
 *
 * 和 buildAscension 的区别：那个是「这个角色 1→90 要哪些材料」的**静态全表**；
 * 这个是「**你这个号**从当前等级练到目标等级还差什么」—— 已过的突破段不列，
 * 共用材料合并计费，附树脂与天数。
 *
 * 这是「技能式」入口：用户在聊天里正常说一句话就能触发，不用先去哪个面板配置。
 */
function parsePlanIntent(question, char, entities = [], roster = []) {
  const s = canonicalizeNames(String(question || ''));

  // ── 等级 ──
  // 先抓「练到 90 级」这种明确的**目标**，剩下的数字才是当前等级。
  // 顺序很重要：不先摘掉目标，它会被当成当前等级。
  let targetLevel = 90;
  let rest = s;
  const toM = s.match(/(?:练到|升到|养到|拉到|到|目标)\s*(\d{1,3})\s*级/);
  if (toM) {
    targetLevel = Number(toM[1]);
    rest = s.replace(toM[0], ' ');
  }
  const levels = [];
  const re = /(\d{1,3})\s*级/g;
  let mm;
  while ((mm = re.exec(rest)) !== null) levels.push(Number(mm[1]));
  // 没有「到 X 级」但出现了两个数字时，把大的当目标（「胡桃 80 90」）
  if (!toM && levels.length >= 2) {
    targetLevel = Math.max(...levels);
    levels.splice(levels.indexOf(targetLevel), 1);
  }
  const curLevel = levels.length ? levels[0] : null;

  // ── 角色 ──
  // 优先级：问题里点名的 > 客户端带来的清单 > 检索层解析到的那个角色。
  // 之所以让「点名的」压过清单，是因为用户临时问别人时不该被自己的清单挡住。
  const named = [];
  for (const e of entities || []) {
    const id = e && (e.id != null ? e.id : e.charId);
    const nm = e && (e.name || e.charName);
    if (id != null && nm && /^[\u4e00-\u9fff·A-Za-z]{1,20}$/.test(nm) && !named.some((x) => x.charId === id)) {
      named.push({ charId: Number(id), name: String(nm), level: curLevel || 1 });
    }
  }
  let picked = named;
  if (!picked.length && roster && roster.length) {
    picked = roster.map((r) => ({
      charId: Number(r.charId), name: String(r.name || ''),
      level: Number.isFinite(r.level) ? r.level : (curLevel || 1),
    }));
  }
  if (!picked.length && char && char.row) {
    picked = [{ charId: char.row.id, name: char.row.name, level: curLevel || 1 }];
  }
  if (!picked.length) return null;

  // ── 偏好 ──
  let prefer = 'balanced';
  if (/先练|主c|输出|站场|主力|大c/i.test(s)) prefer = 'dps';
  else if (/辅助|治疗|奶|护盾|盾|增伤/.test(s)) prefer = 'support';
  else if (/收尾|快好了|快满|差的少|先完成/.test(s)) prefer = 'completion';

  return { roster: picked, targetLevel, prefer };
}

function buildPlanBlock(v1, question, char, entities, roster) {
  const parsed = parsePlanIntent(question, char, entities, roster);
  if (!parsed || !parsed.roster.length) return null;

  let result;
  try {
    result = buildPlan(v1, {
      roster: parsed.roster.map((r) => ({ charId: r.charId, level: r.level })),
      target: { level: parsed.targetLevel },
      prefer: parsed.prefer,
    });
  } catch {
    // 规划是纯计算，出错说明数据形状变了 —— 不抛给用户，只是这一轮不出块
    return null;
  }
  if (!result || !result.ok || !result.steps.length) return null;

  // 把 planner 的返回摊平进块里：客户端 render() 读的就是这些字段
  // （steps / materials / summary / conflicts / skipped / notes / rules），
  // 这样聊天里的块和抽屉里的结果是**同一份渲染代码**画的。
  return {
    kind: 'plan',
    title: `练度规划 · ${result.steps.map((s) => s.charName).join('、')}`,
    ...result,
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
/**
 * 每个技能「怎么造块」。键是技能 id，值是 ctx → block。
 *
 * 这些 builder 留在本文件，是因为它们要复用 targetCharacter / modulesOf / LIMIT
 * 这些内部工具。注册表（lib/skills/index.mjs）只放**元数据与路由**，不认识这些函数 ——
 * 所以由本文件把它自己的 builder 传进去，避免循环依赖。
 *
 * 新技能如果不需要这些内部工具（比如 stats），就在 lib/skills/ 里自带 run，
 * **完全不用改本文件** —— 那才是注册表要解决的问题。
 */
const SKILL_HANDLERS = {
  art: (c) => buildImage(c.v1, c.char, false),
  profile: (c) => {
    // 「是谁 / 介绍一下」只要基础档案。buildStat 会把养成数据（武器推荐、
    // 圣遗物推荐）一起端出来，那不是这个问题要的 —— 问什么给什么。
    const block = buildStat(c.v1, c.char, null);
    if (!block) return null;
    block.tables = [];
    // 标题从 buildStat 算好的那个派生，别自己拼 ——
    // 外面这个 char 对象的字段名和 buildStat 内部用的不是一回事，
    // 直接 char.name 会得到 undefined（踩过）。
    block.title = String(block.title).replace(/\s*·\s*.*$/, ' · 基础档案');
    block.source = '';
    return block;
  },
  voice: (c) => buildVoice(c.v1, c.char),
  relation: (c) => buildRelation(c.v1, c.char),
  weapon: (c) => buildStat(c.v1, c.char, '武器推荐'),
  artifact: (c) => buildStat(c.v1, c.char, '圣遗物推荐'),
  build: (c) => buildStat(c.v1, c.char, null),
  talent: (c) => buildTalent(c.v1, c.char),
  constellation: (c) => buildConstellation(c.v1, c.char),
  ascension: (c) => buildAscension(c.v1, c.char),
  plan: (c) => buildPlanBlock(c.v1, c.question, c.char, c.entities, c.roster),
  list: (c) => buildList(c.v1, c.question),
  video: (c) => {
    const name = c.char?.row?.name || (c.entities || []).find((e) => e.name)?.name || '';
    // ① 有视频索引（能定位到具体条目+序号，可剪辑导出）→ 优先用它
    if (c.videoIndex && c.videoIndex.configured) {
      const items = [...c.videoIndex.entries.entries()]
        .map(([key, item]) => {
          const [entryId, videoIndex] = key.split(':').map(Number);
          return { entryId, videoIndex, title: item.title, ...(item.localPath ? { local: true } : {}) };
        })
        .filter((item) => !name || item.title.includes(name))
        .slice(0, 6);
      if (items.length) {
        return { kind: 'video-scenes', title: 'PV 片段选择', items, total: items.length, source: '米游社观测枢' };
      }
    }
    // ② 没有索引 → 退回观测枢元数据目录（只列标题，标成不可剪辑）
    if (!c.v1.obc) return null;
    let rows = [];
    try { rows = c.v1.obc.prepare("SELECT id,name,raw_json,kind FROM obc_entries WHERE kind IN ('char-video','other-video','cutscene') AND name LIKE ? ORDER BY name LIMIT 40").all(`%${name}%`); } catch { /* 表结构不同就返回空 */ }
    const items = videoCatalog(rows).slice(0, 6);
    if (!items.length) return null;
    // 不标 metadata-only：服务端会按需从官方图床取回本体，所以这些条目**可以剪辑**。
      return { kind: 'video-scenes', title: 'PV 片段选择', items, total: items.length, source: '米游社观测枢' };
  },
};

/** 自带 run 的技能（不进 SKILL_HANDLERS，因为它们不需要本文件的内部工具）。 */
const SKILL_MODULES = {
  stats: runStats,
};

export function buildBlocks({ v1, question, anchors = [], entities = [], videoIndex = null, roster = [], skill = '' }) {
  question = canonicalizeNames(question);
  const out = [];
  let hits;
  // skill：用户在界面上明确选的技能（前端输入框上方那个 chip）。
  // 传进来就排在最前，不再靠正则猜他想要什么 —— 他已经说了。
  try { hits = resolveSkills(matchSkills(question, skill), skill); } catch { return out; }
  if (!hits.length) return out;

  // 需要「某个角色」的几种块共用同一个解析结果
  let char = null;
  if (needsCharacterSet(hits)) {
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
    'ascension', 'voice', 'relation', 'plan'];
  const aspectAsk = hits.some((h) => ASPECT_INTENTS.includes(h.skill.id));
  if (char && !hits.some((h) => h.skill.id === 'art') && !aspectAsk) {
    try {
      const img = buildImage(v1, char, true);
      if (img) { img.reason = '角色锚点'; out.push(img); }
    } catch { /* 图片失败不影响别的块 */ }
  }

  out.push(...buildFromSkills(
    hits,
    { v1, question, char, entities, roster, videoIndex, anchors },
    SKILL_HANDLERS,
    SKILL_MODULES,
  ));
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
    if (b.kind === 'video-scenes') return `视频（${b.title}）：已列出 ${(b.items || []).length} 个来自米游社观测枢的元数据条目，视频本体不在本地；标题为 ${(b.items || []).map(i=>i.title).join('、')}。不要声称可在此直接预览或裁剪，也不要给出视频链接；只补充角色 PV 与版本 PV 的区别或必要剧情背景`;
    if (b.kind === 'voice-list') return `语音列表（${b.title}）：共 ${b.total} 条，已按类分组展示`;
    if (b.kind === 'relation-graph') return `关系图（${b.title}）：已用图展示 ${b.edges ? b.edges.length : 0} 条关系`;
    if (b.kind === 'stat-table') {
      const slots = (b.tables || []).map((t) => t.slot).join('、');
      return `配装表（${b.title}）：${slots || '基础档案'}已用表格展示`;
    }
    if (b.kind === 'talent') return `天赋表（${b.title}）：${b.total} 个天赋${b.withMultipliers ? '（含倍率表）' : ''}已展示`;
    if (b.kind === 'constellation') return `命之座（${b.title}）：${b.total} 个命座已展示`;
    if (b.kind === 'ascension') return `培养材料表（${b.title}）：${b.total} 个突破阶段的材料已展示`;
    if (b.kind === 'plan') {
      // 规划块已经把「差什么材料、多少摩拉、多少树脂、几天」全摆在界面上了。
      // 模型这里最容易犯的错是把同一份材料再列一遍 —— 明确禁止。
      const names = (b.steps || []).map((s) => `${s.charName} ${s.from}→${s.to}`).join('、');
      const su = b.summary || {};
      return `练度规划（${b.title}）：已算出 ${names}，共 ${(b.materials || []).length} 种材料、`
        + `摩拉 ${su.mora || 0}、树脂 ${su.resin || 0}（${su.resinIsUpperBound ? '上界' : '估算'}）、约 ${su.days || 0} 天。`
        + `**不要**再逐条复述材料名、数量、摩拉或树脂数字；只补充：为什么是这个顺序、哪些材料能一起刷、`
        + `以及计划覆盖不到的注意事项（例如怪物掉落没给树脂数）`;
    }
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
