#!/usr/bin/env node
// 只读查询 CLI：《日月全事》故事线（侧车库 kb-workspace.sqlite）
// 供 agent 随时调用，与 query.mjs 同一套中文二元组分词（lib/tokenize.mjs）。
//
//   node story.mjs stats
//   node story.mjs search 尼伯龙根 [--limit 8] [--row teyvat] [--era e0]
//   node story.mjs act 5 [--full]
//   node story.mjs timeline [--era e3] [--row teyvat] [--limit 20]
//   node story.mjs chains [三月]
//   node story.mjs character 戴因斯雷布
//   node story.mjs sql "SELECT * FROM story_timeline LIMIT 3"
//
// 注意：这是侧车库（可写库），不是主库；主库请用 query.mjs。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { queryExpr, snippet } from './lib/tokenize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let db;
try { db = new DatabaseSync(path.join(process.env.KB_DATA_DIR || path.join(HERE, 'data'), 'kb-workspace.sqlite'), { readOnly: true }); }
catch { console.error('未配置剧情线考据资料，请设置 KB_DATA_DIR 并自行导入已获许可的资料。'); process.exit(2); }

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);
const clean = (txt) => String(txt || '').replace(/\u0001/g, '[').replace(/\u0002/g, ']');

function print(v) {
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

function search(q, { limit = 10, row, era } = {}) {
  const expr = queryExpr(q);
  let rows = [];
  let mode = 'fts';
  if (expr) {
    const p = [expr];
    let sql = `SELECT f.act_id, bm25(story_fts) AS score
               FROM story_fts f WHERE f.tokens MATCH ?`;
    if (row) { sql += ' AND f.row_id = ?'; p.push(row); }
    if (era) { sql += ' AND f.era_id = ?'; p.push(era); }
    sql += ' ORDER BY score LIMIT ?';
    p.push(limit);
    rows = db.prepare(sql).all(...p);
  }
  if (!rows.length) {
    mode = 'like';
    const p = [`%${q}%`];
    let sql = `SELECT a.id AS act_id, 0 AS score FROM story_acts a WHERE (a.title LIKE ? OR a.full LIKE ?)`;
    p.push(`%${q}%`);
    if (row) { sql += ' AND a.row_id = ?'; p.push(row); }
    if (era) { sql += ' AND a.era_id = ?'; p.push(era); }
    sql += ' ORDER BY a.id LIMIT ?';
    p.push(limit);
    rows = db.prepare(sql).all(...p);
  }
  const detail = rows.map((r) => {
    const row2 = db.prepare(`SELECT a.id, a.title, a.page_label, a.is_key, a.is_anchor, a.source, a.full,
                                    r.name AS row_name, e.name AS era_name
                             FROM story_acts a
                             LEFT JOIN story_rows r ON r.id = a.row_id
                             LEFT JOIN story_eras e ON e.id = a.era_id
                             WHERE a.id = ?`).get(r.act_id);
    return {
      actId: row2.id,
      era: row2.era_name,
      row: row2.row_name,
      title: row2.title,
      pages: row2.page_label,
      key: !!row2.is_key,
      anchor: !!row2.is_anchor,
      score: Math.round((r.score || 0) * 100) / 100,
      hits: (String(row2.full || '').match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length,
      snippet: clean(snippet(row2.full || row2.title, q).snippet),
      source: row2.source,
    };
  });
  return { query: q, mode, count: detail.length, results: detail };
}

let out;
switch (cmd) {
  case 'stats': {
    const meta = db.prepare("SELECT value FROM kv WHERE key='story.timeline.meta'").get();
    out = {
      source: meta ? JSON.parse(meta.value) : null,
      counts: {
        eras: db.prepare('SELECT COUNT(*) n FROM story_eras').get().n,
        rows: db.prepare('SELECT COUNT(*) n FROM story_rows').get().n,
        acts: db.prepare('SELECT COUNT(*) n FROM story_acts').get().n,
        chains: db.prepare('SELECT COUNT(*) n FROM story_chains').get().n,
        chainNodes: db.prepare('SELECT COUNT(*) n FROM story_chain_nodes').get().n,
        fullChars: db.prepare('SELECT SUM(chars) s FROM story_acts').get().s,
      },
      eras: db.prepare('SELECT id,name,time,pages FROM story_eras ORDER BY id').all(),
      rows: db.prepare('SELECT id,name,sub,chapter FROM story_rows ORDER BY id').all(),
      license: db.prepare("SELECT value FROM kv WHERE key='story.timeline.license'").get()?.value,
      page: db.prepare("SELECT value FROM kv WHERE key='story.timeline.page'").get()?.value,
    };
    break;
  }
  case 'search':
    out = search(argv[1] || '', { limit: Number(opt('limit', 10)), row: opt('row'), era: opt('era') });
    break;
  case 'act': {
    const row = db.prepare(`SELECT a.*, r.name AS row_name, r.chapter, e.name AS era_name, e.time AS era_time, e.desc AS era_desc
                            FROM story_acts a
                            LEFT JOIN story_rows r ON r.id = a.row_id
                            LEFT JOIN story_eras e ON e.id = a.era_id
                            WHERE a.id = ?`).get(Number(argv[1]));
    if (!row) { out = { error: 'not found' }; break; }
    const nodes = db.prepare(`SELECT c.name AS chain, n.text, n.page FROM story_chain_nodes n
                              JOIN story_chains c ON c.id = n.chain_id
                              WHERE n.era_id = ? ORDER BY c.id, n.ord`).all(row.era_id);
    out = {
      id: row.id, title: row.title, era: row.era_name, eraTime: row.era_time, row: row.row_name,
      chapter: row.chapter, pages: row.page_label, key: !!row.is_key, anchor: !!row.is_anchor,
      chars: row.chars, source: row.source, chainNodesInEra: nodes,
      excerpt: row.excerpt,
      ...(has('full') ? { full: row.full } : { full: String(row.full || '').slice(0, 400) + (row.chars > 400 ? ' …（加 --full 看全文）' : '') }),
    };
    break;
  }
  case 'timeline': {
    const p = [];
    let sql = `SELECT act_id, era_name, row_name, title, page_label, is_key, is_anchor FROM story_timeline`;
    const where = [];
    if (opt('era')) { where.push('era_name = (SELECT name FROM story_eras WHERE id = ?)'); p.push(opt('era')); }
    if (opt('row')) { where.push('row_sub IS NOT NULL AND row_name = (SELECT name FROM story_rows WHERE id = ?)'); p.push(opt('row')); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY act_id LIMIT ?';
    p.push(Number(opt('limit', 20)));
    out = db.prepare(sql).all(...p);
    break;
  }
  case 'chains': {
    const like = `%${argv[1] || ''}%`;
    out = db.prepare('SELECT id,name,color,note FROM story_chains WHERE name LIKE ? ORDER BY id').all(like)
      .map((c) => ({ ...c, nodes: db.prepare('SELECT ord,era_id,text,page FROM story_chain_nodes WHERE chain_id=? ORDER BY ord').all(c.id) }));
    break;
  }
  case 'character': {
    const name = argv[1] || '';
    const acts = db.prepare(`SELECT a.id, a.title, a.page_label, r.name AS row_name, e.name AS era_name,
                                    (LENGTH(a.full) - LENGTH(REPLACE(a.full, ?, ''))) / LENGTH(?) AS hits
                             FROM story_acts a
                             LEFT JOIN story_rows r ON r.id = a.row_id
                             LEFT JOIN story_eras e ON e.id = a.era_id
                             WHERE a.full LIKE ?
                             ORDER BY hits DESC, a.id`).all(name, name, `%${name}%`);
    out = { character: name, actCount: acts.length, totalHits: acts.reduce((s, a) => s + a.hits, 0), acts };
    break;
  }
  case 'page': {
    out = {
      page: db.prepare("SELECT value FROM kv WHERE key='story.timeline.page'").get()?.value,
      license: db.prepare("SELECT value FROM kv WHERE key='story.timeline.license'").get()?.value,
      source: db.prepare("SELECT value FROM kv WHERE key='story.timeline.source'").get()?.value,
      counts: db.prepare("SELECT value FROM kv WHERE key='story.timeline.counts'").get()?.value,
    };
    break;
  }
  case 'sql': {
    const q = argv.slice(1).join(' ');
    if (!/^\s*(select|with|pragma|explain)\s/i.test(q)) { out = { error: 'only SELECT allowed' }; break; }
    out = db.prepare(q).all();
    break;
  }
  default:
    out = {
      usage: [
        'stats',
        'search <q> [--limit n] [--row teyvat] [--era e0]',
        'act <id> [--full]',
        'timeline [--era e3] [--row teyvat] [--limit 20]',
        'chains [三月]',
        'character <name>',
        'page',
        'sql "<SELECT ...>"',
      ],
      note: '侧车库数据源：诗漱《日月全事》第3.1版·苍星圣敕·至冬史略一；引用请署名，不得商业售卖。'
        + ' 对外发布 AI 结论须注明「学习素材包括《日月全事》」与「AI 结论仅作参考，不代表《日月全事》观点」。',
    };
}
print(out);
