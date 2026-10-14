// 从观测枢条目的 raw_json 里抽出**条目之间的引用关系**，建 obc_refs 表。
//
//   node tools/obc-refs.mjs           抽取 + 建表
//   node tools/obc-refs.mjs --stats   只看统计
//
// 为什么需要这张表：
//   观测枢的模块正文里到处是这种引用 ——
//     <span class="custom-entry-wrapper" data-entry-id="54"
//           data-entry-name="迪卢克" data-entry-link="/ys/obc/content/54/detail">
//   任务条目的「起始NPC」字段，值就是这种引用。
//   问题：字段名是官方写死的「起始NPC」，但**被引用的可能是实机角色**
//   （迪卢克 / 琴 / 温迪），页面上就显示成「起始NPC 迪卢克」—— 不对。
//
//   有了这张表，页面就能查引用的目标是什么类型，把「起始NPC」改成「起始角色」。
//
// 顺带的价值：
//   · 变更日志可以用它判断「改了这条会影响哪些条目」
//   · 页面的交叉跳转不用再靠正则在 HTML 里抠 id
//
// 不重新导入：直接读已有的 raw_json，几秒钟的事（重导要十几分钟）。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.OBC_DB || path.join(process.env.KB_DATA_DIR || 'data', 'kb-workspace.sqlite');
const WEB = path.join(process.env.KB_DATA_DIR || 'data', 'derived');
const statsOnly = process.argv.includes('--stats');

const db = new DatabaseSync(DB);

// ── 建表 ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS obc_refs (
    id          INTEGER PRIMARY KEY,
    src_id      INTEGER NOT NULL,   -- 引用方（观测枢条目 id）
    field       TEXT    NOT NULL,   -- 出现在哪个字段名下（如「起始NPC」）
    target_id   INTEGER,            -- 被引用的条目 id；空表示官方就没给 id
    target_name TEXT    NOT NULL,
    target_kind TEXT,               -- 被引用条目的 kind（从 obc_entries 反查）
    ord         INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_obcrefs_src    ON obc_refs(src_id);
  CREATE INDEX IF NOT EXISTS idx_obcrefs_target ON obc_refs(target_id);
`);

if (statsOnly) {
  const n = db.prepare('SELECT COUNT(*) c FROM obc_refs').get().c;
  console.log(`  obc_refs ${n} 行`);
  for (const r of db.prepare('SELECT field, COUNT(*) n FROM obc_refs GROUP BY field ORDER BY n DESC LIMIT 15').all()) {
    console.log(`    ${String(r.field).padEnd(20)} ${r.n}`);
  }
  db.close();
  process.exit(0);
}

// ── 抽取 ────────────────────────────────────────────────────────
// 一次读完所有 raw_json（16869 条，约 326 MB）—— 比逐条 SQL 往返快得多。
console.log('  读取条目…');
const rows = db.prepare('SELECT id, raw_json FROM obc_entries').all();
console.log(`  ${rows.length} 条`);

/** 从任意字符串里抠出 data-entry-* 引用 */
function refsIn(text, field, out, ordRef) {
  if (typeof text !== 'string' || text.indexOf('data-entry-name') < 0) return;
  // ⚠ 不能写 text.split(/<span ...>/)，那样会把**标签本身**删掉 ——
  //   而 data-entry-id / data-entry-name 恰恰是标签上的属性。
  //   （第一版就是这么写的，扫了 16869 条得到 0 条引用。）
  //   要遍历标签本身。
  const tagRe = /<span[^>]*data-entry-name="[^"]*"[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(text))) {
    const tag = m[0];
    const idM = /data-entry-id="(\d*)"/.exec(tag);
    const nmM = /data-entry-name="([^"]*)"/.exec(tag);
    if (!nmM || !nmM[1]) continue;
    out.push({
      field,
      target_id: idM && idM[1] ? Number(idM[1]) : null,
      target_name: nmM[1],
      ord: ordRef.n++,
    });
  }
}

// ── 反查 kind ───────────────────────────────────────────────────
const kindOf = new Map();
for (const r of db.prepare('SELECT id, kind FROM obc_entries').all()) kindOf.set(Number(r.id), r.kind);

const ins = db.prepare(`INSERT INTO obc_refs (src_id, field, target_id, target_name, target_kind, ord)
  VALUES (?,?,?,?,?,?)`);
db.exec('BEGIN');
db.exec('DELETE FROM obc_refs');
let n = 0;

console.log('  扫描 raw_json…');
const found = [];
let scanned = 0;
for (const r of rows) {
  let j;
  try { j = JSON.parse(r.raw_json); } catch { continue; }
  scanned++;
  const ordRef = { n: 0 };
  for (const m of (j.modules || [])) {
    const modName = String(m.name || '');
    for (const c of (m.components || [])) {
      // component.data 常常是**字符串化的 JSON**，里面才是 list
      let d = c.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* 保持原样 */ } }
      if (d && typeof d === 'object') {
        for (const item of (d.list || [])) {
          if (!item || typeof item !== 'object') continue;
          // key 是字段名；value 是数组（可能含多个引用）
          const field = String(item.key || modName || '').trim() || modName;
          const vals = Array.isArray(item.value) ? item.value : [item.value];
          for (const v of vals) refsIn(v, field, found, ordRef);
        }
      }
      // 有些组件直接把 HTML 放在别的字段里
      for (const k of ['value', 'text', 'content']) {
        if (typeof c[k] === 'string') refsIn(c[k], modName, found, ordRef);
      }
    }
  }
  // 立刻绑定 src_id —— 一次扫完就写，不用为了补 src_id 再扫一遍
  for (const x of found.splice(0)) {
    ins.run(Number(r.id), x.field, x.target_id, x.target_name,
      x.target_id != null ? (kindOf.get(x.target_id) || null) : null, x.ord);
    n++;
  }
  if (scanned % 4000 === 0) console.log(`    已扫 ${scanned}…`);
}
db.exec('COMMIT');
console.log(`  扫到并写入 ${n} 条引用（来自 ${scanned} 条条目）`);

// ── 导出角色 id 清单给页面用 ────────────────────────────────────
// 页面只需要回答「这个 id 是不是实机角色」，所以给一个纯数组就够（几 KB）。
const charIds = db.prepare("SELECT id FROM obc_entries WHERE kind='character' ORDER BY id").all().map((r) => Number(r.id));
fs.mkdirSync(WEB, { recursive: true });
fs.writeFileSync(path.join(WEB, 'obc-chars.json'), JSON.stringify(charIds), 'utf8');
console.log(`  角色 id 清单 → web/obc-chars.json（${charIds.length} 个，${Math.round(JSON.stringify(charIds).length / 1024)} KB）`);

// ── 报告 ────────────────────────────────────────────────────────
console.log('\n  obc_refs 统计：');
for (const r of db.prepare('SELECT field, COUNT(*) n, SUM(CASE WHEN target_kind=? THEN 1 ELSE 0 END) chars FROM obc_refs GROUP BY field ORDER BY n DESC LIMIT 12').all('character')) {
  console.log(`    ${String(r.field).padEnd(22)} ${String(r.n).padStart(7)} 条   其中指向角色 ${r.chars}`);
}
console.log('\n  被引用最多的目标：');
for (const r of db.prepare('SELECT target_name, target_kind, COUNT(*) n FROM obc_refs WHERE target_id IS NOT NULL GROUP BY target_id ORDER BY n DESC LIMIT 8').all()) {
  console.log(`    ${String(r.target_name).padEnd(16)} ${String(r.target_kind || '?').padEnd(12)} ${r.n} 次`);
}
console.log('\n  「起始NPC / 结束NPC」里其实指向角色的：');
for (const r of db.prepare("SELECT field, target_name, target_kind FROM obc_refs WHERE field LIKE '%NPC%' AND target_kind='character' LIMIT 10").all()) {
  console.log(`    ${String(r.field).padEnd(12)} ${r.target_name}`);
}
const cnt = db.prepare("SELECT COUNT(*) c FROM obc_refs WHERE field LIKE '%NPC%' AND target_kind='character'").get().c;
const all = db.prepare("SELECT COUNT(*) c FROM obc_refs WHERE field LIKE '%NPC%'").get().c;
console.log(`    合计 ${cnt} / ${all} 条 NPC 字段其实指向实机角色`);
db.close();
