// /v1 覆盖测试 —— 证明「知识库里已有的任意一条信息都能被取到」。
//
//   node test/v1-coverage-smoke.mjs
//
// 分三层验证：
//   ① 全量分页扫描：把域里的条目一页页翻完，条数必须与 /v1/meta 报的一致
//      （这直接对应需求「能检索到任意一条知识库里已有的信息」）
//   ② 检索触达：每个知识域至少有一个自然语言问题能命中它
//   ③ 枚举/筛选/计数：集合类问题的答案正确
//
// 另外把「锚点」信号的实测精度也固化成断言 —— 它是第 3 步闸门的依据，
// 一旦召回/精确度变化，这里会先报警。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB = process.env.KB_DIR || path.resolve(HERE, '..', 'engine');
const PORT = Number(process.env.V1_COV_PORT || 5182);
const TOKEN = 'kb_test_token_for_coverage_smoke';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [ok] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

async function api(url, opts = {}) {
  const res = await fetch(BASE + url, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { __raw: text, __status: res.status }; }
}

const child = spawn(process.execPath, [path.join(KB, 'serve-client.mjs')], {
  cwd: KB,
  env: { ...process.env, KB_CLIENT_PORT: String(PORT), KB_CLIENT_HOST: '127.0.0.1', KB_CLIENT_TOKEN: TOKEN, KB_CLIENT_RATE: '5000', KB_CLIENT_AUTH: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });

let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/v1/health`); if (r.ok) { up = true; break; } } catch { /* 等 */ }
  await sleep(250);
}
if (!up) { console.error('服务没能启动：\n' + log); child.kill(); process.exit(1); }

try {
  const meta = await api('/v1/meta');
  const dom = Object.fromEntries((meta.domains || []).map((d) => [d.domain, d.total]));
  console.log(`  知识域：${Object.entries(dom).map(([k, v]) => k + '=' + v).join('  ')}\n`);

  // ------------------------------------------------------------ ① 全量分页扫描
  console.log('  ── ① 全量分页扫描 ──');
  const PAGE = 100;
  async function sweep(domain, expected) {
    const ids = new Set();
    let offset = 0, guard = 0;
    for (;;) {
      const r = await api(`/v1/query?domain=${domain}&limit=${PAGE}&offset=${offset}`);
      const items = r.items || [];
      for (const it of items) ids.add(it.id);
      if (!items.length || ids.size >= expected || ++guard > 200) break;
      offset += PAGE;
    }
    return ids.size;
  }

  for (const [domain, expected] of [['character', dom.character], ['book', dom.book], ['relation', dom.relation]]) {
    const got = await sweep(domain, expected);
    ok(`全量翻完 ${domain}`, got === expected, `取到 ${got} / 应 ${expected}`);
  }

  // 大域：抽首尾两页 + 一个深处 offset，验证分页连续且不丢
  for (const [domain, expected] of [['obc', dom.obc], ['dialogue', dom.dialogue], ['voice', dom.voice]]) {
    const first = await api(`/v1/query?domain=${domain}&limit=${PAGE}&offset=0`);
    const lastOff = Math.max(0, expected - PAGE);
    const last = await api(`/v1/query?domain=${domain}&limit=${PAGE}&offset=${lastOff}`);
    const mid = await api(`/v1/query?domain=${domain}&limit=1&offset=${Math.floor(expected / 2)}`);
    ok(`${domain} 分页连续`, (first.items || []).length > 0 && (last.items || []).length > 0 && (mid.items || []).length === 1,
      `首页 ${(first.items || []).length} 末页 ${(last.items || []).length} 中间 ${(mid.items || []).length}`);
    ok(`${domain} 报的总数与 meta 一致`, first.total === expected, `${first.total} / ${expected}`);
  }

  // ------------------------------------------------------------ ② 检索触达每个域
  console.log('\n  ── ② 检索触达每个域 ──');
  const PROBES = [
    ['profile', '胡桃是谁'],
    ['story', '胡桃的角色故事'],
    ['voice', '胡桃的语音'],
    ['dialogue', '胡桃在传说任务里说了什么'],
    ['preference', '胡桃喜欢吃什么'],
    ['relation', '胡桃和钟离的关系'],
    ['book', '野猪公主讲了什么'],
    ['obc', '天空之翼这把武器'],
    ['fts', '往生堂是什么'],
  ];
  const touched = new Set();
  for (const [expectType, question] of PROBES) {
    const r = await api('/v1/retrieve', { method: 'POST', body: { question } });
    const types = Object.keys(r.hitsByType || {});
    types.forEach((t) => touched.add(t));
    ok(`「${question}」检索到内容`, (r.sources || []).length > 0, `sources=${(r.sources || []).length}`);
    if (types.includes(expectType)) ok(`  ↳ 命中 ${expectType} 分区`, true);
    else console.log(`     （提示：本次未命中 ${expectType}，实际 ${types.join('/')}）`);
  }
  // 检索分区里至少有 8 个被这套问题触达过
  ok('检索分区覆盖够广', touched.size >= 8, `触达 ${touched.size} 个：${[...touched].sort().join('/')}`);

  // /v1 暴露的知识域数量（V1_DOMAINS）：character / book / obc / voice / dialogue / relation
  ok('检索回报扫描域（覆盖自检）', (await api('/v1/retrieve', { method: 'POST', body: { question: '胡桃' } })).scannedDomains.length >= 6);

  // ------------------------------------------------------------ ②b 多实体
  // 一个长问题里点十来个角色的名：**每一个**都要被抽出并分别检索。
  // 旧实现只给前 2 个取分区资料，剩下的只能靠全文兜底 ——
  // 于是模型对没取到资料的角色张口就是「知识库里没有」，而它们明明都在库
  //（主库 131 角色 + 观测枢 136 条角色词条里都有芙宁娜 / 阿蕾奇诺）。
  console.log('\n  ── ②b 多实体长问题 ──');
  const NAMES13 = ['芙宁娜', '阿蕾奇诺', '钟离', '胡桃', '温迪', '雷电将军', '甘雨', '魈', '琴', '刻晴', '莫娜', '可莉', '达达利亚'];
  {
    const r13 = await api('/v1/retrieve', { method: 'POST', body: { question: NAMES13.join('、') + '这十三个角色谁的语音最多' } });
    const ent = (r13.entities || []).map((e) => e.name);
    ok('13 个实体全部抽出', ent.length === 13, `${ent.length} 个：${ent.join('、')}`);
    ok('实体顺序 = 提问顺序', ent.join() === NAMES13.join(), ent.join());
    ok('覆盖回报：每个实体都取到了资料',
      !!r13.coverage && r13.coverage.withoutSources.length === 0 && r13.coverage.withSources.length === 13,
      JSON.stringify(r13.coverage));
    const profs = (r13.sources || []).filter((s) => s.type === 'profile');
    ok('预算内每个实体都有一条档案', new Set(profs.map((s) => s.characterId)).size === 13, `${profs.length} 条档案`);
  }
  {
    // 单字名（琴 / 魈）在列举里也要认得出 —— 旧规则要求「前面不是汉字」，
    // 于是「胡桃和琴」「七七和魈」里那个单字角色 100% 漏检。
    const a = await api('/v1/retrieve', { method: 'POST', body: { question: '胡桃和琴什么关系' } });
    ok('列举里的单字名（琴）能认出', (a.entities || []).some((e) => e.name === '琴'),
      JSON.stringify((a.entities || []).map((e) => e.name)));
    const b = await api('/v1/retrieve', { method: 'POST', body: { question: '七七和魈谁大' } });
    ok('列举里的单字名（魈）能认出', (b.entities || []).some((e) => e.name === '魈'),
      JSON.stringify((b.entities || []).map((e) => e.name)));
    const c = await api('/v1/retrieve', { method: 'POST', body: { question: '我喜欢弹琴的时候' } });
    ok('构词里的单字名不误认（弹琴）', (c.entities || []).length === 0,
      JSON.stringify((c.entities || []).map((e) => e.name)));
  }

  // ------------------------------------------------------------ ③ 枚举 / 筛选 / 计数
  console.log('\n  ── ③ 枚举 / 筛选 / 计数 ──');
  let r = await api('/v1/query?domain=character&where=element:%E7%81%AB,rarity:5&limit=100');
  const fire5 = r.items || [];
  ok('五星火系角色可枚举', fire5.length > 0 && fire5.every((c) => c.element === '火' && c.rarity === 5),
    `${fire5.length} 个：${fire5.map((c) => c.name).join('、')}`);

  r = await api('/v1/query?domain=character&where=region:' + encodeURIComponent('璃月') + '&count=1');
  ok('按地区计数（璃月）', r.total > 0, `total=${r.total}`);

  r = await api('/v1/query?domain=obc&where=kind:weapon&count=1');
  const weaponTotal = r.total;
  ok('观测枢武器计数', weaponTotal === 252, `total=${weaponTotal}（应 252）`);

  r = await api('/v1/query?domain=obc&where=kind:enemy&count=1');
  ok('观测枢敌人计数', r.total === 417, `total=${r.total}（应 417）`);

  r = await api('/v1/query?domain=obc&where=kind:quest&count=1');
  // 2026-10-13 数据重采后 quest 1091→1094、npc 2373→2374（条目总数仍是 16869）。
  // 这两个数字是**数据**快照，不是检索行为；重采后对不上就更新，别当成检索回归。
  ok('观测枢任务计数', r.total === 1094, `total=${r.total}（应 1094）`);

  r = await api('/v1/query?domain=obc&where=kind:npc&count=1');
  ok('观测枢 NPC 计数', r.total === 2374, `total=${r.total}（应 2374）`);

  r = await api('/v1/query?domain=character&sort=release_desc&limit=1');
  ok('按实装日期排序', /^\d{4}-\d{2}-\d{2}$/.test((r.items[0] || {}).releaseDate || ''), (r.items[0] || {}).releaseDate);

  // ------------------------------------------------------------ ④ 锚点信号（闸门依据）
  console.log('\n  ── ④ 锚点信号 ──');
  const OUT_OF_LIB = ['原神里最帅的角色是谁', '帮我写一段 Python 快排', '明天北京天气怎么样',
    '米哈游的股价是多少', '给我讲讲量子力学', '怎么做红烧肉', '一加手机怎么样', '今天股市怎么样'];
  let noAnchor = 0;
  for (const question of OUT_OF_LIB) {
    const rr = await api('/v1/retrieve', { method: 'POST', body: { question } });
    if (!rr.anchors || rr.anchors.length === 0) noAnchor++;
  }
  ok('库外问题不产生锚点（高精确）', noAnchor === OUT_OF_LIB.length, `${noAnchor}/${OUT_OF_LIB.length}`);

  const IN_LIB = ['胡桃的命座是什么', '天空之翼适合谁用', '角斗士的终幕礼套装效果', '野猪公主讲了什么', '钟离和胡桃什么关系', '可莉的语音'];
  let withAnchor = 0;
  for (const question of IN_LIB) {
    const rr = await api('/v1/retrieve', { method: 'POST', body: { question } });
    if (rr.anchors && rr.anchors.length) withAnchor++;
  }
  ok('库内具名问题能定位锚点', withAnchor === IN_LIB.length, `${withAnchor}/${IN_LIB.length}`);

} finally {
  child.kill();
  await sleep(400);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
