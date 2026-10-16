// 练度规划引擎。
//
// 设计原则：
//   1) **纯计算** —— 只读库、不写库、不调模型。同样输入永远同样输出，
//      这是它能被 selftest 断言的前提，也是它敢说自己「不瞎编」的底气。
//   2) **材料从阶段求和，不用观测枢的 1→90 总计** —— 总计只对「从 1 级开始」有意义；
//      玩家在 80 级时，总计里的前五段都是浪费。分段求和才能给出「还差什么」。
//   3) **认不出来的不猜** —— 材料获取途径判不出就标 UNKNOWN，树脂留 null 并进 notes。
//      宁可给不出一行树脂，也不能给一个看起来精确的错数字。
//
// 数据来源：观测枢「角色突破」模块（136/136 覆盖，已实测）。
import { parseEntryModules } from './obc-modules.mjs';
import { obcSourceUrl } from './obc.mjs';
import {
  classifyAcquisition, runsFor, daysFor, rulesSummary,
  ASCENSION_MORA, OBC_TOTAL_MORA_1_TO_90, DAILY_RESIN,
} from './resin-cost.mjs';

export const MAX_ROSTER = 20;
const LEVEL_MIN = 1;
const LEVEL_MAX = 100;

/**
 * 突破阶段名 → 等级数字。
 * 「20级突破」→ 20；「1级属性/突破所需材料」→ null；
 * 「90级属性 / 95级属性 / 100级属性」→ null（**不是突破**，它们要的是「无主的命星」，
 * 属于另一套系统，混进来会凭空多出材料）。
 */
export function stageLevelOf(stage) {
  const m = String(stage || '').match(/^(\d+)\s*级突破/);
  return m ? Number(m[1]) : null;
}

/** 判断一个材料名是不是货币（摩拉），货币不消耗树脂。 */
function isCurrency(name) {
  return /^摩拉$/.test(String(name || '').trim());
}

/**
 * 查一件材料的「获得方式」原文，并分类。
 * 带缓存：20 个角色 × 10 件材料会有大量重复查询。
 */
function makeAcquisitionLookup(obcDb) {
  const cache = new Map();
  return function lookup(name) {
    if (cache.has(name)) return cache.get(name);
    let result;
    if (isCurrency(name)) {
      result = { kind: 'CURRENCY', resin: null, costSource: null, note: '货币，不消耗树脂', acquireText: '' };
    } else if (!obcDb) {
      result = { kind: 'UNKNOWN', resin: null, costSource: null, note: '观测枢不可用', acquireText: '' };
    } else {
      let text = '';
      try {
        // 材料可能落在 item / item-2 等多个 kind 上，按名字取第一条有获得方式的
        const rows = obcDb.prepare(
          'SELECT raw_json FROM obc_entries WHERE name = ? LIMIT 6',
        ).all(String(name));
        for (const r of rows) {
          try {
            const o = JSON.parse(r.raw_json);
            for (const m of (o.modules || [])) {
              const c0 = (m.components || [])[0];
              if (!c0 || typeof c0.data !== 'string') continue;
              let d;
              try { d = JSON.parse(c0.data); } catch { continue; }
              if (d && d.materials && d.materials.key === '获得方式') {
                const v = d.materials.value;
                text = Array.isArray(v) ? v.join(' ') : String(v || '');
                break;
              }
            }
          } catch { /* 单条坏了不影响其它 */ }
          if (text) break;
        }
      } catch { /* 忽略 */ }
      const cls = classifyAcquisition(text);
      result = { ...cls, acquireText: text };
    }
    cache.set(name, result);
    return result;
  };
}

/** 把角色的材料按名字合并累加。 */
function mergeMaterials(target, materials) {
  for (const m of materials) {
    const name = String(m.name || '').trim();
    if (!name) continue;
    const amount = Number(m.amount) || 0;
    if (amount <= 0) continue;
    const cur = target.get(name);
    if (cur) cur.amount += amount;
    else target.set(name, { name, amount, icon: m.icon || '', obcId: m.obcId || null });
  }
}

/** 解析一个角色的突破数据。 */
function ascensionsOf(obcDb, charName) {
  if (!obcDb) return null;
  try {
    const row = obcDb.prepare(
      "SELECT id, raw_json FROM obc_entries WHERE kind = 'character' AND name = ?",
    ).get(charName);
    if (!row || !row.raw_json) return null;
    const mods = parseEntryModules(row.raw_json, { id: row.id });
    return { obcId: row.id, ascensions: mods.ascensions || [] };
  } catch {
    return null;
  }
}

/** 排序权重。 */
function scoreOf(char, myLevel, targetLevel, sharedCount, prefer) {
  const role = String(char.role || '');
  const isDps = /输出|主C|爆发型|站场/.test(role);
  const isSupport = /辅助|治疗|护盾|增益|减抗/.test(role);
  const rarity = Number(char.rarity) || 0;
  // 已投入越多，边际收益越低；但快练完的更该收尾。
  const nearDone = myLevel >= 70 ? 1 : myLevel >= 40 ? 0.5 : 0;

  switch (prefer) {
    case 'dps':
      return (isDps ? 10 : 0) + rarity + nearDone;
    case 'support':
      return (isSupport ? 10 : 0) + rarity + nearDone;
    case 'completion':
      // 谁快达标谁先来 —— 用「还差几段」的负数表示
      return -Math.max(0, targetLevel - myLevel);
    case 'balanced':
    default:
      return rarity * 0.3 + (isDps || isSupport ? 3 : 0) * 0.3 + nearDone * 0.2 + sharedCount * 0.2;
  }
}

/**
 * 生成规划。
 *
 * @param {object} v1 openV1() 的返回值（要用到 db / obc）
 * @param {object} input { roster, target, resin, prefer, optimize }
 * @returns {{ok:boolean, error?:string, ...}}
 */
export function buildPlan(v1, input = {}) {
  const prefer = ['dps', 'support', 'completion', 'balanced'].includes(input.prefer) ? input.prefer : 'balanced';
  const optimize = ['resin', 'shared-material', 'mora'].includes(input.optimize) ? input.optimize : 'shared-material';
  const targetLevel = clamp(Number(input.target && input.target.level) || 90, LEVEL_MIN, LEVEL_MAX);
  const resinBudget = Number.isFinite(Number(input.resin)) && Number(input.resin) > 0 ? Number(input.resin) : null;

  const rawRoster = Array.isArray(input.roster) ? input.roster : [];
  if (!rawRoster.length) return { ok: false, error: 'empty_roster', message: 'roster 不能为空' };
  if (rawRoster.length > MAX_ROSTER) {
    return { ok: false, error: 'roster_too_large', message: `一次最多规划 ${MAX_ROSTER} 个角色` };
  }

  const one = (sql, ...p) => v1.db.prepare(sql).get(...p);
  const lookup = makeAcquisitionLookup(v1.obc);

  const steps = [];
  const skipped = [];
  const notes = new Set();
  const grandMaterials = new Map();      // 材料名 → 合并后的总量（跨角色）
  const usedBy = new Map();              // 材料名 → 角色名集合

  for (const entry of rawRoster) {
    const charId = Number(entry && entry.charId);
    const level = clamp(Number(entry && entry.level) || 1, LEVEL_MIN, LEVEL_MAX);

    if (!Number.isFinite(charId)) {
      skipped.push({ charId: entry && entry.charId, name: '', reason: 'charId 非法' });
      continue;
    }
    const row = one('SELECT * FROM characters WHERE id = ? AND game_id = 1', charId);
    if (!row) {
      skipped.push({ charId, name: '', reason: '库中没有该角色' });
      continue;
    }
    if (level >= targetLevel) {
      skipped.push({ charId, name: row.name, reason: `已到 ${level} 级，无需培养` });
      continue;
    }

    const asc = ascensionsOf(v1.obc, row.name);
    if (!asc || !asc.ascensions.length) {
      // 观测枢没收录角色页的 9 个（派蒙 / 旅行者 / 戴因斯雷布…）会走到这里
      skipped.push({ charId, name: row.name, reason: '观测枢未收录其角色档案，无突破数据' });
      continue;
    }

    // 只要「N级突破」且 N >= 当前等级、N < 目标等级。
    // 之所以是 >= 而不是 >：玩家报 80 级，通常指「卡在 80 级上限，还没做这次突破」。
    const need = asc.ascensions.filter((a) => {
      const lv = stageLevelOf(a.stage);
      return lv != null && lv >= level && lv < targetLevel && a.materials.length;
    });

    if (!need.length) {
      skipped.push({ charId, name: row.name, reason: '该等级区间没有可做的突破' });
      continue;
    }

    const mats = new Map();
    let mora = 0;
    for (const a of need) {
      mergeMaterials(mats, a.materials.filter((m) => !isCurrency(m.name)));
      const lv = stageLevelOf(a.stage);
      mora += ASCENSION_MORA[lv] || 0;
    }

    // 汇总到全局，同时记录「谁要它」
    for (const m of mats.values()) {
      const g = grandMaterials.get(m.name);
      if (g) g.amount += m.amount;
      else grandMaterials.set(m.name, { ...m });
      if (!usedBy.has(m.name)) usedBy.set(m.name, new Set());
      usedBy.get(m.name).add(row.name);
    }

    steps.push({
      charId,
      charName: row.name,
      rarity: row.rarity || null,
      element: row.element || '',
      role: row.role || '',
      from: level,
      to: targetLevel,
      stages: need.map((a) => a.stage),
      newTalents: need.map((a) => a.newTalent).filter(Boolean),
      materials: [...mats.values()].map((m) => ({
        name: m.name,
        amount: m.amount,
        icon: m.icon,
        sourceUrl: obcSourceUrl(m.obcId),
      })),
      mora,
      moraSource: 'external',
      obcId: asc.obcId,
      sourceUrl: obcSourceUrl(asc.obcId),
      _sharedCount: 0,
    });
  }

  // 共享材料计数（用于排序权重）
  for (const s of steps) {
    s._sharedCount = s.materials.filter((m) => (usedBy.get(m.name) || new Set()).size > 1).length;
  }

  // 排序
  steps.sort((a, b) => {
    const d = scoreOf(b, b.from, targetLevel, b._sharedCount, prefer)
            - scoreOf(a, a.from, targetLevel, a._sharedCount, prefer);
    return d !== 0 ? d : a.charId - b.charId;
  });
  steps.forEach((s, i) => { s.order = i + 1; delete s._sharedCount; });

  // ── 全局材料清单 + 树脂 ──────────────────────────────────────────────
  let totalResin = 0;
  let resinUpperBound = false;
  const unknownSources = new Set();

  const materials = [...grandMaterials.values()].map((m) => {
    const cls = lookup(m.name);
    const r = runsFor(m.amount, cls);
    if (r.resin != null) {
      totalResin += r.resin;
      if (r.upperBound) resinUpperBound = true;
    } else if (cls.kind === 'UNKNOWN') {
      unknownSources.add(m.name);
    }
    return {
      ...m,
      // 全局清单这里必须自己生成回链：mergeMaterials 只搬了 obcId，没搬 sourceUrl
      // （那时还没有 URL 的概念）。漏了这一步，全局限定就点不动了。
      sourceUrl: m.sourceUrl || obcSourceUrl(m.obcId),
      acquisition: {
        kind: cls.kind,
        note: cls.note,
        costSource: cls.costSource,
        // 一件材料常有多条获取途径（世界BOSS + 周本），主路取最省的，其余列出来
        alternatives: (cls.alternatives || []).map((a) => ({ kind: a.kind, resin: a.resin, costSource: a.costSource })),
      },
      runs: r.runs,
      resin: r.resin,
    };
  });

  // ── 冲突：被两个以上角色共用的材料 ──────────────────────────────────
  const conflicts = [...usedBy.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([name, set]) => ({
      material: name,
      total: (grandMaterials.get(name) || {}).amount || 0,
      usedBy: [...set],
    }))
    .sort((a, b) => b.usedBy.length - a.usedBy.length || b.total - a.total);

  const totalMora = steps.reduce((n, s) => n + s.mora, 0);

  if (unknownSources.size) {
    notes.add(`以下材料的获取途径未能从观测枢判出，未计入树脂：${[...unknownSources].join('、')}`);
  }
  if (resinUpperBound) {
    notes.add('树脂是**上界**：按每次产出 1 个计，实际一趟通常出更多，所以真实消耗更低。观测枢没有掉落数量数据，不编。');
  }
  if (skipped.length) {
    notes.add(`${skipped.length} 个角色未纳入规划，原因见 skipped。`);
  }

  const rules = rulesSummary();
  if (rules.unverified.length) {
    notes.add(`以下消耗值尚未最终核对：${rules.unverified.join('、')}（规则版本 ${rules.version}）`);
  }

  // 预算裁剪：给了 resin 就按顺序截断
  let planned = steps;
  let budgetNote = '';
  if (resinBudget != null) {
    let acc = 0;
    const kept = [];
    for (const s of steps) {
      const cost = costOfStep(s, materials);
      if (acc + cost.resin > resinBudget && kept.length) break;
      acc += cost.resin;
      kept.push(s);
    }
    planned = kept;
    budgetNote = `按 ${resinBudget} 树脂预算截断，保留前 ${kept.length} 个角色。`;
    notes.add(budgetNote);
  }

  return {
    ok: true,
    prefer, optimize,
    target: { level: targetLevel },
    steps: planned.map((s) => ({ ...s, cost: costOfStep(s, materials) })),
    materials: materials.sort((a, b) => (b.resin || 0) - (a.resin || 0) || b.amount - a.amount),
    conflicts,
    skipped,
    summary: {
      charCount: planned.length,
      materialKinds: materials.length,
      mora: totalMora,
      moraSource: 'external',
      resin: totalResin,
      resinIsUpperBound: resinUpperBound,
      resinBudget,
      days: daysFor(totalResin),
      dailyResin: DAILY_RESIN.value,
    },
    notes: [...notes],
    rules,
    source: '米游社观测枢',
  };
}

function costOfStep(step, materials) {
  const names = new Set(step.materials.map((m) => m.name));
  let resin = 0;
  let upper = false;
  for (const m of materials) {
    if (!names.has(m.name)) continue;
    if (m.resin != null) { resin += m.resin; if (m.runs != null) upper = true; }
  }
  return { mora: step.mora, resin, resinIsUpperBound: upper };
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
