// 观测枢官方数据（obc_*）的检索层。
//
// 为什么单独一层：obc_* 在**侧车库**，主库 search_fts 里没有它，
// 结构化分区（角色档案/故事/语音）和全文兜底都碰不到。
//
// 观测枢这边**武器 / 圣遗物 / 材料 / 食物 / 敌人这几类是主库完全没有的**，
// 所以只要问到了就该给 —— 不给，AI 只能回答「知识库里没有」。
//
// 检索策略（两层，缺一不可）：
//   ① 名称直配 —— 只扫轻量名称，问句命中后按上限读取对应正文。
//      只有这层才扛得住「天空之翼这把武器怎么样」这种自然语句：
//      FTS 那边 queryExpr 会把整句当一个短语，长问句必然 0 命中。
//   ② FTS 回退 —— 名称没配上的，走二元组 FTS，按「严格 → 去虚词 → 宽松」逐级降级，
//      取最命中的那个（和 retrieve.mjs 的 ftsSources 同一套做法）。

import { queryExpr, queryExprLoose, stripStopwords, snippet } from './tokenize.mjs';
import { obcText } from './obc.mjs';
// 分类白名单、中文标签与「按需放开」的触发词都来自 lib/obc-kinds.mjs（唯一事实来源）。
// 这里只负责检索算法，不再自己维护一份 kind 清单 —— 原先这里和 blocks.mjs、
// retrieve.mjs 各有一份，补采后 menu 涨到 53 个，漏同步就是整域搜不到。
import {
  OBC_ONLY_KINDS, OBC_OVERLAP_KINDS, OBC_DOMAIN_TRIGGERS, pickObcKinds, obcLabel,
} from './obc-kinds.mjs';
// 下游（chat/retrieve.mjs 等）历史上是 import 这里的名字，继续转出，避免一次性改太多调用方。
export { OBC_ONLY_KINDS, OBC_OVERLAP_KINDS, OBC_DOMAIN_TRIGGERS, pickObcKinds };
// entryText 会解开 components[].data 的内层 JSON —— obcText 不会，这正是
// 「观测枢资料喂给模型只有 JSON 碎片」那个 bug 的修法。
import { entryText, entryTextFor } from './obc-modules.mjs';
void obcText;


export function hasObc(db) {
  try {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='obc_entries'").get();
    if (!r) return false;
    return db.prepare('SELECT COUNT(*) AS n FROM obc_entries').get().n > 0;
  } catch { return false; }
}

const COLS = 'e.id, e.name, e.kind, e.menu_label, e.text_len, e.raw_json';

function kindClause(kinds, alias = 'e') {
  const list = (kinds || []).filter(Boolean);
  return list.length ? { sql: ` AND ${alias}.kind IN (${list.map(() => '?').join(',')})`, params: list } : { sql: '', params: [] };
}

/** ① 名称直配：问句里出现了哪条的名字 */
function byName(db, question, limit, kinds, opts = {}) {
  const q = String(question || '');
  if (!q) return [];
  const k = kindClause(kinds);
  let rows = [];
  try {
    // 名称直配只会命中「问句里出现过的名字」，所以该名字的**首字必然出现在问句里**。
    // 用这一点把候选从全表 16870 行收窄到几十行。不收窄的话每次提问都要全表扫描
    // 再在 JS 里过滤（实测 ~50 ms 稳态 / ~2 s 冷启动），而真正命中的通常只有 1~2 条。
    // 注意 substr 对 TEXT 是按**字符**取，不是字节，中文首字可以安全用于比较。
    const firstChars = [...new Set(Array.from(q))];
    if (!firstChars.length) return [];
    const ph = firstChars.map(() => '?').join(',');
    rows = db.prepare(
      `SELECT e.id, e.name FROM obc_entries e WHERE 1=1${k.sql} AND substr(e.name,1,1) IN (${ph})`,
    ).all(...k.params, ...firstChars);
  } catch { return []; }
  // 默认只认长度 ≥2 的名字：单字名（琴、魈…）在中文里到处都是
  // （「风琴」「弹琴」「琴声」），放进来会到处误命中。
  // 但观测枢里确实有 6 条单字名条目、主库有 2 个单字名角色 ——
  // 那些场合由调用方用 allowShort 显式打开，并要求问句**以该名字开头**
  // 或紧跟着「的/是/在/有」，「琴是谁」「琴的语音」这种才放行。
  const minLen = opts.allowShort ? 1 : 2;
  const hits = rows.filter((r) => {
    if (!r.name || r.name.length < minLen) return false;
    if (r.name.length >= 2) return q.includes(r.name);
    // 单字名：必须出现在开头，或者后面紧跟一个常见助词
    if (q.startsWith(r.name)) return true;
    return new RegExp(`(^|[^\\u4e00-\\u9fff])${r.name}(的|是|在|有|语音|故事|怎么)`).test(q);
  });
  // 排序：**精确同名优先**，其次名字长的优先。
  // 只按长度排的话，搜「钟离」会把「钟离【洞天】」顶到「钟离」前面。
  // 另外：名字正好等于问句（去掉问号/语气词）的排最前 ——
  // 「木盾丘丘人」这种「问句就是条目名」是意图最明确的情形。
  const bare = q.replace(/[?？。！!，,、\s]|怎么打|是什么|怎么样|介绍|一下/g, '');
  hits.sort((a, b) => {
    const ra = a.name === q || a.name === bare ? 0 : 1;
    const rb = b.name === q || b.name === bare ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return b.name.length - a.name.length;
  });
  const entry = db.prepare(`SELECT ${COLS} FROM obc_entries e WHERE e.id = ?`);
  return hits.slice(0, limit).map(hit => entry.get(hit.id)).filter(Boolean);
}

/**
 * 只做「名称直配」的对外入口（不走 FTS）。
 * retrieve.mjs 用它把「问句里点名的观测枢词条」**排到资料最前面** ——
 * assembleContext 是按顺序吃预算的，排在最后等于永远轮不到。
 */
export function searchObcByName(db, question, limit = 4, kinds = [], opts = {}) {
  return byName(db, question, limit, kinds, opts);
}

/** ② FTS 回退：多候选表达式，取最命中的那个 */
function byFts(db, question, limit, kinds) {
  const cands = [];
  const add = (e) => { if (e && !cands.includes(e)) cands.push(e); };
  add(queryExpr(question));
  const stripped = stripStopwords(question);
  const hasStrip = stripped && stripped !== String(question).trim();
  if (hasStrip) add(queryExpr(stripped));
  if (hasStrip) add(queryExprLoose(stripped));
  add(queryExprLoose(question));
  if (!cands.length) return [];

  const k = kindClause(kinds);
  let best = [];
  const goal = Math.min(limit, 3);
  // 同上（见 chat/retrieve.mjs 的 ftsSources）：达标即停，不被更宽的一档用条数顶掉。
  for (const expr of cands) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT ${COLS}, bm25(obc_fts, 20.0, 1.0) AS score
           FROM obc_fts f JOIN obc_entries e ON e.id = f.entry_id
          WHERE obc_fts MATCH ?${k.sql}
          ORDER BY score LIMIT ?`,
      ).all(expr, ...k.params, limit);
    } catch { rows = []; }
    if (rows.length >= goal) { best = rows; break; }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

export function searchObc(db, question, limit = 5, opts = {}) {
  if (!db) return [];
  const n = Math.max(1, Math.min(Number(limit) || 5, 20));
  const kinds = opts.kinds || [];
  const out = [];
  const seen = new Set();

  // ⚠ 名称直配层**不限分类**（kinds=null => kindClause 不加过滤）。
  //
  //   为什么：这一层是"问句里出现了哪条的名字就直接给那条"，精度天然很高
  //   （要求 ≥2 字的名字精确出现，且不在词内误命中），所以它不吃预算、
  //   也不会像 FTS 那样被长问句拖垮。
  //
  //   而分类白名单是**跟预算挂钩**的：gated 分类默认不搜。结果是
  //   「忍冬之树供奉奖励」这种问法，即使用户一字不差地打出了条目名，
  //   只要那个分类没被触发词放开，条目就进不了候选 —— 明明库里就有。
  //   名称层扫全分类正好补掉这个洞：用户点名要的东西，任何分类都能命中。
  //
  //   FTS 回退层仍然按白名单走（那一层靠词面撞，放开全库会稀释候选池）。
  for (const r of [...byName(db, question, n, null), ...byFts(db, question, n, kinds)]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ ...r, snippet: obcSnippet(r.raw_json, question) });
    if (out.length >= n) break;
  }
  return out;
}

/**
 * 命中片段：从 raw_json 现算（入库时没存正文，避免二次膨胀）。
 *
 * 【为什么用 entryText 而不是 obcText】
 *   obcText 走 modules 时**不解析内层 JSON 字符串** —— 观测枢的 components[].data
 *   本身就是一段 JSON 文本，于是整个 data 被当成一个字符串原样推了进来。
 *   结果摘出来的片段长这样：
 *     `基础信息 role_base_info {"moduleName":"基础信息","layout_":"banner","name":"玛薇卡",...`
 *   全是 JSON 语法，**正文一个字都没有**。实测 154 字里没有一个汉字是有意义的。
 *   于是模型回答「知识库里没有关于玛薇卡天赋的描述」，而词条里明明就写着。
 *
 *   entryText（lib/obc-modules.mjs）会解开内层 JSON、剥掉 HTML、丢掉 base64 与 URL，
 *   只留可读正文。它对每个模块生效，所以天赋描述 / 命座描述 / 材料名都能进片段。
 */
function obcSnippet(rawJson, q) {
  try {
    const page = JSON.parse(rawJson);
    // 按模块挑相关正文：观测枢角色词条 2.6 万字，天赋在中段，
    // 固定窗口截前 160 字永远截不到天赋 —— 那正是「模型说没有天赋描述」的原因。
    const picked = entryTextFor(page, q, { maxLen: 6000 });
    if (picked) return picked;
    // 退化：某些词条没有 modules（老数据），退回整篇开头一段
    return entryText(page).slice(0, 400);
  } catch {
    return '';
  }
}

/** 转成 retrieve.mjs 的 source 形状 */
export function obcSourceOf(hit) {
  const label = obcLabel(hit.kind);
  const text = hit.snippet || '';
  return {
    type: 'obc',
    title: `${hit.name}（观测枢 · ${label}）`,
    heading: label,
    text: text || `${hit.name}（${label}）`,
    url: `/obc.html#e${hit.id}`,
    obcId: hit.id,
    obcKind: hit.kind,
  };
}
