// 树脂消耗与材料获取途径。
//
// 为什么单独一个模块：这是「规划」里唯一**不来自观测枢**的部分。把它隔离出来，
// 将来游戏改数值时只改这一个文件，而且每一条都带着来源标记，不会混进权威数据里。
//
// ── 来源分两档，响应里逐条标 costSource ──────────────────────────────
//   'obc'      直接从观测枢词条提取，权威
//   'external' 观测枢没有，按通行值编码 —— **需要人工核对一次**
//
// 已有的官方依据（2026-10-16 实测，来源：观测枢「秘境索引」词条的结构化表）：
//   秘境类型            秘境消耗
//     圣遗物              原粹树脂*20
//     武器突破素材         原粹树脂*20
//     天赋培养素材         原粹树脂*20
//     征讨领域（周本）      原粹树脂*60
// 也就是说 —— 除世界BOSS外，**所有消耗都能从库里查出来，不必凭记忆写**。
//
// ⚠ 唯一的外部值：世界BOSS（WORLD_BOSS）。观测枢的 enemy 词条里没有消耗字段
//   （已实测：无相之火 / 爆炎树 / 古岩龙蜥 全部没有），所以只能编码。
//   核对方式：游戏内打开任意世界BOSS的「讨伐」界面看一次即可。

/** 规则版本。数值一旦调整就改这里，便于追溯历史规划结果。 */
export const RULES_VERSION = '2026-10-16';

// ---------------------------------------------------------------- 官方值（'obc'）

/**
 * 秘境类型 → 单次树脂。
 * 直接来自观测枢「秘境索引」词条，不是猜的。
 */
export const DOMAIN_RESIN_BY_TYPE = Object.freeze({
  圣遗物: 20,
  武器突破素材: 20,
  天赋培养素材: 20,
  征讨领域: 60,          // 周本
});

/** 取一件材料的「获得方式」文本里出现的秘境类型 → 树脂。 */
export const DOMAIN_TYPE_KEYWORDS = Object.freeze([
  [/征讨领域|周本|追忆/, '征讨领域'],
  [/圣遗物/, '圣遗物'],
  [/武器突破素材|武器突破/, '武器突破素材'],
  [/天赋培养素材|天赋培养/, '天赋培养素材'],
]);

// ---------------------------------------------------------------- 外部值（'external'）

/**
 * 观测枢里没有、只能编码的消耗。
 * **每一条都要人工核对过一次再改注释。**
 */
export const EXTERNAL_RESIN = Object.freeze({
  // 世界BOSS（无相 / 树 / 龙蜥 / 纯水精灵…）。
  // 核对方式：游戏内「讨伐」界面看一次。核对后把 verified 改成 true。
  WORLD_BOSS: { resin: 40, verified: false, note: '观测枢 enemy 词条无消耗字段，待游戏内核对' },
  // 地脉衍出（经验花 / 摩拉花）。观测枢「地脉衍出」词条里两者都出现过 *20，
  // 但那条词条同时列了筛选器选项，无法确定实际值，故标外部。
  LEYLINE: { resin: 20, verified: false, note: '观测枢该词条含筛选器选项，实际值待核对' },
});

/** 每日自然恢复的树脂。观测枢没有此数据。 */
export const DAILY_RESIN = { value: 160, verified: false, note: '待游戏内核对' };

/**
 * 突破各阶段的摩拉消耗。
 *
 * 为什么必须编码：观测枢**只在「1级属性/突破所需材料」那一段**给了摩拉，
 * 而且那个数是 1→90 的 **2,092,530 —— 含升级摩拉**（已实测：整个「角色突破」
 * 模块里「摩拉」只出现 1 次）。分阶段材料有、分阶段摩拉没有。
 *
 * 自校验（selftest 会断言）：六段合计 = 420,000；
 * 观测枢总计 2,092,530 − 420,000 = 1,672,530，即 1→90 的升级摩拉。
 * 两个数能对上，说明这张表没写错。
 */
export const ASCENSION_MORA = Object.freeze({
  20: 20000, 40: 40000, 50: 60000, 60: 80000, 70: 100000, 80: 120000,
});

/** 观测枢给出的 1→90 摩拉总计（含升级）。用来和上面那张表交叉校验。 */
export const OBC_TOTAL_MORA_1_TO_90 = 2092530;

// ---------------------------------------------------------------- 分类

/** 不消耗树脂、但消耗时间的获取方式。 */
const NON_RESIN = Object.freeze([
  [/采集|采摘|尘歌壶种植|种植/, 'GATHER'],
  [/购买|商店|兑换|委托|活动|任务|奖励发放/, 'OTHER'],
  [/炼制|合成|锻造|炼金/, 'CRAFT'],
]);

/**
 * 给一件材料的「获得方式」文本分类。
 *
 * 一件材料常常**同时**列出多条路子。例如「燃愿玛瑙」的原文是：
 *   【75级以上】爆炎树、古岩龙蜥…挑战奖励   ＋   【「伏龙树」之底】追忆：摇撼山岳之龙Ⅲ
 * 前者是世界BOSS（40），后者是周本（60）。
 *
 * 所以不能「匹配到第一个就返回」—— 那会把燃愿玛瑙判成周本材料。正确做法是
 * **收集全部候选，取树脂最低的那条**（玩家当然挑便宜的刷），并把其余列为备选。
 *
 * @param {string} acquireText 观测枢材料词条的「获得方式」原文
 * @returns {{kind:string, resin:number|null, costSource:'obc'|'external'|null,
 *            note:string, alternatives:Array<{kind:string,resin:number|null,costSource:string|null}>}}
 */
export function classifyAcquisition(acquireText) {
  const t = String(acquireText || '').replace(/\s+/g, ' ').trim();
  if (!t) {
    return { kind: 'UNKNOWN', resin: null, costSource: null, note: '观测枢未提供获得方式', alternatives: [] };
  }

  const cands = [];

  // ① 秘境类：文本点名了秘境类型 → 用观测枢官方的秘境消耗表
  for (const [re, type] of DOMAIN_TYPE_KEYWORDS) {
    if (re.test(t)) {
      const resin = DOMAIN_RESIN_BY_TYPE[type];
      if (resin != null) {
        cands.push({
          kind: type === '征讨领域' ? 'WEEKLY' : 'DOMAIN',
          resin, costSource: 'obc', note: `秘境类型：${type}`,
        });
      }
    }
  }

  // ② 地脉衍出
  if (/地脉衍出|藏金之花|启示之花/.test(t)) {
    const e = EXTERNAL_RESIN.LEYLINE;
    cands.push({ kind: 'LEYLINE', resin: e.resin, costSource: 'external', note: e.note });
  }

  // ③ 世界BOSS：挑战奖励，但文本里没有出现秘境类型
  if (/挑战奖励|首领/.test(t)) {
    const e = EXTERNAL_RESIN.WORLD_BOSS;
    cands.push({ kind: 'WORLD_BOSS', resin: e.resin, costSource: 'external', note: e.note });
  }

  // ④ 非树脂途径（采集 / 购买 / 合成）
  for (const [re, kind] of NON_RESIN) {
    if (re.test(t)) cands.push({ kind, resin: null, costSource: null, note: '不消耗树脂' });
  }

  if (!cands.length) {
    return { kind: 'UNKNOWN', resin: null, costSource: null, note: '未能判断获取途径', alternatives: [] };
  }

  // 取树脂最低的一条当主路（null 视为「不耗树脂」，但要排在树脂值之后 ——
  // 因为「能采集到」不等于「不费时间」，用它当主路会把整份规划算得过于乐观）。
  const withResin = cands.filter((c) => c.resin != null);
  const pool = withResin.length ? withResin : cands;
  pool.sort((a, b) => (a.resin ?? 0) - (b.resin ?? 0));
  const best = pool[0];

  return {
    ...best,
    alternatives: cands.filter((c) => c !== best),
  };
}

/**
 * 把「这一件材料要多少个」折算成树脂。
 *
 * 注意：**不做「每趟出几个」的假设**。观测枢没有掉落数量数据，瞎猜一个
 * 「每趟 2.5 个」会让整个规划看起来精确、实际是假的。
 *
 * 所以这里按「每次产出 1 个」算 —— 这是**最坏情况**，得到的是树脂的**上界**
 * （实际一趟通常出更多，趟数更少，树脂更少）。字段名就叫 upperBound，
 * 不要写成 lowerBound：那会把方向说反。
 *
 * @returns {{runs:number|null, resin:number|null, upperBound:boolean, costSource:string|null, note:string}}
 */
export function runsFor(amount, cls) {
  if (cls.resin == null) {
    return { runs: null, resin: null, upperBound: false, costSource: null, note: cls.note };
  }
  const n = Math.max(0, Math.ceil(Number(amount) || 0));
  return {
    runs: n,
    resin: n * cls.resin,
    // 按每次出 1 个算 → 趟数最多 → 树脂是上界
    upperBound: true,
    costSource: cls.costSource,
    note: `${cls.note}；按每次产出 1 个计，实际产出更多、消耗更低，此为**上界**`,
  };
}

/** 把树脂换算成天数（向上取一位小数）。 */
export function daysFor(resin) {
  const r = Number(resin) || 0;
  if (r <= 0) return 0;
  return Math.round((r / DAILY_RESIN.value) * 10) / 10;
}

/** 汇总口径，响应里带出去，便于事后追溯用的是哪版规则。 */
export function rulesSummary() {
  return {
    version: RULES_VERSION,
    dailyResin: DAILY_RESIN.value,
    domainTypes: { ...DOMAIN_RESIN_BY_TYPE },
    external: Object.fromEntries(Object.entries(EXTERNAL_RESIN).map(([k, v]) => [k, v.resin])),
    unverified: [
      ...Object.entries(EXTERNAL_RESIN).filter(([, v]) => !v.verified).map(([k]) => k),
      ...(DAILY_RESIN.verified ? [] : ['DAILY_RESIN']),
    ],
  };
}
