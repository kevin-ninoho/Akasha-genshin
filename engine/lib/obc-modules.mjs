// 观测枢条目的**模块解析层**。
//
// 背景（这个文件存在的理由）：
//   采集器当时把观测枢角色页的**整页 JSON**（29 个模块、约 6 万字）都存进了
//   obc_entries.raw_json，但只把纯文本灌进了全文索引 —— 结构化字段一直没拆出来。
//   于是"命之座 / 天赋倍率 / 培养材料"这些**明明已经在库里**的东西，
//   在界面上是查不到的。
//
//   这个文件把它们拆出来。不需要重新采集。
//
// 覆盖情况（136 个角色实测）：
//   角色突破 136/136 · 推荐装备 136/136 · 天赋 135/136 · 命之座 134/136
//
// 解析是纯函数式的：喂 raw_json，吐结构化对象。raw_json 有 60KB，
// 所以带一层按条目 id 的缓存 —— 同一个角色问多次不该重复解析。

// ------------------------------------------------------------------ HTML 处理
// 观测枢的正文是 HTML 片段（<p>/<span>/<img>/<hr>），字段里还夹着 base64 图片等噪声。
// 这里只做「够用」的还原：段落分隔、换行、去标签、解实体。不做完整 HTML 解析器。

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…', '&mdash;': '—', '&middot;': '·',
};

/** HTML 片段 → 纯文本。段落之间留空行，保证可读性。 */
export function stripHtml(html) {
  let s = String(html == null ? '' : html);
  if (!s) return '';
  // 图片一律丢弃（正文里的图对"读文字"没价值；需要图的字段单独取 data-image-url）
  s = s.replace(/<img\b[^>]*>/gi, '');
  // 块级标签 → 换行
  s = s.replace(/<\/p\s*>/gi, '\n');
  s = s.replace(/<p\b[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr\s*\/?>/gi, '\n');
  s = s.replace(/<\/(div|li|tr|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '· ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => (ENTITIES[m.toLowerCase()] != null ? ENTITIES[m.toLowerCase()] : m));
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

/** 从 HTML 片段里抓第一张图的地址。 */
function firstImage(html) {
  const m = String(html || '').match(/data-image-url="([^"]+)"/) || String(html || '').match(/<img[^>]+src="([^"]+)"/);
  return m ? m[1] : '';
}

/** 把「<hr> 分隔的多条」拆成数组。命之座整个表格塞在一个单元格里，靠这个拆。 */
function splitSections(html) {
  return String(html || '').split(/<hr\s*\/?>/).map((x) => x.trim()).filter(Boolean);
}

// ------------------------------------------------------------------ 各模块解析

/**
 * 天赋：7 条，前 3 条（普攻/战技/爆发）带 LV1~LV11 的**倍率表**，
 * 后 4 条是突破/固有天赋，只有描述。
 */
function parseTalents(raw) {
  const d = safeJson(raw);
  const list = (d && d.list) || [];
  const out = [];
  for (const it of list) {
    const attr = it.attr || {};
    const header = (attr.header || []).map((h) => stripHtml(h)).filter(Boolean);
    const rows = (attr.row || []).map((r) => (Array.isArray(r) ? r : [r]).map((c) => stripHtml(c)));
    // 只有「详细属性 + LV1..LVn」这种才是真倍率表；单列的是空壳，丢掉
    const hasTable = header.length > 2 && rows.some((r) => r.length > 2 && r.slice(1).some((c) => c));
    out.push({
      tab: stripHtml(it.tab_name),
      title: stripHtml(it.title),
      icon: it.icon || '',
      desc: stripHtml(it.desc),
      multipliers: hasTable ? { header, rows } : null,
    });
  }
  return out;
}

/**
 * 命之座：整个表格塞在一个单元格里，用 <hr> 分隔 6 条。
 * 每条形如「<p><span data-image-url="图">…</span>夜主的授记</p><p>描述…</p>」。
 */
function parseConstellations(raw) {
  const d = safeJson(raw);
  const cell = d && d.tables && d.tables[0] && d.tables[0].row && d.tables[0].row[0] && d.tables[0].row[0][0];
  if (!cell) return [];
  const out = [];
  for (const seg of splitSections(cell)) {
    const icon = firstImage(seg);
    const text = stripHtml(seg);
    if (!text) continue;
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) continue;
    // 第一行是「图标 + 名称」，后面的行是描述
    const name = lines[0];
    const desc = lines.slice(1).join('\n');
    out.push({ index: out.length + 1, name, icon, desc });
  }
  return out;
}

/**
 * 角色突破：10 段，每段是「20级突破」等 + 所需材料（含数量与图标）。
 * 「1级属性/突破所需材料」那段材料最多（含天赋书等），属性类段落另算。
 */
function parseAscensions(raw) {
  const d = safeJson(raw);
  const list = (d && d.list) || [];
  return list.map((it) => ({
    stage: stripHtml(it.tab_name),
    newTalent: stripHtml(it.new_talent_unlocked || ''),
    materials: (it.materials || []).map((m) => ({
      name: String(m.nickname || '').trim(),
      amount: Number(m.amount) || 0,
      icon: m.img || '',
    })).filter((m) => m.name),
    attrs: (it.attr && it.attr.row)
      ? (it.attr.row || []).map((r) => (Array.isArray(r) ? r : [r]).map((c) => stripHtml(c)))
      : [],
  }));
}

/** 攻略推荐：外链到米游社文章的配队/养成攻略。不是结构化数据，只能给链接。 */
function parseGuides(raw) {
  const d = safeJson(raw);
  const list = (d && d.list) || [];
  return list.map((it) => ({
    title: stripHtml(it.tab_name),
    cover: it.cover || '',
    link: it.link || '',
  })).filter((g) => g.title);
}

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// ------------------------------------------------------------------ 对外入口

const MODULE_PARSERS = {
  天赋: ['talents', parseTalents],
  命之座: ['constellations', parseConstellations],
  角色突破: ['ascensions', parseAscensions],
  攻略推荐: ['guides', parseGuides],
};

const cache = new Map();
const CACHE_MAX = 300;

/**
 * 解析一个观测枢条目的 raw_json，返回结构化模块。
 * @param {string|object} rawJson obc_entries.raw_json
 * @param {{id?:string|number}} [opts] id 只用于缓存键
 * @returns {{talents:Array, constellations:Array, ascensions:Array, guides:Array, modules:string[]}}
 */
export function parseEntryModules(rawJson, opts = {}) {
  const key = opts.id != null ? String(opts.id) : '';
  if (key && cache.has(key)) return cache.get(key);

  const out = { talents: [], constellations: [], ascensions: [], guides: [], modules: [] };
  const j = safeJson(rawJson);
  if (j && Array.isArray(j.modules)) {
    out.modules = j.modules.map((m) => m.name).filter(Boolean);
    for (const m of j.modules) {
      const p = MODULE_PARSERS[m.name];
      if (!p) continue;
      // 一个名字可能对应多个模块（「角色展示」就重复了 3 次），所以是累加不是覆盖
      const [field, fn] = p;
      try {
        const parsed = fn((m.components && m.components[0] && m.components[0].data) || '');
        if (Array.isArray(parsed) && parsed.length) out[field] = out[field].concat(parsed);
      } catch { /* 单个模块解析失败不影响别的 */ }
    }
  }

  if (key) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, out);
  }
  return out;
}

/** 角色的基础信息模块（等级属性等）。 */
export function parseBasic(rawJson) {
  const j = safeJson(rawJson);
  if (!j) return null;
  return { name: j.name || '', desc: j.desc || '', icon: j.icon_url || '', headerImg: j.header_img_url || '' };
}

/** 清缓存（测试用）。 */
export function clearModuleCache() {
  cache.clear();
}

// ------------------------------------------------------------------ 全文抽取
//
// 为什么需要这个：原来的采集脚本用「递归收集 page 里所有字符串」来建索引，
// 结果把 base64 图片数据、URL、JSON 键名全灌进了 FTS —— 真正的正文反而没进去。
// 实测：玛薇卡词条的索引里能找到「ro ol le ba as se」这种碎片，
// 但找不到「以火织命」「进行至多四段的连续挥砍」。
// 于是模型回答「知识库里没有天赋描述」，而块里明明就有 —— 自相矛盾。
//
// 这里改成**只走 modules 里的正文**，逐字段判断该不该收。

// 这些键的值不是给人读的，收了只会污染索引。
const SKIP_KEYS = new Set([
  'id', 'entry_id', 'menu_id', 'menu_name', 'template_id', 'template_layout', 'component_id',
  'icon', 'icon_url', 'header_img_url', 'img', 'image', 'cover', 'avatar_pc', 'avatar_m',
  'gold_img', 'common_img', 'long_img', 'card_img', 'life_bg', 'energy_bg', 'audio_url',
  'link', 'bbs_url', 'status', 'beta', 'lang', 'langs', 'version', 'page_type', 'menu_style',
  'layout', 'layout_', 'style', 'edit_lock_status', 'correct_lock_status', 'is_poped',
  'is_customize_name', 'is_abstract', 'is_new', 'is_delete', 'module_name', 'moduleName',
  'tab_id', 'ep_id', 'target_id', 'src_id', 'data-entry-id', 'data-entry-link', 'data-entry-status',
]);

const isNoise = (s) => {
  if (s.length < 2 || s.length > 4000) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^data:/i.test(s)) return true;
  // base64 / 哈希 / 纯符号数字：字母数字占比高且没有汉字
  if (!/[\u4e00-\u9fff]/.test(s) && /^[A-Za-z0-9+/=_\-\s]{16,}$/.test(s)) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  return false;
};

/**
 * 从一个观测枢词条里抽出**可检索的正文**。
 * 只走 modules（正文所在），跳过 menus / filter_values 这些导航元数据。
 *
 * @param {string|object} rawJson obc_entries.raw_json（可能是 {page:{modules}} 也可能是 {modules}）
 * @returns {string} 用换行连接的正文
 */
export function entryText(rawJson) {
  const j = safeJson(rawJson);
  if (!j) return '';
  const page = (j.page && Array.isArray(j.page.modules)) ? j.page : j;
  const modules = Array.isArray(page.modules) ? page.modules : [];
  const parts = [];
  const seen = new Set();

  const push = (s) => {
    const t = stripHtml(s).trim();
    if (!t || isNoise(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    parts.push(t);
  };

  const walk = (v, depth) => {
    if (v == null || depth > 14) return;
    if (typeof v === 'string') {
      // 字段值本身可能是 JSON（components[].data 就是），解开再走一层
      const trimmed = v.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
        const inner = safeJson(trimmed);
        if (inner) { walk(inner, depth + 1); return; }
      }
      push(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (SKIP_KEYS.has(k)) continue;
        walk(v[k], depth + 1);
      }
    }
  };

  for (const m of modules) {
    // 模块名本身也是可搜的（「命之座」「天赋」这种词用户会问）
    if (m.name) push(m.name);
    walk(m, 0);
  }
  return parts.join('\n');
}

// ------------------------------------------------------------------ 分节检索
//
// 光有整篇 entryText 不够：观测枢角色词条 2.6 万字，开头是基础信息与突破材料，
// 天赋在中段。检索时按固定窗口截前 160 字，天赋永远进不了上下文，
// 模型就回「知识库里没有天赋描述」—— 而词条里明明写着。
// 所以这里按**模块**切段，让调用方挑与问题相关的那一段。

/**
 * 把词条按模块切成 [{ name, text }]。
 * @returns {Array<{name:string, text:string}>}
 */
export function entrySections(rawJson) {
  const j = safeJson(rawJson);
  if (!j) return [];
  const page = (j.page && Array.isArray(j.page.modules)) ? j.page : j;
  const modules = Array.isArray(page.modules) ? page.modules : [];
  const out = [];
  for (const m of modules) {
    const seen = new Set();
    const parts = [];
    const push = (s) => {
      const t = stripHtml(s).trim();
      if (!t || isNoise(t) || seen.has(t)) return;
      seen.add(t); parts.push(t);
    };
    const walk = (v, depth) => {
      if (v == null || depth > 14) return;
      if (typeof v === 'string') {
        const tr = v.trim();
        if ((tr.startsWith('{') || tr.startsWith('[')) && tr.length > 2) {
          const inner = safeJson(tr);
          if (inner) { walk(inner, depth + 1); return; }
        }
        push(v); return;
      }
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v === 'object') {
        for (const k of Object.keys(v)) { if (!SKIP_KEYS.has(k)) walk(v[k], depth + 1); }
      }
    };
    walk(m, 0);
    // 同一模块名可能重复（「角色展示」出现 3 次），合并成一段，避免调用方挑花眼
    const text = parts.join('\n');
    if (text) out.push({ name: String(m.name || ''), text });
  }
  return out;
}

/** 模块名 → 该模块能回答的问题关键词。 */
const SECTION_HINTS = [
  { names: ['天赋', '天赋演示'], words: ['天赋', '技能', '倍率', '普攻', '战技', '爆发', '普攻伤害', '技能伤害'] },
  { names: ['命之座'], words: ['命座', '命之座', '几命', '满命', '一命', '二命', '六命'] },
  { names: ['角色突破'], words: ['突破', '材料', '培养', '升级', '进阶', '摩拉', '刷'] },
  { names: ['推荐装备'], words: ['武器', '圣遗物', '配装', '推荐', '套装', '词条'] },
  { names: ['角色详细', '更多描述', '基础信息'], words: ['是谁', '介绍', '背景', '身份', '所属', '地区', '生日', 'cv', '声优'] },
  { names: ['特殊料理'], words: ['料理', '食物', '食谱'] },
];

/**
 * 按问题挑出最相关的模块正文。
 * 挑不到相关模块时返回前若干段的拼接（保证不问具体东西时也有内容）。
 *
 * @param {string|object} rawJson
 * @param {string} question
 * @param {{maxLen?:number}} [opts]
 */
export function entryTextFor(rawJson, question, opts = {}) {
  const maxLen = opts.maxLen || 6000;
  const q = String(question || '').toLowerCase();
  const sections = entrySections(rawJson);
  if (!sections.length) return '';

  // 问题里出现了哪一类关键词，就优先给对应模块
  const wanted = new Set();
  for (const h of SECTION_HINTS) {
    if (h.words.some((w) => q.includes(w))) for (const n of h.names) wanted.add(n);
  }

  const picked = [];
  if (wanted.size) {
    for (const s of sections) if (wanted.has(s.name)) picked.push(s);
  }
  // 一个问题可能同时问好几样（「天赋和命座」），所以是累加不是二选一
  if (!picked.length) {
    // 没匹配到就按顺序给前几段（角色故事这类长文放后面）
    for (const s of sections.slice(0, 4)) picked.push(s);
  }

  let acc = '';
  for (const s of picked) {
    const piece = `【${s.name}】\n${s.text}`;
    if (acc.length + piece.length > maxLen) {
      acc += (acc ? '\n' : '') + piece.slice(0, Math.max(0, maxLen - acc.length));
      break;
    }
    acc += (acc ? '\n' : '') + piece;
  }
  return acc;
}

/** 中文二元组（和采集脚本 grams() 保持一致，保证索引可被同样方式查询）。 */
export function bigrams(text) {
  const out = [];
  const s = String(text || '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9 ]+/g, ' ');
  // 先按空格切，连续字母数字整块保留（否则 "lv1" 会被切碎）
  for (const tok of s.split(/\s+/)) {
    if (!tok) continue;
    if (/^[A-Za-z0-9]+$/.test(tok)) {
      if (tok.length >= 2 && tok.length <= 24) out.push(tok.toLowerCase());
      continue;
    }
    for (let i = 0; i < tok.length - 1; i++) {
      const g = tok.slice(i, i + 2);
      if (/[\u4e00-\u9fff]{2}/.test(g)) out.push(g);
    }
    // 单个汉字也留一份：查「岩」这种单字时二元组匹配不到
    if (tok.length === 1 && /[\u4e00-\u9fff]/.test(tok)) out.push(tok);
  }
  return [...new Set(out)];
}
