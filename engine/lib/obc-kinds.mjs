// 观测枢分类（kind）的唯一事实来源。
//
// ── 为什么要把这套知识收到一处 ──────────────────────────────────────
// 「观测枢有哪些分类、中文叫什么、哪些主库没有、什么问法该放开哪个域、
//  哪些分类有本地图标、列表块该列哪个分类」原先是**散着写的**：
//   · lib/obc.mjs               kind → 中文标签
//   · lib/obc-search.mjs        OBC_ONLY_KINDS / OBC_OVERLAP_KINDS / OBC_DOMAIN_TRIGGERS
//   · lib/blocks.mjs            问句 → kind（列表块），以及**另一份** kind → 中文
//   · chat/retrieve.mjs         gearAsk 正则（配装 / 图鉴问法）
//   · lib/v1-data.mjs           取图时要放的 kind 白名单
//   · web/dev.html              前端自己那份兜底标签
//   · gen-suite/tools/obc-import.mjs、obc-fix-kinds.mjs —— menu_id → kind（两份一模一样）
// 2026-10-13 补采后 menu 从 7 个涨到 53 个、条目从 4425 涨到 16869，
// 每加一个分类要在 7 处同步：漏一处就是界面上一串英文 slug（`teapot 2398`），
// 或者整个域搜不到（「钟离的角色PV」在库里有 252 条却进不了候选）。
// 现在只有这一张表 + 这一组触发词，别处一律 import。
//
// ── 加新分类时的检查单（chat/selftest.mjs 会逐条验） ────────────────
//   ① OBC_KIND_DEFS 加一行（kind + label + coverage），库里有 menu 就补 menuIds；
//   ② 它有自己的问法 -> 在 OBC_DOMAIN_TRIGGERS 里挂上；
//   ③ 要出现在「列表块」里 -> 加 pick，并登记进 OBC_PICK_ORDER（顺序即优先级）；
//      要用本地图标 -> 加 icon；
//   ④ 采集侧给新 menu 分配 kind 时，走 OBC_MENU_TO_KIND。

/**
 * 分类覆盖度（决定「默认搜不搜」）：
 *   only    —— 主库完全没有（武器/圣遗物/材料/食物/敌人…），问到配装与图鉴就该给
 *   overlap —— 主库已经有了（角色/书籍/任务…），只在明确需要时才补，免得稀释资料
 *   gated   —— 默认不搜；问题命中它的触发词才放开（见 OBC_DOMAIN_TRIGGERS）
 *
 * ⚠ only / overlap 两张白名单是**跟预算挂钩**的：候选池一涨，
 *   DEFAULT_BUDGET（6500 字）就会把真正相关的条目挤出去。
 *   所以新增分类默认是 gated —— 要进 only 必须想清楚预算。
 */
export const OBC_KIND_DEFS = [
  // ── 最初的 7 类 ──
  // 注意：character 没有 pick —— 「有哪些角色」走的是主库角色表（extractCharacterFilter），
  // 观测枢的角色词条是同一批角色，列出来只会重复。
  { kind: 'character', label: '角色', menuIds: [25], coverage: 'overlap' },
  { kind: 'weapon', label: '武器', menuIds: [5], coverage: 'only', icon: true, pick: /武器/ },
  { kind: 'artifact', label: '圣遗物', menuIds: [218], coverage: 'only', icon: true, pick: /圣遗物/ },
  { kind: 'book', label: '书籍', menuIds: [68], coverage: 'overlap', pick: /书籍|书/ },
  { kind: 'item', label: '材料道具', menuIds: [13], coverage: 'only' },
  { kind: 'enemy', label: '敌人', menuIds: [6], coverage: 'only', icon: true, pick: /敌人|怪物|boss|首领/i },
  { kind: 'food', label: '食物', menuIds: [21], coverage: 'only' },
  { kind: 'quest', label: '任务', menuIds: [43], coverage: 'overlap', pick: /任务/ },
  { kind: 'domain', label: '秘境', menuIds: [54], coverage: 'only' },
  { kind: 'npc', label: 'NPC', menuIds: [20], coverage: 'overlap', pick: /npc/i },
  { kind: 'region', label: '区域', menuIds: [7], coverage: 'overlap' },
  { kind: 'abyss', label: '深境螺旋', menuIds: [65], coverage: 'only' },
  { kind: 'namecard', label: '名片', menuIds: [109], coverage: 'only' },
  { kind: 'cutscene', label: '过场动画', menuIds: [81], coverage: 'overlap' },
  { kind: 'event', label: '活动', menuIds: [105], coverage: 'overlap' },
  { kind: 'animal', label: '动物', menuIds: [49], coverage: 'gated' },
  { kind: 'furnishing', label: '洞天摆设', menuIds: [0], coverage: 'only' },
  { kind: 'lore', label: '观测·考据', menuIds: [62], coverage: 'gated' },
  { kind: 'adventure', label: '冒险家协会', menuIds: [55], coverage: 'gated' },
  // ── 2026-10-13 补采新增 ──
  { kind: 'teapot', label: '洞天', menuIds: [130], coverage: 'gated' },
  { kind: 'achievement', label: '成就', menuIds: [252], coverage: 'gated' },
  { kind: 'tutorial', label: '教程', menuIds: [227], coverage: 'gated' },
  { kind: 'map-text', label: '地图文本', menuIds: [251], coverage: 'gated' },
  { kind: 'tcg-action', label: '行动牌', menuIds: [234], coverage: 'gated' },
  { kind: 'tcg-card', label: '角色牌', menuIds: [233], coverage: 'gated' },
  { kind: 'tcg-monster', label: '魔物牌', menuIds: [235], coverage: 'gated' },
  { kind: 'tcg-tavern', label: '酒馆挑战', menuIds: [260], coverage: 'gated' },
  { kind: 'viewpoint', label: '观景点', menuIds: [253], coverage: 'gated' },
  { kind: 'char-video', label: '角色视频', menuIds: [212], coverage: 'gated' },
  { kind: 'other-video', label: '其他视频', menuIds: [238], coverage: 'gated' },
  { kind: 'char-trivia', label: '角色逸闻', menuIds: [261], coverage: 'gated' },
  { kind: 'outfit-part', label: '衣装部件', menuIds: [266], coverage: 'gated' },
  { kind: 'outfit-set', label: '衣装套装', menuIds: [264], coverage: 'gated' },
  { kind: 'makeup', label: '妆容', menuIds: [270], coverage: 'gated' },
  { kind: 'music', label: '千音雅集', menuIds: [256], coverage: 'gated' },
  { kind: 'emote', label: '互动表情与动作', menuIds: [268], coverage: 'gated' },
  { kind: 'glider', label: '风之翼', menuIds: [211], coverage: 'gated' },
  { kind: 'ost', label: '原神 OST', menuIds: [254], coverage: 'gated' },
  { kind: 'org', label: '组织', menuIds: [255], coverage: 'gated' },
  { kind: 'avatar', label: '头像', menuIds: [244], coverage: 'gated' },
  { kind: 'theater', label: '幻想真境剧诗', menuIds: [249], coverage: 'gated' },
  { kind: 'offering', label: '地区供奉&聚所', menuIds: [276], coverage: 'gated' },
  { kind: 'index', label: '各类索引', menuIds: [129], coverage: 'gated' },
  { kind: 'template', label: '典藏模板', menuIds: [265], coverage: 'gated' },
  { kind: 'item-2', label: '道具', menuIds: [267], coverage: 'gated' },
  { kind: 'event-2', label: '幽境危战', menuIds: [275], coverage: 'gated' },
  { kind: 'event-3', label: '「灰眸」', menuIds: [278], coverage: 'gated' },
  { kind: 'map-preview', label: '空月之歌', menuIds: [257], coverage: 'gated' },
  { kind: 'voice-showcase', label: '角色语音展示', menuIds: [84], coverage: 'gated' },
  { kind: 'guide', label: '观测者教学', menuIds: [1, 11, 215], coverage: 'gated' },
  { kind: 'observer-guide', label: '观测者·攻略', menuIds: [243], coverage: 'gated' },
  { kind: 'wiki-guide', label: 'WIKI 编辑教程', menuIds: [242], coverage: 'gated' },
];

/** kind → 中文标签（界面/回答块/客户端载荷共用这一份）。 */
export const OBC_KIND_LABEL = Object.fromEntries(OBC_KIND_DEFS.map((d) => [d.kind, d.label]));

/** 主库里完全没有、问到配装/图鉴就该给的分类。 */
export const OBC_ONLY_KINDS = OBC_KIND_DEFS.filter((d) => d.coverage === 'only').map((d) => d.kind);

/** 主库已经有的分类：只在明确需要时才补。 */
export const OBC_OVERLAP_KINDS = OBC_KIND_DEFS.filter((d) => d.coverage === 'overlap').map((d) => d.kind);

/** menu_id → kind（采集/导入侧按 menu 落 kind，与检索侧共用一张表）。 */
export const OBC_MENU_TO_KIND = Object.fromEntries(
  OBC_KIND_DEFS.flatMap((d) => (d.menuIds || []).map((m) => [m, d.kind])),
);

/**
 * 按问题内容「按需放开」的观测枢分类。
 *
 * ⚠ 为什么不能把 40 多种直接塞进 OBC_ONLY_KINDS：
 *   那是个跟预算挂钩的白名单。候选池一涨，DEFAULT_BUDGET 就会把真正相关的
 *   条目挤出去 —— 之前「木盾丘丘人」在库里有却检索不到，就是这么来的。
 * 所以做法是：问题里出现某个域的典型词，才放开那个域。候选池保持聚焦，覆盖率却上去了。
 */
export const OBC_DOMAIN_TRIGGERS = [
  { kinds: ['char-video', 'other-video'], re: /PV|角色演示|宣传片|拾枝杂谈|角色视频|演示视频|预告|CM短片/i },
  { kinds: ['lore'], re: /考据|设定|世界观|编年|文献|史料|背景故事/ },
  { kinds: ['achievement'], re: /成就|奖杯|达成/ },
  { kinds: ['tcg-action', 'tcg-card', 'tcg-monster', 'tcg-tavern'], re: /七圣召唤|行动牌|角色牌|魔物牌|酒馆挑战|牌组|卡牌|卡面/ },
  { kinds: ['teapot'], re: /洞天|尘歌壶|摆设|家具|宅邸|壶灵/ },
  { kinds: ['cutscene'], re: /过场|剧情动画|CG|短片/ },
  { kinds: ['viewpoint'], re: /观景点|景点|打卡/ },
  { kinds: ['item', 'item-2'], re: /材料|道具|掉落|突破素材|采集|合成|兑换/ },
  { kinds: ['tutorial'], re: /教程|机制|怎么玩|新手/ },
  { kinds: ['avatar', 'namecard'], re: /头像|名片|资料页/ },
  { kinds: ['outfit-part', 'outfit-set', 'glider'], re: /衣装|装扮|时装|风之翼|翅膀/ },
  { kinds: ['ost', 'music'], re: /OST|原声|音乐|千音|曲目/ },
  { kinds: ['event', 'event-2', 'event-3'], re: /限时活动|版本活动|活动奖励/ },
  { kinds: ['map-text', 'region'], re: /地图文本|地名|区域介绍/ },
  { kinds: ['char-trivia'], re: /逸闻|小故事|趣闻/ },
  { kinds: ['makeup', 'emote'], re: /妆容|表情|动作/ },
  // ── 2026-10-14 补齐「孤儿分类」 ──────────────────────────────────
  // 下面这 10 个分类原先 coverage 是 gated，却**没有任何触发词**，
  // 也就是结构上永远进不了候选 —— 库里有 428 条，任何问法都取不到。
  // validateObcKindTable() 现在会强制检查「每个 gated 分类至少属于一个触发词组」，
  // 正是为了让这种漏挂在测试里就暴露，而不是等用户发现搜不到。
  { kinds: ['adventure'], re: /冒险家协会|冒险家|协会委托|每日委托|凯瑟琳/ },
  { kinds: ['org'], re: /组织|阵营|势力介绍/ },
  { kinds: ['theater'], re: /幻想真境剧诗|剧诗|真境/ },
  { kinds: ['offering'], re: /供奉|聚所|忍冬之树|神樱树|流明石|神瞳|声望/ },
  { kinds: ['index'], re: /索引|合集|一览表/ },
  { kinds: ['template'], re: /典藏|模板/ },
  { kinds: ['observer-guide', 'guide', 'wiki-guide'], re: /攻略|指南|教学|编辑教程|词条编辑/ },
  { kinds: ['map-preview'], re: /空月之歌/ },
  // 这两个是加上断言后**断言自己抓出来的** —— 手工核对时漏了。
  // 说明"人眼扫一遍列表"靠不住，必须让机器验。
  { kinds: ['animal'], re: /动物|野猪|团雀|蝴蝶|青蛙|鱼群|狸猫|狐狸|宠物/ },
  { kinds: ['voice-showcase'], re: /语音展示|语音试听/ },
];

/**
 * 「配装 / 图鉴」问法：命中就放开 OBC_ONLY_KINDS。
 * 这几个词本身不指向某个具体域（「命座」「配队」「图鉴」在观测枢里没有对应 menu），
 * 但它们稳定意味着「用户在问主库没有的那些域」，所以单独一组。
 */
export const OBC_GEAR_ASK_RE = /武器|圣遗物|套装|词条|副词条|主词条|材料|突破|天赋材料|命座|配队|配装|怪物|敌人|周本|秘境|料理|食谱|图鉴/;

/**
 * 「列表块」用：问句 → 要列哪个 kind。
 * 顺序即优先级（「有哪些武器敌人」先命中 enemy）—— 顺序写在 OBC_PICK_ORDER 里，
 * 正则挂在对应对的 def 上，避免同一个 kind 的标签和问法分家。
 */
export const OBC_PICK_ORDER = ['enemy', 'weapon', 'artifact', 'quest', 'npc', 'book'];

export const OBC_PICK_KINDS = OBC_PICK_ORDER
  .map((k) => OBC_KIND_DEFS.find((d) => d.kind === k))
  .filter((d) => d && d.pick)
  .map((d) => ({ kind: d.kind, label: d.label, re: d.pick }));

/** 有本地图标（tools/fetch-obc-icons.mjs 抓、/v1/asset/obc/:id 供）的分类。 */
export const OBC_ICON_KINDS = OBC_KIND_DEFS.filter((d) => d.icon).map((d) => d.kind);

/** kind 的中文标签；没登记就退回 slug（界面上能立刻看出漏登记）。 */
export function obcLabel(kind) {
  return OBC_KIND_LABEL[kind] || String(kind || '');
}

/** menu_id → kind；没登记的 menu 返回 ''（调用方决定怎么兜底）。 */
export function obcKindOfMenu(menuId) {
  return OBC_MENU_TO_KIND[Number(menuId)] || '';
}

/**
 * 给定问题，返回该搜哪些 kind（基础白名单 + 命中的域）。
 * @param {string} question
 * @param {string[]} [base] 基础白名单，默认 OBC_ONLY_KINDS
 * @returns {string[]}
 */
export function pickObcKinds(question, base = OBC_ONLY_KINDS) {
  const q = String(question || '');
  const out = [...base];
  const seen = new Set(out);
  for (const t of OBC_DOMAIN_TRIGGERS) {
    if (!t.re.test(q)) continue;
    for (const k of t.kinds) {
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  return out;
}

/**
 * 表自身的自检：返回问题清单（空数组 = 全对）。
 * 不做 import 时抛错 —— 生产路径不该因为一张常量表把服务带崩，测试里显式调。
 *
 * @param {string[]} [dbKinds] 库里实际出现的 kind；给了就一并检查「有没有漏登记的标签」
 */
export function validateObcKindTable(dbKinds = []) {
  const problems = [];
  const seen = new Set();
  for (const d of OBC_KIND_DEFS) {
    if (!d.kind) problems.push('有一条 def 缺 kind');
    if (!d.label) problems.push(`${d.kind} 缺 label`);
    if (seen.has(d.kind)) problems.push(`kind 重复登记：${d.kind}`);
    seen.add(d.kind);
    if (!['only', 'overlap', 'gated'].includes(d.coverage)) problems.push(`${d.kind} 的 coverage 非法：${d.coverage}`);
    if (d.pick && !OBC_PICK_ORDER.includes(d.kind)) problems.push(`${d.kind} 有 pick 但不在 OBC_PICK_ORDER 里（列表块永远轮不到它）`);
  }
  for (const k of OBC_PICK_ORDER) {
    const d = OBC_KIND_DEFS.find((x) => x.kind === k);
    if (!d) problems.push(`OBC_PICK_ORDER 里的 ${k} 没登记`);
    else if (!d.pick) problems.push(`OBC_PICK_ORDER 里的 ${k} 没有 pick 正则`);
  }
  for (const t of OBC_DOMAIN_TRIGGERS) {
    if (!(t.re instanceof RegExp)) problems.push(`触发词组缺正则：${JSON.stringify(t.kinds)}`);
    for (const k of t.kinds) if (!seen.has(k)) problems.push(`触发词组引用了没登记的分类：${k}`);
  }
  // ⚠ 每个 gated 分类都必须至少属于一个触发词组 —— 否则它结构上永远进不了候选。
  //   2026-10-14 实测发现 10 个分类（adventure/org/theater/offering/index/template/
  //   observer-guide/guide/wiki-guide/map-preview，合计 428 条）既不在默认白名单、
  //   又没有触发词，任何问法都取不到。这条断言就是为了让那种漏挂在测试里就红，
  //   而不是等用户发现「库里有却搜不到」。
  const gatedCovered = new Set(OBC_DOMAIN_TRIGGERS.flatMap((t) => t.kinds));
  for (const d of OBC_KIND_DEFS) {
    if (d.coverage === 'gated' && !gatedCovered.has(d.kind)) {
      problems.push(`gated 分类「${d.kind}」没有任何触发词，结构上永远搜不到`);
    }
  }
  for (const k of [...OBC_ONLY_KINDS, ...OBC_OVERLAP_KINDS, ...OBC_ICON_KINDS]) {
    if (!seen.has(k)) problems.push(`派生白名单里有没登记的分类：${k}`);
  }
  for (const m of Object.keys(OBC_MENU_TO_KIND)) {
    if (!Number.isFinite(Number(m))) problems.push(`menu_id 不是数字：${m}`);
  }
  for (const k of dbKinds) {
    if (!OBC_KIND_LABEL[k]) problems.push(`库里的 kind「${k}」没有中文标签登记（界面会显示英文 slug）`);
  }
  return problems;
}
