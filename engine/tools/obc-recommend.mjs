import path from 'node:path';
// 从观测枢数据里抽出「推荐关系」：
//   角色页的「武器推荐 / 圣遗物推荐」  -> 角色 → 武器/圣遗物
//   武器页的「推荐角色」、圣遗物页的「搭配推荐」 -> 武器/圣遗物 → 角色
//
//   node tools/obc-recommend.mjs
//
// 结果写进侧车库 obc_recommend 表，形成一张可双向查的推荐图。
// 推荐格里的实体用 data-entry-id 标注，正好是观测枢 id，可以直接关联。

import { DatabaseSync } from 'node:sqlite';

const WS = process.env.OBC_DB || path.join(process.env.KB_DATA_DIR || 'data', 'kb-workspace.sqlite');
const parseData = (d) => {
  if (typeof d !== 'string') return d;
  const s = d.trim();
  if (s.startsWith('{') || s.startsWith('[')) { try { return JSON.parse(s); } catch { /* HTML */ } }
  return d;
};
const stripTags = (h) => String(h == null ? '' : h)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|tr)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** 从一格 HTML 里取「被推荐的实体」 */
function entityOf(cell) {
  const s = String(cell || '');
  const id = (/data-entry-id="(\d+)"/.exec(s) || [])[1];
  let name = (/data-entry-name="([^"]*)"/.exec(s) || [])[1] || '';
  // 观测枢在这一格里直接给了配图（角色页是武器/圣遗物图标，武器页是角色头像）
  const img = (/data-entry-img="([^"]*)"/.exec(s) || [])[1] || '';
  if (!name) {
    // 退回读 <span class="name">…</span>
    const m = /<span class="name">([\s\S]*?)<\/span>/.exec(s);
    if (m) name = stripTags(m[1]);
  }
  return {
    id: id ? Number(id) : null,
    name: stripTags(name),
    img: img || '',
    // 去掉实体块后剩下的就是理由
    rest: stripTags(s.replace(/<span[^>]*custom-entry-wrapper[\s\S]*?<\/span>\s*<\/span>\s*<\/a>\s*<\/span>/, '')),
  };
}

const db = new DatabaseSync(WS);
db.exec(`
  CREATE TABLE IF NOT EXISTS obc_recommend (
    id          INTEGER PRIMARY KEY,
    src_id      INTEGER NOT NULL,
    src_kind    TEXT    NOT NULL,
    src_name    TEXT    NOT NULL,
    slot        TEXT    NOT NULL,
    target_id   INTEGER,
    target_kind TEXT,
    target_name TEXT    NOT NULL,
    target_img  TEXT,
    reason      TEXT,
    affix       TEXT,
    UNIQUE (src_id, slot, target_id, target_name)
  );
  CREATE INDEX IF NOT EXISTS idx_obcrec_src    ON obc_recommend(src_id, slot);
  CREATE INDEX IF NOT EXISTS idx_obcrec_target ON obc_recommend(target_id);
`);

// 老表可能没有 target_img 列，补上
try {
  const cols = db.prepare('PRAGMA table_info(obc_recommend)').all().map((c) => c.name);
  if (!cols.includes('target_img')) db.exec('ALTER TABLE obc_recommend ADD COLUMN target_img TEXT');
} catch { /* ignore */ }

// 名字 → kind 映射（补 target_kind）
const kindOf = new Map();
for (const r of db.prepare('SELECT id, kind FROM obc_entries').all()) kindOf.set(r.id, r.kind);

// Rebuild inside the transaction to preserve the previous snapshot on failure.
const ins = db.prepare(`INSERT OR IGNORE INTO obc_recommend
  (src_id, src_kind, src_name, slot, target_id, target_kind, target_name, target_img, reason, affix)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

let n = 0;
const bySlot = {};
const rows = db.prepare('SELECT id, name, kind, raw_json FROM obc_entries').all();
db.exec('BEGIN');
db.exec('DELETE FROM obc_recommend');
for (const r of rows) {
  let page;
  try { page = JSON.parse(r.raw_json); } catch { continue; }
  for (const m of (page.modules || [])) {
    const mod = m.name || '';
    for (const c of (m.components || [])) {
      const d = parseData(c.data);
      if (!d || typeof d !== 'object' || !d.tables) continue;
      for (const t of d.tables) {
        const tab = String(t.tab_name || '');
        const header = (t.header || []).map((h) => stripTags(h));
        // 只处理明确的推荐表：角色页的 武器/圣遗物推荐；武器/圣遗物页的 推荐角色/搭配推荐
        const isCharSide = /推荐$/.test(tab) && /武器|圣遗物/.test(tab);
        const isGearSide = /角色推荐|推荐角色|角色$/.test(tab) && /推荐角色|搭配推荐/.test(mod);
        if (!isCharSide && !isGearSide) continue;
        for (const row of (t.row || [])) {
          const cells = Array.isArray(row) ? row : [row];
          const ent = entityOf(cells[0]);
          if (!ent.name) continue;
          // 理由：优先取「推荐理由 / 推荐原因 / 描述」那一列
          let reason = '', affix = '';
          for (let i = 1; i < cells.length; i++) {
            const txt = stripTags(cells[i]);
            const h = header[i] || '';
            if (/词缀|搭配/.test(h)) affix = txt;
            else if (txt && !reason) reason = (h ? `${h}：` : '') + txt;
          }
          ins.run(r.id, r.kind, r.name, tab || mod, ent.id, ent.id ? (kindOf.get(ent.id) || null) : null,
            ent.name, ent.img || null, reason.slice(0, 1200), affix.slice(0, 400));
          n++;
          bySlot[tab || mod] = (bySlot[tab || mod] || 0) + 1;
        }
      }
    }
  }
}
db.exec('COMMIT');

console.log(`写入 obc_recommend：${n} 条`);
for (const [k, v] of Object.entries(bySlot).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);

console.log('\n=== 抽查 ===');
const g = (s, ...p) => db.prepare(s).all(...p);
console.log('胡桃被推荐的武器/圣遗物:');
for (const x of g("SELECT slot,target_name,target_kind FROM obc_recommend WHERE src_name='胡桃' ORDER BY slot LIMIT 8")) {
  console.log(`  [${x.slot}] ${x.target_name} (${x.target_kind || '?'})`);
}
console.log('\n推荐给胡桃用「护摩之杖」的角色:');
for (const x of g("SELECT src_name FROM obc_recommend WHERE target_name='胡桃' AND slot LIKE '%角色%' LIMIT 5")) {
  console.log(`  ${x.src_name}`);
}
console.log('\n反查：哪些角色推荐了 角斗士的终幕礼:');
for (const x of g("SELECT src_name,src_kind FROM obc_recommend WHERE target_name='角斗士的终幕礼' LIMIT 6")) {
  console.log(`  ${x.src_name} (${x.src_kind})`);
}
const tot = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT target_id) t FROM obc_recommend').get();
console.log(`\n合计 ${tot.n} 条，覆盖 ${tot.t} 个不同目标`);
db.close();
