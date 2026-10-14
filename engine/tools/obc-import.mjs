// 把观测枢采集到的合法数据导入知识库侧车库。
//
//   node tools/obc-import.mjs
//
// 写入自行配置的 KB_DATA_DIR 中的侧车库。
// 建 obc_entries（结构化）+ obc_fts（中文二元组全文索引）。
//
// 分词与知识库一致：中文切重叠二元组，英文/数字按词切。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// 复用知识库自己的分词器，保证索引侧与查询侧完全一致
import { indexTokens, queryExpr } from '../lib/tokenize.mjs';

const SRC = (process.env.OBC_SRC || path.join(process.env.AKASHA_ROOT || process.cwd(), 'data-src', 'hoyowiki'));
const DB = path.join(process.env.KB_DATA_DIR || 'data', 'kb-workspace.sqlite');
const LICENSE = '数据来源：米游社观测枢（baike.mihoyo.com，米哈游自营）· 仅本地检索使用';

// menu_id → kind。
// 这张表原先是手写的，只覆盖 7 个 menu（NPC/任务/敌人/武器/角色/书籍/圣遗物）。
// 2026-10-13 补采之后库里变成 16869 条 / 53 个 menu，其余 46 个全落成了 `menu<N>`，
// 检索结果里就出现「天空之翼(menu234)」这种没法看的标签。
// 现在这份映射**只有一处**：kb-viz/lib/obc-kinds.mjs（检索侧的白名单、中文标签、
// 触发词都从那张表派生）。这里 import 而不是抄一份 —— 抄一份的下场就是
// 这里补了 kind、检索侧还以为是 `menu<N>`。
import { OBC_MENU_TO_KIND as KIND } from '../lib/obc-kinds.mjs';

// ── 文本处理 ────────────────────────────────────────────────────
const stripHtml = (h) => String(h)
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/** 中文重叠二元组 + 英文词 —— 直接委托给知识库的分词器，保持一致 */
const grams = (s) => [...new Set(indexTokens(String(s)).split(' ').filter(Boolean))];

/** 从条目 JSON 里抽出所有可读文本 */
function extractText(page) {
  const parts = [];
  const walk = (v, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') {
      const s = stripHtml(v);
      if (s && !/^https?:\/\//.test(s) && s.length > 1) parts.push(s);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'img' || k === 'image' || k === 'icon' || k === 'icon_url' || k === 'cover'
          || k === 'avatar_pc' || k === 'avatar_m' || k === 'gold_img' || k === 'common_img'
          || k === 'long_img' || k === 'card_img' || k === 'life_bg' || k === 'energy_bg'
          || k === 'audio_url' || k === 'link' || k === 'bbs_url') continue;
        walk(val, depth + 1);
      }
    }
  };
  walk(page?.modules);
  return [...new Set(parts)].join('\n').slice(0, 60000);
}

// ── 建表 ────────────────────────────────────────────────────────
const db = new DatabaseSync(DB);
db.exec(`
  CREATE TABLE IF NOT EXISTS obc_entries (
    id            INTEGER PRIMARY KEY,
    menu_id       INTEGER NOT NULL,
    menu_label    TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    license       TEXT    NOT NULL,
    module_count  INTEGER,
    text_len      INTEGER,
    updated_at    TEXT,
    raw_json      TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS obc_entries_menu ON obc_entries(menu_id);
  CREATE INDEX IF NOT EXISTS obc_entries_kind ON obc_entries(kind);

  CREATE VIRTUAL TABLE IF NOT EXISTS obc_fts USING fts5(
    name, grams, kind UNINDEXED, entry_id UNINDEXED, tokenize='unicode61'
  );
`);

// ── 导入 ────────────────────────────────────────────────────────
const ins = db.prepare(`INSERT INTO obc_entries
  (id, menu_id, menu_label, kind, name, license, module_count, text_len, updated_at, raw_json)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, module_count=excluded.module_count,
    text_len=excluded.text_len, updated_at=excluded.updated_at, raw_json=excluded.raw_json`);
const delFts = db.prepare('DELETE FROM obc_fts WHERE entry_id = ?');
const insFts = db.prepare('INSERT INTO obc_fts (name, grams, kind, entry_id) VALUES (?,?,?,?)');

let n = 0;
const stats = {};
const bad = [];
db.exec('BEGIN');
for (const menuDir of fs.readdirSync(SRC)) {
  const dir = path.join(SRC, menuDir);
  if (!fs.statSync(dir).isDirectory()) continue;
  const menuId = Number(menuDir);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    // ⚠ 单个文件坏掉不能让整批崩。
    //   实测踩过：机器中途重启，正在写的 json 变成一坨空格，
    //   JSON.parse 直接抛，整个导入白跑（16869 条里坏了 63 个）。
    //   这里跳过并记账，末尾汇总 —— 坏的重新抓一遍就能补上。
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      bad.push(`${menuDir}/${f}: ${e.message.slice(0, 60)}`);
      continue;
    }
    const page = j.page;
    if (!page) { bad.push(`${menuDir}/${f}: 缺 page 字段`); continue; }
    const id = Number(page.entry_page_id || f.replace('.json', ''));
    const label = j.menu_label || String(menuId);
    const kind = KIND[menuId] || `menu${menuId}`;
    const text = extractText(page);
    // ⚠ 这里以前写的是 page.updated_at —— 接口**根本没这个字段**，
    //   它叫 page.version（Unix 秒）。所以 obc_entries.updated_at 一直是空的，
    //   "某条词条什么时候变的"也就无从判断。
    //   见 kb-viz/tools/obc-api-notes.md。
    const versionTs = Number(page.version) || 0;
    const updatedAt = versionTs ? new Date(versionTs * 1000).toISOString() : '';
    ins.run(id, menuId, label, kind, page.name || '', LICENSE,
      (page.modules || []).length, text.length, updatedAt, JSON.stringify(page));
    delFts.run(id);
    insFts.run(page.name || '', grams(`${page.name || ''}\n${text}`).join(' '), kind, id);
    stats[kind] = (stats[kind] || 0) + 1;
    n++;
  }
}
db.exec('COMMIT');

console.log(`导入 ${n} 条`);
for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);
if (bad.length) {
  console.log(`\n⚠ 跳过 ${bad.length} 个坏文件（重新采集即可补上）：`);
  for (const b of bad.slice(0, 10)) console.log('  ' + b);
  if (bad.length > 10) console.log(`  …还有 ${bad.length - 10} 个`);
}
const c = db.prepare('SELECT COUNT(*) n FROM obc_entries').get();
const c2 = db.prepare('SELECT COUNT(*) n FROM obc_fts').get();
console.log(`\n表内: obc_entries ${c.n} 行 / obc_fts ${c2.n} 行`);

// 自测检索（复用知识库的 queryExpr + bm25 名称加权）
console.log('\n=== 检索自测（queryExpr + bm25 名称权重 20:1）===');
for (const q of ['天空之翼', '胡桃', '野猪公主', '角斗士的终幕礼']) {
  const expr = queryExpr(q);
  let rows = [];
  try {
    rows = db.prepare(`SELECT name, kind FROM obc_fts
      WHERE obc_fts MATCH ? ORDER BY bm25(obc_fts, 20.0, 1.0) LIMIT 3`).all(expr);
  } catch { /* ignore */ }
  console.log(`  [${q}] → ${rows.map((r) => `${r.name}(${r.kind})`).join(' | ') || '无'}`);
}
db.close();
