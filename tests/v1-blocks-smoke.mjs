// 结构化答案块测试 —— 意图路由、六种块的构造、以及端到端事件流。
//
//   node test/v1-blocks-smoke.mjs
//
// 分三段：
//   A. 纯函数：意图路由 + 过滤条件抽取（不碰数据库）
//   B. 块构造：直接开库调 buildBlocks，逐个块验证**形状**（不依赖服务、不依赖模型）
//   C. 端到端：起一个 serve-client 实例，断言 SSE 里真的发了 blocks 事件，
//      且块内容与问题对得上。
//
// 为什么形状要单独测：块是给客户端渲染的契约，
// 字段名/嵌套层级一变，渲染器就白屏 —— 这类回归必须在下游之前挡住。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB = process.env.KB_DIR || path.resolve(HERE, '..', 'engine');
const DATA = process.env.KB_DATA_DIR || (process.env.KB_DATA_DIR || path.join(KB,'data'));
const PORT = Number(process.env.V1_BLOCKS_PORT || 5184);
const TOKEN = 'kb_test_token_for_blocks_smoke';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { routeIntents, extractCharacterFilter, extractObcKind, buildBlocks, summarizeBlocks, blockHintForPrompt, BLOCK_KINDS } =
  await import(pathToFileURL(path.join(KB, 'lib', 'blocks.mjs')).href);
const { openV1 } = await import(pathToFileURL(path.join(KB, 'lib', 'v1-data.mjs')).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [ok] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

// ================================================================ A. 意图路由
console.log('  ── A. 意图路由（纯函数） ──');

const ROUTE_CASES = [
  ['胡桃的立绘', 'art'],
  ['胡桃长什么样', 'art'],
  ['给我看看胡桃的头像', 'art'],
  ['胡桃的语音', 'voice'],
  ['胡桃说过什么', 'voice'],
  ['胡桃和钟离什么关系', 'relation'],
  ['胡桃认识谁', 'relation'],
  // 养成域：从具体到笼统，顺序不能乱 —— 「圣遗物推荐」必须命中 artifact 而不是 build
  ['胡桃用什么武器', 'weapon'],
  ['适合胡桃的武器', 'weapon'],
  ['胡桃的圣遗物', 'artifact'],
  ['给我推荐适合玛薇卡穿戴的圣遗物', 'artifact'],
  ['胡桃的配装推荐', 'build'],
  ['胡桃的命座', 'constellation'],
  ['胡桃几命了', 'constellation'],
  ['胡桃的天赋', 'talent'],
  ['胡桃的元素战技倍率', 'talent'],
  ['胡桃的突破材料', 'ascension'],
  ['胡桃的培养材料', 'ascension'],
  ['璃月有哪些角色', 'list'],
  ['一共有多少角色', 'list'],
];
for (const [q, want] of ROUTE_CASES) {
  const r = routeIntents(q);
  ok(`「${q}」→ ${want}`, r.intents.includes(want), `实际=${r.intents.join(',') || '(无)'}`);
}

// timeline 意图已随《日月全事》故事线移除：任何问法都不该再命中它。
for (const q of ['历史', '胡桃的历史', '钟离的历史', '这个角色的历史', '胡桃的历史背景',
                 '故事的历史脉络', '蒙德的历史', '故事线的时间顺序', '编年史']) {
  const r = routeIntents(q);
  ok(`「${q}」不命中 timeline（该意图已移除）`, !r.intents.includes('timeline'), r.intents.join(',') || '(无)');
}

// 一条问题命中多个意图：两个都要在，且 art 优先于 voice（声明序即优先级）
{
  const r = routeIntents('胡桃的立绘和语音都给我看看');
  ok('多意图都能命中', r.intents.includes('art') && r.intents.includes('voice'), r.intents.join(','));
  ok('art 优先于 voice', r.intents.indexOf('art') < r.intents.indexOf('voice'), r.intents.join(','));
}
// 不相关的问题不该瞎路由
for (const q of ['红烧肉怎么做', '今天天气怎么样', '帮我写一首诗']) {
  const r = routeIntents(q);
  ok(`「${q}」不命中任何意图`, r.intents.length === 0, r.intents.join(',') || '(无)');
}
ok('matched 记录命中原词', routeIntents('胡桃的立绘').matched.art === '立绘',
  JSON.stringify(routeIntents('胡桃的立绘').matched));

// ================================================================ B. 过滤条件
console.log('\n  ── B. 过滤条件抽取（纯函数） ──');

ok('抽出地区', extractCharacterFilter('璃月有哪些角色').includes('region:璃月'),
  JSON.stringify(extractCharacterFilter('璃月有哪些角色')));
ok('抽出元素', extractCharacterFilter('火元素角色有哪些').includes('element:火'),
  JSON.stringify(extractCharacterFilter('火元素角色有哪些')));
ok('抽出星级', extractCharacterFilter('五星角色').includes('rarity:5'),
  JSON.stringify(extractCharacterFilter('五星角色')));
ok('多条件并存', extractCharacterFilter('璃月的五星火系角色').length >= 3,
  JSON.stringify(extractCharacterFilter('璃月的五星火系角色')));
ok('无过滤条件返回空', extractCharacterFilter('有哪些角色').length === 0,
  JSON.stringify(extractCharacterFilter('有哪些角色')));
ok('观测枢 kind=敌人', extractObcKind('有哪些敌人') === 'enemy', extractObcKind('有哪些敌人'));
ok('观测枢 kind=武器', extractObcKind('有哪些武器') === 'weapon', extractObcKind('有哪些武器'));
ok('抽不到 kind 返回空串', extractObcKind('红烧肉怎么做') === '', JSON.stringify(extractObcKind('红烧肉怎么做')));

// ================================================================ C. 块构造
console.log('\n  ── C. 六种块的构造（直接开库） ──');

const v1 = openV1(DATA);
const build = (q) => buildBlocks({ v1, question: q, anchors: v1.findAnchors(q), entities: [] });
const kindsOf = (bs) => bs.map((b) => b.kind);
const one = (q, kind) => build(q).find((b) => b.kind === kind);

ok('BLOCK_KINDS 覆盖全部九种', BLOCK_KINDS.length === 9 && BLOCK_KINDS.includes('video-scenes'), BLOCK_KINDS.join(','));

// ① image
{
  const b = one('胡桃的立绘', 'image');
  ok('image 块能造出来', !!b, b && b.title);
  ok('image 带 items 且每项有 url/size/label',
    !!b && b.items.length > 0 && b.items.every((i) => i.url && i.size && i.label),
    b && JSON.stringify(b.items.map((i) => i.label)));
  ok('image 的 url 是相对路径（客户端自拼服务器前缀）',
    !!b && b.items.every((i) => i.url.startsWith('/v1/asset/')), b && b.items[0].url);
  ok('image 指向的是胡桃本人',
    !!b && b.items.every((i) => i.url.includes('/character/')), b && b.items[0].url);
}

// ② voice-list
{
  const b = one('胡桃的语音', 'voice-list');
  ok('voice-list 能造出来', !!b, b && b.title);
  ok('voice-list 是分组的（不是塌成一组的原始 grp）',
    !!b && b.groupCount >= 2, b && `组数=${b.groupCount}`);
  ok('voice-list 每组有 name/count/lines',
    !!b && b.groups.every((g) => g.name && typeof g.count === 'number' && Array.isArray(g.lines)),
    b && b.groups.map((g) => `${g.name}(${g.count})`).join(' '));
  ok('voice-list 有条数上限（不把 59 条全塞进去）',
    !!b && b.groups.every((g) => g.lines.length <= 8), b && `组数=${b.groups.length}`);
}

// ③ relation-graph
{
  const b = one('胡桃和钟离什么关系', 'relation-graph');
  ok('relation-graph 能造出来', !!b, b && b.title);
  ok('relation-graph 有 nodes 和 edges',
    !!b && Array.isArray(b.nodes) && Array.isArray(b.edges) && b.nodes.length && b.edges.length,
    b && `${b.nodes.length}节点/${b.edges.length}边`);
  ok('relation-graph 的第一个节点是自己（self=true）',
    !!b && b.nodes[0].self === true, b && b.nodes[0].name);
  ok('relation-graph 每条边都带 quote 作为依据',
    !!b && b.edges.every((e) => typeof e.quote === 'string'), b && b.edges.length + ' 条');
  ok('relation-graph 的边两端都在 nodes 里',
    !!b && b.edges.every((e) => b.nodes.some((n) => n.id === e.from) && b.nodes.some((n) => n.id === e.to)));
  ok('relation-graph 区分「库内角色」与「概念」（可跳转性）',
    !!b && b.nodes.every((n) => typeof n.kind === 'string'), b && JSON.stringify(b.nodes.map((n) => n.kind).slice(0, 5)));
}

// ④ stat-table
{
  // 表格首格是 { text, icon } 对象（带了条目缩略图），取文字要用这个
  const cellText = (c) => (c && typeof c === 'object' ? c.text : c);

  const b = one('胡桃用什么武器', 'stat-table');
  ok('stat-table 能造出来', !!b, b && b.title);
  // 「用什么武器」是**指定了具体方面**，这时不带档案 ——
  // 档案（生日/CV/所属）不属于这个问题。用户明确要求「问什么给什么，不多不少」。
  ok('stat-table 指定方面时不带档案（不多给）', !!b && b.profile.length === 0, b && `${b.profile.length} 项`);
  // 反过来说，笼统的「配装」仍然带档案 —— 那时角色概览本身就是上下文
  {
    const g = one('胡桃的配装推荐', 'stat-table');
    ok('stat-table 笼统问配装时仍带档案', !!g && g.profile.length >= 5, g && `${g.profile.length} 项`);
  }
  ok('stat-table 有配装推荐表（武器/圣遗物）',
    !!b && b.tables.length >= 1, b && b.tables.map((t) => t.slot).join(','));
  ok('stat-table 的表有 columns + rows',
    !!b && b.tables.every((t) => Array.isArray(t.columns) && Array.isArray(t.rows) && t.rows.length),
    b && b.tables.map((t) => `${t.slot}:${t.rows.length}行`).join(' '));
  ok('stat-table 取到的是胡桃的推荐，不是别人的',
    !!b && b.tables.some((t) => t.rows.some((r) => /护摩之杖|赤沙之杖|和璞鸢/.test(cellText(r[0])))),
    b && b.tables[0] && b.tables[0].rows.slice(0, 3).map((r) => cellText(r[0])).join(','));
  // 用户要的是「武器信息 + **武器图片**」，只给一串名字不够
  ok('stat-table 每行带条目缩略图',
    !!b && b.tables.every((t) => t.rows.every((r) => r[0] && typeof r[0] === 'object' && /^\/v1\/asset\/obc\/\d+$/.test(r[0].icon || ''))),
    b && b.tables[0] && b.tables[0].rows.slice(0, 3).map((r) => r[0].icon).join(','));
}

// ⑤ list
{
  const b = one('璃月有哪些角色', 'list');
  ok('list（角色）能造出来', !!b, b && b.title);
  ok('list 带 total 与 columns/rows',
    !!b && typeof b.total === 'number' && b.columns.length && b.rows.length, b && `${b.total} 条`);
  ok('list 的行宽与列数一致',
    !!b && b.rows.every((r) => r.length === b.columns.length), b && `列=${b.columns.length}`);
  ok('list 的过滤真的生效（只出璃月角色）',
    !!b && b.rows.every((r) => r.includes('璃月')), b && b.rows.slice(0, 3).map((r) => r[0]).join(','));

  const o = one('有哪些敌人', 'list');
  ok('list（观测枢图鉴）能造出来', !!o, o && o.title);
  ok('list 的观测枢标题带类别名与总数',
    !!o && /敌人/.test(o.title) && /417/.test(o.title), o && o.title);
}

// ⑥ timeline 已随《日月全事》故事线一并移除 —— 这里断言它不再产出块
{
  const b = one('故事线的时间顺序', 'timeline');
  ok('timeline 块已移除（不再返回任何块）', !b, b && b.title);
}

// ⑦ talent（天赋 + 倍率表）
{
  const b = one('玛薇卡的天赋', 'talent');
  ok('talent 能造出来', !!b, b && b.title);
  ok('talent 有多个天赋条目', !!b && b.total >= 3, b && `${b.total} 个`);
  ok('talent 的条目有 tab/title/desc',
    !!b && b.items.every((t) => t.tab && t.title && typeof t.desc === 'string'),
    b && b.items.slice(0, 3).map((t) => t.title).join('/'));
  ok('talent 至少有一个带倍率表（这是主库完全没有的数据）',
    !!b && b.withMultipliers >= 1, b && `${b.withMultipliers} 个带倍率`);
  {
    const w = b && b.items.find((t) => t.multipliers);
    ok('倍率表有 header + rows，且行宽与表头一致',
      !!w && w.multipliers.header.length > 2 && w.multipliers.rows.length > 0
        && w.multipliers.rows.every((r) => r.length === w.multipliers.header.length),
      w && `${w.multipliers.header.length} 列 x ${w.multipliers.rows.length} 行`);
    ok('倍率表表头是「详细属性 + LV1..LVn」',
      !!w && /详细属性/.test(w.multipliers.header[0]) && /LV1/.test(w.multipliers.header[1]),
      w && JSON.stringify(w.multipliers.header.slice(0, 3)));
    ok('倍率表首列是属性名、后面是百分比数值',
      !!w && /[\u4e00-\u9fff]/.test(w.multipliers.rows[0][0]) && /%/.test(w.multipliers.rows[0][1] || ''),
      w && JSON.stringify(w.multipliers.rows[0].slice(0, 3)));
  }
}

// ⑧ constellation（命之座）
{
  const b = one('玛薇卡的命座', 'constellation');
  ok('constellation 能造出来', !!b, b && b.title);
  ok('constellation 有条目且带序号',
    !!b && b.items.length > 0 && b.items.every((c) => c.index >= 1 && c.name),
    b && `${b.items.length} 个: ${b.items.slice(0, 3).map((c) => c.name).join('/')}`);
  ok('命座条目带描述与图标',
    !!b && b.items.every((c) => typeof c.desc === 'string' && typeof c.icon === 'string'),
    b && b.items[0].desc.slice(0, 40));
  // 观测枢对 81/136 个角色只填了 1 个命座，块必须**如实标注**而不是假装完整
  {
    const h = one('胡桃的命座', 'constellation');
    ok('命座不全时带 incomplete 标记与说明',
      !!h && h.incomplete === true && /观测枢/.test(h.note || ''),
      h && `total=${h.total} incomplete=${h.incomplete}`);
    ok('命座完整时不标 incomplete',
      !!b && b.total === 6 && b.incomplete === false, b && `total=${b.total}`);
  }
}

// ⑨ ascension（培养材料）
{
  const b = one('玛薇卡的突破材料', 'ascension');
  ok('ascension 能造出来', !!b, b && b.title);
  ok('ascension 按突破阶段分组', !!b && b.items.length >= 4, b && b.items.map((s) => s.stage).join(','));
  ok('每阶段材料有 name/amount/icon',
    !!b && b.items.every((s) => s.materials.length > 0
      && s.materials.every((m) => m.name && m.amount > 0 && typeof m.icon === 'string')),
    b && b.items[1].materials.map((m) => `${m.name}×${m.amount}`).join(' '));
  ok('材料名是具体物品（不是数字或空串）',
    !!b && b.items.every((s) => s.materials.every((m) => /[\u4e00-\u9fff]/.test(m.name))),
    b && b.items[0].materials.slice(0, 3).map((m) => m.name).join(','));
}

// ================================================================ D. 边界与负例
console.log('\n  ── D. 边界与负例 ──');

// 用户实测报过的 bug：问圣遗物，结果武器也端出来了
{
  const bs = build('给我推荐适合玛薇卡穿戴的圣遗物');
  const stats = bs.filter((b) => b.kind === 'stat-table');
  ok('问圣遗物时只出圣遗物表，不出武器表',
    stats.length >= 1 && stats.every((b) => b.tables.every((t) => t.slot === '圣遗物推荐')),
    stats.map((b) => b.tables.map((t) => t.slot).join('+')).join(' | '));
}
{
  const bs = build('玛薇卡用什么武器');
  const stats = bs.filter((b) => b.kind === 'stat-table');
  ok('问武器时只出武器表',
    stats.length >= 1 && stats.every((b) => b.tables.every((t) => t.slot === '武器推荐')),
    stats.map((b) => b.tables.map((t) => t.slot).join('+')).join(' | '));
}
{
  // 这一条**方向反过来了**，记下来免得以后又改回去：
  //   早先的断言是「问角色相关问题就带一张紧凑立绘当视觉锚点」，
  //   理由是"用户会奇怪怎么没有图"。
  //   但实际用起来，用户问「推荐武器」收到一张胡桃立绘，反馈是
  //   「不要把立绘给我，问什么给什么，不多不少」。
  //   所以现在：**问了具体方面就不给角色图** —— 那些块自己带图
  //   （武器推荐给武器缩略图），再叠一张角色立绘就是多给。
  for (const q of ['给我推荐适合玛薇卡穿戴的圣遗物', '玛薇卡的命座', '玛薇卡的天赋', '玛薇卡的突破材料']) {
    const bs = build(q);
    ok(`「${q}」不附角色立绘（问的是具体方面）`,
      !bs.some((b) => b.kind === 'image'),
      bs.map((b) => b.kind).join(','));
  }
  // 反过来：问「这个角色是谁」才是该给角色图的地方
  for (const q of ['胡桃是谁', '介绍一下胡桃', '胡桃的资料']) {
    const bs = build(q);
    ok(`「${q}」带角色图 + 基础档案`,
      bs.some((b) => b.kind === 'image' && b.compact === true) &&
      bs.some((b) => b.kind === 'stat-table' && b.profile.length >= 5 && !b.tables.length),
      bs.map((b) => b.kind).join(','));
  }
  // 但明确要立绘时不该退回紧凑模式
  const art = build('胡桃的立绘').find((b) => b.kind === 'image');
  ok('明确问立绘时给完整立绘（不是紧凑图）',
    !!art && art.compact === false && art.items.some((i) => i.size === 'display'),
    art && art.items.map((i) => i.label).join('/'));
  // 一个回合不该出两张图
  const two = build('胡桃的立绘和语音');
  ok('同一回合不重复出图', two.filter((b) => b.kind === 'image').length <= 1,
    two.map((b) => b.kind).join(','));
}

ok('库外问题不造块', build('红烧肉怎么做').length === 0, JSON.stringify(kindsOf(build('红烧肉怎么做'))));
ok('不相关的问题不造块', build('今天天气怎么样').length === 0);
{
  // 角色类块要能忍住：问「立绘」但没指名角色 -> 不出图块（宁可不给，也不给错人）
  const bs = build('给我看看立绘');
  ok('没指名角色时不出 image 块（不给错人）', !bs.some((b) => b.kind === 'image'),
    JSON.stringify(kindsOf(bs)));
}
{
  // 每个块都带 reason，便于客户端/排查知道「为什么冒出来」
  const bs = build('胡桃的立绘');
  ok('每个块都带 reason', bs.every((b) => typeof b.reason === 'string' && b.reason), bs.map((b) => b.reason).join(','));
}
{
  // 一块出错不该拖垮别的块
  const fake = {
    db: { prepare: () => { throw new Error('模拟数据库炸了'); } },
    ws: null, obc: { prepare: () => { throw new Error('炸了'); } },
    query: () => { throw new Error('炸了'); },
    resolveCharacterId: () => 91,
    findAnchors: () => [{ kind: 'character', name: '胡桃' }],
  };
  let threw = false;
  let out = [];
  try { out = buildBlocks({ v1: fake, question: '胡桃的立绘和语音', anchors: fake.findAnchors(), entities: [] }); }
  catch { threw = true; }
  ok('单个块构造失败不抛异常（只丢它自己）', !threw, `返回 ${out.length} 块`);
}

// ================================================================ E. 辅助函数
console.log('\n  ── E. 辅助函数 ──');

{
  const bs = build('胡桃的立绘');
  const s = summarizeBlocks(bs);
  ok('summarizeBlocks 只给形状不给正文',
    s.length === 1 && s[0].kind === 'image' && !JSON.stringify(s).includes('/v1/asset/'),
    JSON.stringify(s));
}
{
  const bs = build('胡桃的语音');
  const hint = blockHintForPrompt(bs);
  ok('blockHintForPrompt 有内容', hint.length > 20, hint.slice(0, 70));
  ok('提示词明确要求「不要复述」', /不要.*复述|别复述/.test(hint), hint.slice(0, 90));
}
ok('没有块时 hint 是空串', blockHintForPrompt([]) === '', JSON.stringify(blockHintForPrompt([])));
ok('summarizeBlocks 空数组安全', JSON.stringify(summarizeBlocks([])) === '[]');

v1.close();

// ================================================================ F. 端到端
console.log('\n  ── F. 端到端（SSE 事件流） ──');

const child = spawn(process.execPath, [path.join(KB, 'serve-client.mjs')], {
  cwd: KB,
  env: {
    ...process.env,
    KB_CLIENT_PORT: String(PORT), KB_CLIENT_HOST: '127.0.0.1',
    KB_CLIENT_TOKEN: TOKEN, KB_CLIENT_RATE: '5000', KB_CLIENT_AUTH: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });
let up = false;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`${BASE}/v1/health`); if (r.ok) { up = true; break; } } catch { /* 等 */ }
  await sleep(250);
}
if (!up) { console.error('服务没能启动：\n' + log); child.kill(); process.exit(1); }

async function chat(message) {
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: 'blocks-smoke-' + Math.random().toString(36).slice(2) }),
  });
  const raw = await res.text();
  const events = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try { events.push(JSON.parse(t.slice(5).trim())); } catch { /* 忽略 */ }
  }
  return events;
}
const typeOf = (evs, t) => evs.find((e) => e.type === t);

try {
  const evs = await chat('胡桃的立绘');
  const blk = typeOf(evs, 'blocks');
  ok('SSE 里有 blocks 事件', !!blk, blk ? `${blk.blocks.length} 块` : '(没有)');
  ok('blocks 事件的块是 image', !!blk && blk.blocks.some((b) => b.kind === 'image'),
    blk && kindsOf(blk.blocks).join(','));
  ok('blocks 事件在 provider 之前（生成前就定好了）', (() => {
    const i = evs.findIndex((e) => e.type === 'blocks');
    const j = evs.findIndex((e) => e.type === 'provider');
    return i >= 0 && j >= 0 && i < j;
  })(), evs.map((e) => e.type).join(','));
  const done = typeOf(evs, 'done');
  ok('done 里带块的概要', !!done && Array.isArray(done.blocks) && done.blocks.length > 0,
    done && JSON.stringify(done.blocks));
  ok('done 的块概要不含图片 URL（概要只给形状）',
    !!done && !JSON.stringify(done.blocks).includes('/v1/asset/'), done && JSON.stringify(done.blocks));

  // 有块时模型应当**不复述**块里已经展示过的东西。
  //
  // 判据从「回答 < 200 字」改成「回答里没有块内条目名」——
  // 200 字只是「没复述」的代理指标，而提示词本来就允许补充块**之外**的信息
  // （背景/因果/争议）。实测 deepseek-flash 会先写一句「本轮的资料里没有画面描述，
  // 补充点背景」再列 3~4 条带引用的背景，280 字上下，内容完全合规，却把 < 200 的断言
  // 打红（9 次里 3 次）。真正要抓的是「把上面的图再描述一遍」——
  // 那种回答一定会出现块内的条目名（见 lib/blocks.mjs 的 buildImage：全身立绘/半身像/头像）。
  //
  // 检索模式（extractive，本机没跑生成模型时）正文就是资料原文摘录，天然很长，跳过。
  const ans = (done && done.answer) || '';
  const isExtractive = (typeOf(evs, 'provider') || {}).provider === 'extractive';
  if (isExtractive) {
    ok('检索模式跳过「不复述」断言', true, `provider=extractive · ${ans.length} 字（原文摘录）`);
  } else {
    const BLOCK_ITEM_LABELS = ['全身立绘', '半身像', '头像'];   // buildImage（立绘块）给的三项
    const restated = BLOCK_ITEM_LABELS.filter((t) => ans.includes(t));
    ok('有块时不复述块里的条目（回答里没有块内条目名）', restated.length === 0,
      restated.length ? `复述了：${restated.join('、')}` : `${ans.length} 字 · 未复述`);
    ok('有块时回答不失控（< 400 字）', ans.length < 400, `${ans.length} 字: ${ans.slice(0, 50)}`);
  }

  // 无块的问题不该发 blocks 事件
  const evs2 = await chat('红烧肉怎么做才好吃');
  ok('无块问题发空 blocks 数组，保持正常流顺序', (typeOf(evs2, 'blocks')?.blocks || []).length === 0, evs2.map((e) => e.type).join(','));

  // 观测枢列表块
  const evs3 = await chat('有哪些敌人');
  const blk3 = typeOf(evs3, 'blocks');
  ok('「有哪些敌人」出 list 块', !!blk3 && blk3.blocks.some((b) => b.kind === 'list'),
    blk3 && kindsOf(blk3.blocks).join(','));

  // 关系图 + 配装表
  const evs4 = await chat('胡桃和钟离什么关系');
  ok('「关系」出 relation-graph 块',
    (() => { const b = typeOf(evs4, 'blocks'); return !!b && b.blocks.some((x) => x.kind === 'relation-graph'); })(),
    (() => { const b = typeOf(evs4, 'blocks'); return b ? kindsOf(b.blocks).join(',') : '(无)'; })());

  const evs5 = await chat('胡桃的配装推荐');
  ok('「配装」出 stat-table 块',
    (() => { const b = typeOf(evs5, 'blocks'); return !!b && b.blocks.some((x) => x.kind === 'stat-table'); })(),
    (() => { const b = typeOf(evs5, 'blocks'); return b ? kindsOf(b.blocks).join(',') : '(无)'; })());

  // 块不该破坏既有护栏：库外问题仍然拒答
  const evs6 = await chat('!!!???');
  const g6 = typeOf(evs6, 'grounding');
  ok('加了块之后，硬拒答仍然生效', !!g6 && g6.refused === true, `level=${g6 && g6.level}`);
  ok('拒答时也不发块', !typeOf(evs6, 'blocks'));
} finally {
  child.kill();
  await sleep(400);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
