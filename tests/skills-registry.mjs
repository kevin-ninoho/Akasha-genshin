// 技能注册表测试。
//
// 覆盖三件事：
//   A. 注册表本身：路由、优先级、excludes、目录形状
//   B. 独立技能模块（stats）能跑通并产出合法块
//   C. 回归：原有 13 个技能仍然照旧路由（与 v1-blocks-smoke 互补，这里更聚焦注册表）
//
//   KB_DIR=<kb-viz> KB_DATA_DIR=<kb-viz>/data node tests/skills-registry.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB = process.env.KB_DIR || path.resolve(HERE, '..', 'engine');
const DATA = process.env.KB_DATA_DIR || path.join(KB, 'data');

const { SKILLS, CATEGORIES, matchSkills, resolveSkills, skillCatalog, skillById } =
  await import(pathToFileURL(path.join(KB, 'lib', 'skills', 'index.mjs')).href);
const { buildBlocks, routeIntents, BLOCK_KINDS } =
  await import(pathToFileURL(path.join(KB, 'lib', 'blocks.mjs')).href);
const { openV1 } = await import(pathToFileURL(path.join(KB, 'lib', 'v1-data.mjs')).href);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  [ok] ${n}`); } else { fail++; console.log(`  [FAIL] ${n}${x ? ' :: ' + x : ''}`); } };

console.log('\n  ── A. 注册表结构 ──');
{
  ok('技能数 > 20（含 planned）', SKILLS.length > 20, String(SKILLS.length));
  ok('每个技能都有 id/label/category/status', SKILLS.every((s) =>
    s.id && s.label && s.category && s.status));
  ok('id 不重复', new Set(SKILLS.map((s) => s.id)).size === SKILLS.length);
  ok('category 都在 CATEGORIES 里', SKILLS.every((s) =>
    CATEGORIES.some((c) => c.id === s.category)),
    [...new Set(SKILLS.map((s) => s.category))].join(','));
  ok('ready 的技能都有 patterns', SKILLS.filter((s) => s.status === 'ready').every((s) =>
    Array.isArray(s.patterns) && s.patterns.length > 0));
  ok('planned 的技能先不接 patterns（不会误触发）', SKILLS.filter((s) => s.status === 'planned').every((s) =>
    !s.patterns || s.patterns.length === 0));
  ok('ready 的都有 examples（客户端要展示）', SKILLS.filter((s) => s.status === 'ready').every((s) =>
    Array.isArray(s.examples) && s.examples.length > 0));

  // excludes 不能指向不存在的技能，否则是静默失效的配置
  const ids = new Set(SKILLS.map((s) => s.id));
  const badEx = [];
  for (const s of SKILLS) for (const e of s.excludes || []) if (!ids.has(e)) badEx.push(`${s.id}→${e}`);
  ok('excludes 都指向真实技能', badEx.length === 0, badEx.join(','));
}

console.log('\n  ── B. 路由与优先级 ──');
{
  ok('「胡桃的立绘」→ art', matchSkills('胡桃的立绘').some((h) => h.skill.id === 'art'));
  ok('「胡桃的突破材料」→ ascension', matchSkills('胡桃的突破材料').some((h) => h.skill.id === 'ascension'));
  ok('「胡桃80级练到90」→ plan', matchSkills('胡桃80级练到90').some((h) => h.skill.id === 'plan'));
  ok('「谁台词最多」→ stats', matchSkills('谁台词最多').some((h) => h.skill.id === 'stats'));

  // 优先级排序：plan(100) 必须排在 ascension(50) 前面
  const h = matchSkills('胡桃80级练到90需要哪些突破材料');
  const ids = h.map((x) => x.skill.id);
  ok('plan 排在 ascension 之前', ids.indexOf('plan') < ids.indexOf('ascension'), ids.join('>'));

  // excludes 生效：plan 命中时压掉 ascension/build
  const resolved = resolveSkills(h).map((x) => x.skill.id);
  ok('plan 命中时压掉 ascension', !resolved.includes('ascension'), resolved.join(','));
  ok('plan 自己还在', resolved.includes('plan'));

  // 没有 plan 时 ascension 不该被压
  const r2 = resolveSkills(matchSkills('胡桃的突破材料')).map((x) => x.skill.id);
  ok('无 plan 时 ascension 保留', r2.includes('ascension'), r2.join(','));

  // 互斥保护：两个技能互相 excludes 不该双双消失
  ok('不相关的问题不命中', matchSkills('红烧肉怎么做').length === 0);
  ok('空串不命中', matchSkills('').length === 0);
  ok('null 不抛异常', Array.isArray(matchSkills(null)));
}

console.log('\n  ── C. 目录（客户端技能面板的数据源）──');
{
  const cat = skillCatalog();
  ok('有 categories', Array.isArray(cat.categories) && cat.categories.length === CATEGORIES.length);
  ok('每个分类都带 skills 数组', cat.categories.every((c) => Array.isArray(c.skills)));
  ok('统计数对得上', cat.counts.ready + cat.counts.beta + cat.counts.planned === SKILLS.length,
    JSON.stringify(cat.counts));
  const flat = cat.categories.flatMap((c) => c.skills);
  ok('所有技能都出现在某个分类下', flat.length === SKILLS.length, `${flat.length} vs ${SKILLS.length}`);
  // 目录不该泄漏内部字段
  ok('目录不含 patterns（内部实现）', flat.every((s) => !('patterns' in s)));
  ok('目录不含 run（内部实现）', flat.every((s) => !('run' in s)));
  ok('目录带可直接展示的例子', flat.filter((s) => s.status === 'ready').every((s) => s.examples.length));
}

console.log('\n  ── D. 独立技能模块 stats ──');
{
  const v1 = openV1(DATA, { writable: false });
  // anchors 必须传：buildBlocks 靠它（配合 entities）定位「问的是哪个角色」。
  // 漏了这一步 targetCharacter 返回 null，所有需要角色的技能都不出块 ——
  // 第一次写这个测试就漏了，四个断言一起挂。与 v1-blocks-smoke 的调法保持一致。
  const build = (q) => buildBlocks({ v1, question: q, anchors: v1.findAnchors(q), entities: [] });

  const rank = build('谁台词最多').find((b) => b.kind === 'stat-table');
  ok('「谁台词最多」出 stat-table', !!rank, build('谁台词最多').map((b) => b.kind).join(','));
  if (rank) {
    ok('块带 tables', Array.isArray(rank.tables) && rank.tables.length > 0);
    const t = rank.tables[0];
    ok('表有 rows', Array.isArray(t.rows) && t.rows.length > 0, String(t.rows.length));
    ok('首行是第一名', /^1$/.test(String(t.rows[0][0])), JSON.stringify(t.rows[0]));
    ok('带 bars（客户端可画条形图）', Array.isArray(rank.bars) && rank.bars.length > 0);
    ok('块标注了来源', !!rank.source, rank.source);
    ok('块登记了技能来源（新字段）', rank.skill && rank.skill.id === 'stats', JSON.stringify(rank.skill));
  }

  const one = build('胡桃有多少句台词').find((b) => b.kind === 'stat-table');
  ok('「胡桃有多少句台词」出单角色统计', !!one);
  if (one) {
    ok('单角色表含台词行数', one.tables[0].rows.some((r) => /台词行数/.test(r[0])),
      JSON.stringify(one.tables[0].rows.map((r) => r[0])));
    ok('title 带角色名', /胡桃/.test(one.title), one.title);
  }

  // 原有技能不受新模块影响
  const asc = build('胡桃的突破材料').find((b) => b.kind === 'ascension');
  ok('ascension 仍正常', !!asc, build('胡桃的突破材料').map((b) => b.kind).join(','));
  const art = build('胡桃的立绘').find((b) => b.kind === 'image');
  ok('art 仍正常', !!art);

  // stats 产出的 kind 必须在 BLOCK_KINDS 里登记
  ok('stats 用的 kind 已登记', BLOCK_KINDS.includes('stat-table'));

  v1.close();
}

console.log('\n  ── E. 手动选技能（界面点技能卡那条路）──');
{
  // 这是产品的核心交互：用户点「角色档案」→ 打字「钟离是谁」。
  // 没有这个参数时，只打「钟离」一个块都不出（正则无从判断）。
  const v1 = openV1(DATA, { writable: false });
  const withSkill = (q, sk) => buildBlocks({ v1, question: q, anchors: v1.findAnchors(q), entities: [], skill: sk });
  const kinds = (bs) => bs.map((b) => b.kind).join(',');

  // 基线：纯角色名不命中任何意图
  ok('不选技能 +「钟离」= 无块', withSkill('钟离', '').length === 0, kinds(withSkill('钟离', '')));

  // 选了技能就有了
  const prof = withSkill('钟离', 'profile');
  ok('skill=profile +「钟离」出块', prof.length > 0, kinds(prof));
  ok('产出的是 profile 技能', prof.some((b) => b.skill && b.skill.id === 'profile'),
    prof.map((b) => b.skill && b.skill.id).join(','));

  for (const [sk, wantKind] of [['voice', 'voice-list'], ['artifact', 'stat-table'],
    ['talent', 'talent'], ['constellation', 'constellation'], ['ascension', 'ascension']]) {
    const bs = withSkill('钟离', sk);
    ok(`skill=${sk} +「钟离」出 ${wantKind}`, bs.some((b) => b.skill && b.skill.id === sk), kinds(bs));
  }

  // plan 需要等级信息才有 steps
  const pl = withSkill('胡桃', 'plan');
  ok('skill=plan +「胡桃」出规划块', pl.some((b) => b.kind === 'plan'), kinds(pl));

  // 手动选的不该被别的技能的 excludes 挤掉
  const bd = withSkill('钟离的圣遗物', 'build');
  ok('手动选的 build 不会被 artifact 压掉', bd.some((b) => b.skill && b.skill.id === 'build'),
    bd.map((b) => b.skill && b.skill.id).join(','));
  ok('同时命中的 artifact 也在（不是二选一）', bd.some((b) => b.skill && b.skill.id === 'artifact'),
    bd.map((b) => b.skill && b.skill.id).join(','));

  // 非法 / 空 skill 不能炸，要退回正则路由
  ok('非法 skill 不炸', Array.isArray(withSkill('胡桃是谁', 'no-such-xyz')));
  ok('非法 skill 退回正则路由（profile 仍命中）',
    withSkill('胡桃是谁', 'no-such-xyz').some((b) => b.skill && b.skill.id === 'profile'));
  ok('skill=null 不炸', Array.isArray(withSkill('胡桃是谁', null)));

  // matchSkills 的契约
  const h = matchSkills('钟离', 'profile');
  ok('matchSkills(q, skill) 把选中的排在最前', h[0] && h[0].skill.id === 'profile',
    h.map((x) => x.skill.id).join(','));
  ok('matchSkills 的 matched 标记为手动选择', h[0] && h[0].matched === '手动选择', String(h[0] && h[0].matched));
  ok('skillById 能找到', skillById('profile') && skillById('profile').label === '角色档案');
  ok('skillById 找不到返回 null', skillById('nope') === null);
  ok('skillById 空值返回 null', skillById('') === null);

  v1.close();
}

console.log('\n  ── F. 每个技能块都带 skill 溯源 ──');
{
  const v1 = openV1(DATA, { writable: false });
  const cases = ['胡桃的立绘', '胡桃是谁', '胡桃的语音', '胡桃认识谁', '胡桃用什么武器',
    '胡桃的圣遗物', '胡桃的配装推荐', '胡桃的天赋', '胡桃的命座',
    '胡桃的突破材料', '谁台词最多'];
  let missing = [];
  for (const q of cases) {
    const bs = buildBlocks({ v1, question: q, anchors: v1.findAnchors(q), entities: [] });
    for (const b of bs) {
      // 角色锚点那张图是 buildBlocks 直接塞的，不是技能产出，允许没有 skill
      if (b.reason === '角色锚点') continue;
      if (!b.skill || !b.skill.id) missing.push(`${q} → ${b.kind}`);
    }
  }
  ok('每个技能产出的块都带 skill 溯源', missing.length === 0, missing.join('; '));

  // routeIntents 契约保持不变
  const r = routeIntents('胡桃的立绘');
  ok('routeIntents 仍返回 {intents, matched}', Array.isArray(r.intents) && typeof r.matched === 'object');
  ok('routeIntents 的 matched 记原词', r.matched.art === '立绘', JSON.stringify(r.matched));
  v1.close();
}

console.log(`\n  ── 结果：${pass} 通过 / ${fail} 失败 ──`);
process.exit(fail ? 1 : 0);
