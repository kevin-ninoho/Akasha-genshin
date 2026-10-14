// 侧车库《日月全事》故事线的检索适配。
//
// 背景：主库的 search_fts 里只有官方内容（角色故事/语音/台词/书籍）。《日月全事》
// （诗漱 · 683 页考据同人）是后来由 story.mjs 编译进**侧车库** kb-workspace.sqlite
// 的 story_* 表的，所以主库全文检索、以及 AI 的检索增强都看不到它 —— 表现为
// 明明收录了，问「旧世记忆体」却回答"知识库里没有这条信息"。
//
// 这个模块是两处共用的查询适配：server.mjs 的 /api/search 与 chat/retrieve.mjs。
// 只读、只 SELECT；表还没建时安静返回空数组，不影响任何既有功能。

import { queryExpr, queryExprLoose } from './tokenize.mjs';

/** story_fts 正文里的 \u0001/\u0002 是高亮标记，还原成 [ ]（与 story.mjs 的 clean 一致）。 */
export function cleanStoryText(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\u0001/g, '[')
    .replace(/\u0002/g, ']')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 侧车库是否已经有故事线数据。 */
export function hasStory(db) {
  if (!db) return false;
  try {
    return !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name='story_acts'")
      .get();
  } catch {
    return false;
  }
}

/** 取正文窗口：优先围绕命中词，否则取开头。 */
export function storyWindow(text, needle, max = 600) {
  const s = cleanStoryText(text);
  if (needle) {
    const at = s.indexOf(needle);
    if (at > 0) {
      const from = Math.max(0, at - 160);
      const end = from + max;
      return (from > 0 ? '…' : '') + s.slice(from, end) + (end < s.length ? '…' : '');
    }
  }
  return s.slice(0, max) + (s.length > max ? '…' : '');
}

/**
 * 按关键词检索《日月全事》故事线。
 *
 * @param db 侧车库只读连接
 * @param query 主查询（/api/search 传裸词；AI 检索层传整句问话）
 * @param terms 额外候选词。整句问话直接丢给 FTS 会切出「是什/什么」这类
 *              虚词做成 AND 从而匹配不上，所以 AI 那侧会把拆出的关键词一并传进来，
 *              依次重试直到凑够 limit。
 * @returns {Array<{actId,title,era,eraTime,rowLine,pages,key,anchor,text,snippet,score}>}
 */
export function searchStory(db, query, limit = 8, terms = []) {
  const q = String(query === null || query === undefined ? '' : query).trim();
  if (!q || !hasStory(db)) return [];

  const tries = [q];
  for (const t of terms || []) {
    const s = String(t === null || t === undefined ? '' : t).trim();
    if (s.length >= 2 && !tries.includes(s)) tries.push(s);
  }

  const picked = [];
  const seen = new Set();
  const room = () => limit - picked.length;
  const addRows = (list, term) => {
    for (const r of list || []) {
      if (picked.length >= limit * 3) return;
      if (r && r.act_id != null && !seen.has(r.act_id)) {
        seen.add(r.act_id);
        picked.push({ act_id: r.act_id, score: r.score, term });
      }
    }
  };

  for (const t of tries) {
    if (room() <= 0) break;

    // ① FTS5 精确表达式（中文二元组做 AND）。
    //    多字词常整词不成词（书里写「坎瑞亚的五罪人」，`亚五` 这个二元组不存在），
    //    所以下面还要走 ② 宽松表达式。
    const exprs = [];
    try { const e = queryExpr(t); if (e) exprs.push(e); } catch { /* ignore */ }
    try { const e = queryExprLoose(t); if (e && !exprs.includes(e)) exprs.push(e); } catch { /* ignore */ }
    for (const expr of exprs) {
      if (room() <= 0) break;
      try {
        addRows(db.prepare(
          'SELECT f.act_id, bm25(story_fts) AS score FROM story_fts f WHERE f.tokens MATCH ? ORDER BY score LIMIT ?'
        ).all(expr, Math.max(limit * 3, 24)), t);
      } catch { /* ignore */ }
    }

    // ② LIKE 兜底（短词/单字时 FTS 可能全空）
    if (room() > 0) {
      try {
        addRows(db.prepare(
          'SELECT id AS act_id, 0 AS score FROM story_acts WHERE title LIKE ? OR full LIKE ? ORDER BY id LIMIT ?'
        ).all(`%${t}%`, `%${t}%`, Math.max(limit * 3, 24)), t);
      } catch { /* ignore */ }
    }
  }
  if (!picked.length) return [];

  let stmt = null;
  try {
    stmt = db.prepare(`
      SELECT a.id, a.title, a.page_label, a.is_key, a.is_anchor, a.full,
             r.name AS row_name, e.name AS era_name, e.time AS era_time
      FROM story_acts a
      LEFT JOIN story_rows r ON r.id = a.row_id
      LEFT JOIN story_eras e ON e.id = a.era_id
      WHERE a.id = ?`);
  } catch { return []; }

  const out = [];
  for (const r of picked) {
    if (out.length >= limit) break;
    let a = null;
    try { a = stmt.get(r.act_id); } catch { a = null; }
    if (!a) continue;
    // 注：这里刻意不再做「原文必须字面包含该词」的校验。书里常写成
    // 「坎瑞亚的五罪人」，字面校验会把真命中误杀；噪音由调用方按问题类型
    // 门控（见 chat/retrieve.mjs 的 storylineSources 调用处）。
    const text = storyWindow(a.full, r.term);
    out.push({
      actId: a.id,
      title: a.title,
      era: a.era_name || '',
      eraTime: a.era_time || '',
      rowLine: a.row_name || '',
      pages: a.page_label || '',
      key: !!a.is_key,
      anchor: !!a.is_anchor,
      snippet: text,
      text,
      score: typeof r.score === 'number' ? Math.round(r.score * 100) / 100 : 0,
    });
  }
  return out;
}

/** 故事线命中 → 统一的「引用来源」结构（AI 检索层用）。 */
export function storySourceOf(hit, clipLen = 500) {
  return {
    type: 'storyline',
    title: `《日月全事》· ${hit.era ? hit.era + ' · ' : ''}${hit.title}`,
    actId: hit.actId,
    era: hit.era,
    pages: hit.pages,
    text: String(hit.text || '').slice(0, clipLen),
    url: 'timeline.html',
  };
}
