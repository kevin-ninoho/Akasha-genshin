// 练度规划引擎的自测。
//
// 刻意做成纯函数断言（不启服务、不发 HTTP）：规划是算出来的，不是生成出来的，
// 所以它必须能被逐条钉死。跑法：
//   node engine/tools/selftest-plan.mjs
//
// 退出码 0 = 全绿；1 = 有断言失败。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openV1 } from '../lib/v1-data.mjs';
import { buildPlan, stageLevelOf } from '../lib/plan.mjs';
import { parseEntryModules } from '../lib/obc-modules.mjs';
import {
  ASCENSION_MORA, OBC_TOTAL_MORA_1_TO_90, classifyAcquisition,
  DOMAIN_RESIN_BY_TYPE, rulesSummary,
} from '../lib/resin-cost.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 数据目录：优先环境变量，其次「引擎同级的 data/」。
// 与 tests/*.mjs 的约定一致 —— 开源树里不该出现任何绝对路径，
// prepublish-check 的 personal-path 规则会拦（这条踩过）。
const DATA = process.env.KB_DATA_DIR
  || path.resolve(HERE, '..', 'data');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const v1 = openV1(DATA, { writable: false });
const plan = (input) => buildPlan(v1, input);

console.log('\n═══ 0. 常量自校验 ═══');
{
  const sum = Object.values(ASCENSION_MORA).reduce((a, b) => a + b, 0);
  ok('突破摩拉六段合计 = 420,000', sum === 420000, `实际 ${sum}`);
  const leveling = OBC_TOTAL_MORA_1_TO_90 - sum;
  ok('观测枢总计 − 突破摩拉 = 1,672,530（升级摩拉）', leveling === 1672530, `实际 ${leveling}`);
  ok('规则里 5 个外部值已被标记待核对', rulesSummary().unverified.length >= 1);
}

console.log('\n═══ 1. 阶段名解析（必须排除非突破段）═══');
{
  ok('「80级突破」→ 80', stageLevelOf('80级突破') === 80);
  ok('「20级突破」→ 20', stageLevelOf('20级突破') === 20);
  ok('「1级属性/突破所需材料」→ null（不是突破）', stageLevelOf('1级属性/突破所需材料') === null);
  ok('「90级属性」→ null（不是突破）', stageLevelOf('90级属性') === null);
  ok('「95级属性」→ null', stageLevelOf('95级属性') === null);
  ok('「100级属性」→ null', stageLevelOf('100级属性') === null);
}

console.log('\n═══ 2. 数据完整性：分段求和 == 观测枢 1→90 总计 ═══');
{
  // 这一条最值钱：它证明「只用分段求和」与观测枢的总计口径一致。
  // 如果不一致，说明我们漏了段或混进了非突破段。
  for (const name of ['胡桃', '流浪者', '钟离']) {
    const row = v1.obc.prepare("SELECT id, raw_json FROM obc_entries WHERE kind='character' AND name=?").get(name);
    if (!row) { ok(`${name} 词条存在`, false); continue; }
    const mods = parseEntryModules(row.raw_json, { id: row.id });
    const total = mods.ascensions.find((a) => /1级属性/.test(a.stage));
    const stages = mods.ascensions.filter((a) => stageLevelOf(a.stage) != null);
    const sum = new Map();
    for (const s of stages) for (const m of s.materials) {
      if (/^摩拉$/.test(m.name)) continue;
      sum.set(m.name, (sum.get(m.name) || 0) + m.amount);
    }
    let mismatch = [];
    for (const m of (total ? total.materials : [])) {
      if (/^摩拉$/.test(m.name)) continue;   // 摩拉总计含升级费，不能比
      const got = sum.get(m.name) || 0;
      if (got !== m.amount) mismatch.push(`${m.name} 计${m.amount} vs 求和${got}`);
    }
    ok(`${name}：6 段材料求和 == 总计`, mismatch.length === 0, mismatch.slice(0, 3).join('; '));
  }
}

console.log('\n═══ 3. 基本规划：流浪者 ═══');
{
  const r80 = plan({ roster: [{ charId: 65, level: 80 }], target: { level: 90 } });
  ok('80→90 成功', r80.ok === true);
  ok('80→90 恰好 1 段（80级突破）', r80.steps[0] && r80.steps[0].stages.length === 1,
     r80.steps[0] ? r80.steps[0].stages.join(',') : 'no step');
  ok('80→90 阶段名正确', r80.steps[0] && r80.steps[0].stages[0] === '80级突破');
  const mats = r80.steps[0] ? r80.steps[0].materials : [];
  const got = Object.fromEntries(mats.map((m) => [m.name, m.amount]));
  ok('前两段材料为空（不该出现 20/40 级材料）', !('自在松石碎屑' in got), JSON.stringify(got));
  ok('含 自在松石×6', got['自在松石'] === 6, JSON.stringify(got));
  ok('材料带官方回链', mats.every((m) => /^https:\/\/baike\.mihoyo\.com\//.test(m.sourceUrl || '')),
     mats.filter((m) => !m.sourceUrl).map((m) => m.name).join(','));

  const r1 = plan({ roster: [{ charId: 65, level: 1 }], target: { level: 90 } });
  ok('1→90 恰好 6 段', r1.steps[0] && r1.steps[0].stages.length === 6,
     r1.steps[0] ? String(r1.steps[0].stages.length) : 'no step');
  ok('1→90 摩拉 = 420,000', r1.steps[0] && r1.steps[0].mora === 420000,
     r1.steps[0] ? String(r1.steps[0].mora) : 'no step');

  const r90 = plan({ roster: [{ charId: 65, level: 90 }], target: { level: 90 } });
  ok('90→90 进 skipped，steps 为空', r90.ok === true && r90.steps.length === 0 && r90.skipped.length === 1);

  const r47 = plan({ roster: [{ charId: 65, level: 47 }], target: { level: 90 } });
  ok('47→90 得 4 段（50/60/70/80）', r47.steps[0] && r47.steps[0].stages.length === 4,
     r47.steps[0] ? r47.steps[0].stages.join(',') : 'no step');
}

console.log('\n═══ 4. 边界与失败模式 ═══');
{
  ok('空 roster → empty_roster', plan({ roster: [] }).error === 'empty_roster');
  ok('超过 20 个 → roster_too_large',
     plan({ roster: Array.from({ length: 21 }, () => ({ charId: 65, level: 1 })) }).error === 'roster_too_large');

  const p = plan({ roster: [{ charId: 64, level: 1 }], target: { level: 90 } });
  ok('派蒙（无观测枢档案）进 skipped 且说明原因',
     p.ok === true && p.skipped.length === 1 && /观测枢/.test(p.skipped[0].reason),
     JSON.stringify(p.skipped));

  const u = plan({ roster: [{ charId: 999999, level: 1 }] });
  ok('不存在的 charId 进 skipped，不抛异常',
     u.ok === true && u.skipped.length === 1 && /没有该角色/.test(u.skipped[0].reason));

  const bad = plan({ roster: [{ charId: 'abc', level: 1 }] });
  ok('非法 charId 进 skipped，不抛异常', bad.ok === true && bad.skipped.length === 1);

  const clamped = plan({ roster: [{ charId: 65, level: 999 }], target: { level: 9999 } });
  ok('越界等级被 clamp，不抛异常', clamped.ok === true);
}

// 角色 id 对照（已从库里查证，别凭印象写）：
//   流浪者=65  胡桃=91  可莉=23  钟离=121  七七=1  派蒙=64
console.log('\n═══ 5. 共享材料与冲突 ═══');
{
  // 胡桃与可莉都是 5★ 火，突破都要「燃愿玛瑙」系列 → 必然检出共享
  const p = plan({ roster: [{ charId: 91, level: 1 }, { charId: 23, level: 1 }], target: { level: 90 } });
  if (p.ok && p.steps.length === 2) {
    const shared = p.conflicts.filter((c) => /燃愿玛瑙/.test(c.material));
    ok('胡桃+可莉 检出共享的火元素宝石', shared.length >= 1,
       p.conflicts.map((c) => c.material).join(','));
    if (shared.length) {
      const c = shared[0];
      const perChar = p.steps.map((s) => {
        const m = s.materials.find((x) => x.name === c.material);
        return m ? m.amount : 0;
      });
      ok('冲突里的总量 = 各角色之和（不重复计费）',
         c.total === perChar.reduce((a, b) => a + b, 0),
         `total=${c.total} sum=${perChar.reduce((a, b) => a + b, 0)}`);
      ok('冲突列出全部使用它的角色', c.usedBy.length === 2, c.usedBy.join(','));
    }
    const globalBoom = p.materials.find((m) => /燃愿玛瑙$/.test(m.name));
    const stepSum = p.steps.reduce((n, s) => {
      const m = s.materials.find((x) => x.name === (globalBoom || {}).name);
      return n + (m ? m.amount : 0);
    }, 0);
    ok('全局材料清单与各步之和一致', globalBoom && globalBoom.amount === stepSum,
       `global=${globalBoom && globalBoom.amount} sum=${stepSum}`);
  } else {
    ok('胡桃+可莉 规划可用（charId 可能不同）', false, `steps=${p.steps ? p.steps.length : 'n/a'}`);
  }
}

console.log('\n═══ 6. 排序 ═══');
{
  const roster = [
    { charId: 91, level: 1 },   // 胡桃 5★ 火「爆发型输出角色」
    { charId: 121, level: 1 },  // 钟离 5★ 岩「岩元素护盾兼输出」
  ];
  const a = plan({ roster, prefer: 'dps' });
  const b = plan({ roster, prefer: 'completion' });
  ok('dps 与 completion 都能跑通', a.ok && b.ok);
  ok('order 连续从 1 开始', a.steps.every((s, i) => s.order === i + 1));
}

console.log('\n═══ 7. 树脂预算截断 ═══');
{
  const p = plan({ roster: [{ charId: 91, level: 1 }, { charId: 65, level: 1 }], resin: 1, target: { level: 90 } });
  ok('极小预算至少保留 1 个（不会返回空）', p.ok && p.steps.length >= 1, `steps=${p.steps.length}`);
  ok('预算被记录进 summary', p.summary.resinBudget === 1);
  ok('截断写进 notes', p.notes.some((n) => /预算/.test(n)));
}

console.log('\n═══ 8. 材料获取途径分类 ═══');
{
  ok('征讨领域 → 60', classifyAcquisition('【「伏龙树」之底】追忆：摇撼山岳之龙Ⅲ').resin === 60);
  ok('采集 → 不耗树脂', classifyAcquisition('璃月港玉京台附近采集').resin === null);
  ok('秘境类型表里圣遗物=20', DOMAIN_RESIN_BY_TYPE['圣遗物'] === 20);
  ok('空文本 → UNKNOWN', classifyAcquisition('').kind === 'UNKNOWN');

  // 回归点：燃愿玛瑙的原文同时列了世界BOSS与追忆（周本）。
  // 早期实现「匹配到第一个就返回」，把它错判成周本（60）。现在取最省的（40）。
  const mix = classifyAcquisition(
    '【75级以上】爆炎树、北风的王狼、古岩龙蜥、无相之火 挑战奖励'
    + ' 【「伏龙树」之底】追忆：摇撼山岳之龙Ⅲ/Ⅳ'
    + ' 【鸣神岛·天守】追忆：红莲的真剑试合Ⅲ/Ⅳ',
  );
  ok('多来源材料取最省的：燃愿玛瑙 → 世界BOSS 40（不是周本 60）',
     mix.kind === 'WORLD_BOSS' && mix.resin === 40, `${mix.kind}/${mix.resin}`);
  ok('备选途径被保留下来', (mix.alternatives || []).length >= 1,
     JSON.stringify(mix.alternatives));

  // 只用采集能拿到的，不该被树脂化
  ok('采集类不参与树脂求和', classifyAcquisition('尘歌壶种植、商店购买').resin === null);
}

console.log('\n═══ 9. 全角色跑一遍（不允许抛异常）═══');
{
  const all = v1.db.prepare('SELECT id, name FROM characters ORDER BY id').all();
  let threw = 0, planned = 0, skipped = 0;
  const reasons = {};
  for (const c of all) {
    try {
      const r = plan({ roster: [{ charId: c.id, level: 1 }], target: { level: 90 } });
      if (r.steps.length) planned++; else skipped++;
      for (const s of r.skipped) { const k = (s.reason || '').slice(0, 20); reasons[k] = (reasons[k] || 0) + 1; }
    } catch (e) { threw++; console.log(`    ✗ ${c.name}: ${e.message}`); }
  }
  ok(`131 个角色全部无异常（共 ${all.length}）`, threw === 0, `${threw} 个抛异常`);
  ok('绝大多数角色能产出规划', planned >= all.length - 12, `planned=${planned} skipped=${skipped}`);
  console.log(`    产出规划 ${planned} / 跳过 ${skipped}`);
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`      跳过原因「${k}…」× ${v}`);
  }
}

v1.close();

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
