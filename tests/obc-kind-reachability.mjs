// 观测枢分类可达性：**库里每一个分类都必须有路径进得了检索候选**。
//
// 为什么要有这条：2026-10-14 实测发现 10 个分类（adventure/org/theater/offering/
// index/template/observer-guide/guide/wiki-guide/map-preview，合计 428 条）既不在
// 默认白名单、又没有任何触发词 —— 数据在库里，任何问法都取不到。
// 用户的原话是「搜索引擎需要全量覆盖知识库全部的内容不能有遗漏或者不看」。
//
// 这里不造问句采样（采样证明不了没有遗漏），而是**按规则证明**：
// 库里每个 kind 都必须落在下面三者之一 ——
//   ① OBC_ONLY_KINDS      默认就搜
//   ② OBC_OVERLAP_KINDS   明确需要时搜
//   ③ 某个 OBC_DOMAIN_TRIGGERS 的 kinds 里   命中触发词时搜
// 落在三者之外 = 结构上永远搜不到 = 遗漏。
//
// 运行：node test/obc-kind-reachability.mjs
//   KB_DIR 可覆盖知识库目录（默认仓库 engine）

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';

const KB = process.env.KB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine');
const DB = path.join(process.env.KB_DATA_DIR || path.join(KB, 'data'), 'kb-workspace.sqlite');

const {
  OBC_KIND_DEFS, OBC_ONLY_KINDS, OBC_OVERLAP_KINDS, OBC_DOMAIN_TRIGGERS,
  OBC_KIND_LABEL, validateObcKindTable,
} = await import(pathToFileURL(path.join(KB, 'lib', 'obc-kinds.mjs')).href);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- 库里的真实分类
if (!fs.existsSync(DB)) {
  console.error(`找不到侧车库：${DB}（用 KB_DIR 指定知识库目录）`);
  process.exit(2);
}
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM obc_entries GROUP BY kind ORDER BY n DESC').all();
db.close();

const dbKinds = rows.map((r) => r.kind);
const countOf = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
console.log(`库内分类 ${dbKinds.length} 个，条目 ${rows.reduce((a, r) => a + r.n, 0)} 条\n`);

// ---------------------------------------------------------------- ① 表自身自检
console.log('── ① 分类表自检 ──');
const problems = validateObcKindTable(dbKinds);
check('validateObcKindTable 无问题', problems.length === 0, problems.join('；') || '0 problem');

// ---------------------------------------------------------------- ② 每个库内分类都有中文标签
console.log('\n── ② 中文标签 ──');
const unlabeled = dbKinds.filter((k) => !OBC_KIND_LABEL[k]);
check('库内每个分类都登记了中文标签', unlabeled.length === 0, unlabeled.join('、') || `${dbKinds.length} 个全有`);

// ---------------------------------------------------------------- ③ 结构性可达（核心）
console.log('\n── ③ 结构性可达 ──');
const reachable = new Set([
  ...OBC_ONLY_KINDS,
  ...OBC_OVERLAP_KINDS,
  ...OBC_DOMAIN_TRIGGERS.flatMap((t) => t.kinds),
]);
const orphans = dbKinds.filter((k) => !reachable.has(k));
const orphanRows = orphans.reduce((a, k) => a + (countOf[k] || 0), 0);
check(
  '没有「结构上搜不到」的分类',
  orphans.length === 0,
  orphans.length
    ? `${orphans.length} 个：${orphans.map((k) => `${k}(${countOf[k]})`).join('、')}，共 ${orphanRows} 条`
    : `${dbKinds.length} 个分类全部可达`
);

// ---------------------------------------------------------------- ④ 反向：表里没有库里不存在的分类
console.log('\n── ④ 表与库一致 ──');
const inTable = new Set(OBC_KIND_DEFS.map((d) => d.kind));
const missing = [...inTable].filter((k) => !dbKinds.includes(k));
// 这不是错误：有的 menu 还没采到数据（menu_id=0 的 furnishing 等）。
// 但要把它们列出来，免得有人以为"登记了就等于库里有"。
console.log(`   （登记了但库里暂无数据的分类 ${missing.length} 个：${missing.join('、') || '无'}）`);

// ---------------------------------------------------------------- ⑤ 触发词抽样可命中
console.log('\n── ⑤ 触发词抽样 ──');
const samples = [
  ['钟离的角色PV有哪些？', 'char-video'],
  ['有哪些成就可以拿？', 'achievement'],
  ['七圣召唤的行动牌有哪些？', 'tcg-action'],
  ['尘歌壶怎么摆设？', 'teapot'],
  ['冒险家协会在哪？', 'adventure'],
  ['幻想真境剧诗怎么玩？', 'theater'],
  ['忍冬之树供奉奖励', 'offering'],
  ['观测枢攻略怎么看？', 'observer-guide'],
  ['空月之歌是什么？', 'map-preview'],
];
function pickKinds(q, base) {
  const out = [...base];
  const seen = new Set(out);
  for (const t of OBC_DOMAIN_TRIGGERS) {
    if (!t.re.test(q)) continue;
    for (const k of t.kinds) if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}
let hit = 0;
for (const [q, want] of samples) {
  const got = pickKinds(q, OBC_ONLY_KINDS);
  if (got.includes(want)) hit += 1;
  else console.log(`   ✗ 「${q}」没放开 ${want}`);
}
check('触发词抽样全部命中', hit === samples.length, `${hit}/${samples.length}`);

// ---------------------------------------------------------------- 结果
const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
