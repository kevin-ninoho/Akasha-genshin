// 技能注册表。
//
// ── 为什么需要它 ────────────────────────────────────────────────────
// 技能原先硬编码在 blocks.mjs 里：一个 RULES 数组管意图，一串
// `if (intent === 'build' && routed.intents.some(...)) continue` 管冲突。
// 加一个没问题。**加到第四个就开始互相打架**：
//   · 冲突靠手写 if，加一个技能要回头检查所有已有技能
//   · 优先级靠数组顺序，调一个技能的位置可能悄悄改变别的技能行为
//   · 新技能必须改 blocks.mjs —— 那是 700 行的公共文件，改一次怕碰坏别处
//
// 这个文件把那三件事变成**数据**：
//   priority   数字优先级，越大越优先（不再依赖数组顺序）
//   excludes   声明「我命中时压掉谁」（不再手写 if）
//   category   分类，喂给客户端画技能面板
//
// ── 为什么本文件不 import blocks.mjs ────────────────────────────────
// blocks.mjs 要用注册表来路由，注册表要用 blocks.mjs 的 builder —— 直接互相
// import 就是循环依赖。所以这里**只放元数据与路由**，builder 由调用方通过
// handlers 传进来（见 build()）。新增的独立技能可以自带 run()，连 handlers 都不用。

/**
 * 分类。客户端技能面板按这个分组，顺序即展示顺序。
 *
 * 措辞原则（写这类文案时的约定，改之前先读）：
 *   · **不要写成「查询/搜索/资料查找」** —— 那是把它当搜索框。它的价值是
 *     「把散落在官方原典里的东西，变成能直接用的结论」。
 *   · 每个 desc 里至少给一个**具体数字或具体动作**，不写正确但空洞的话
 *     （「提供丰富资料」这种一句都不要）。
 *   · 能承诺的只有「可回溯」——不说「最全」「权威」这类没法自证的词。
 */
export const CATEGORIES = [
  { id: 'data', label: '原典档案', icon: '📖', desc: '16,870 条官方词条 · 128,828 行剧情 · 6,951 条语音，逐条可回溯原文' },
  { id: 'growth', label: '养成规划', icon: '📈', desc: '按你这个号的现状算，不是通用攻略' },
  { id: 'lore', label: '考据分析', icon: '🔍', desc: '对着全量原始数据算，不靠印象' },
  { id: 'create', label: '内容创作', icon: '🎨', desc: '从设定到成片' },
  { id: 'export', label: '导出交付', icon: '📤', desc: '把结论变成能直接用的文件与素材' },
];

/**
 * 全部技能。
 *
 * status：
 *   ready   —— 现在就能用
 *   beta    —— 能用但数据或效果还不稳
 *   planned —— 目录里先列出来，让用户知道**这东西能干什么**（还没做）
 *
 * 之所以把 planned 也列进目录：客户端的诉求是「界面太干净，用户不知道能干嘛」。
 * 一份画着未来能力的目录，比空白页有用；但必须**明确标注**是计划，
 * 不能让人以为点了就能用 —— 那是骗人。
 */
// ── excludes 的方向（写错一次，记在这里）─────────────────────────────
// excludes 的语义是「**我命中时压掉谁**」，不是「我被谁压掉」。
// 旧代码里那条规则是反的读法：
//     if (intent === 'build' && intents.some(i => weapon|artifact|ascension|plan)) continue;
// 意思是「weapon/artifact/ascension/plan 任何一个在场，就压掉 build」——
// 所以要给**那四个**加 excludes: ['build']，而不是给 build 加。
// 第一次写反了，v1-blocks-smoke 立刻抓到（「问圣遗物时只出圣遗物表，不出武器表」）。
// 这就是为什么那 122 条断言值钱。
export const SKILLS = [
  // ────────────────────────────────────────────── 资料检索（6 个已就绪）
  {
    id: 'profile', label: '角色档案', category: 'data', icon: '🪪', status: 'ready',
    description: '一个角色的全部官方设定 —— 元素、命座、所属、CV、生日、定位，每条回链观测枢',
    examples: ['胡桃是谁', '介绍一下钟离', '甘雨的档案'],
    patterns: [/是谁/, /什么人/, /什么角色/, /介绍/, /资料/, /档案/, /基本信息/, /这个人/, /什么来历/, /角色卡/, /图鉴/],
    priority: 60, excludes: [], needsCharacter: true, kind: 'stat-table', legacy: 'profile',
  },
  {
    id: 'art', label: '立绘与形象', category: 'data', icon: '🖼️', status: 'ready',
    description: '官方立绘、头像、图标原画，多尺寸直接取用',
    examples: ['胡桃长什么样', '看看钟离的立绘'],
    patterns: [/立绘/, /头像/, /图标/, /画像/, /原画/, /长什么样/, /长啥样/, /什么样子/, /什么模样/, /形象/, /外观/, /图片/, /照片/, /截图/, /看看.*样/],
    priority: 60, excludes: [], needsCharacter: true, kind: 'image', legacy: 'art',
  },
  {
    id: 'voice', label: '语音台词', category: 'data', icon: '🎙️', status: 'ready',
    description: '按场景分组归类的全量语音，中日双语',
    examples: ['胡桃的语音', '钟离说过什么'],
    patterns: [/语音/, /配音/, /声优/, /说过什么/, /说过啥/, /口头禅/, /台词/, /\bcv\b/i],
    priority: 60, excludes: [], needsCharacter: true, kind: 'voice-list', legacy: 'voice',
  },
  {
    id: 'relation', label: '人物关系', category: 'data', icon: '🕸️', status: 'ready',
    description: '从 1,234 条官方关系边还原角色网络',
    examples: ['胡桃和谁有关系', '钟离的亲友'],
    patterns: [/关系/, /和谁/, /跟谁/, /认识谁/, /亲友/, /师徒/, /同伴/, /羁绊/, /交集/, /关联/, /联系/],
    priority: 60, excludes: [], needsCharacter: true, kind: 'relation-graph', legacy: 'relation',
  },
  {
    // 注意：**没有**把「列表」和「观测枢图鉴」拆成两个技能。
    // 旧实现里它们是同一个 list 意图，buildList 内部按抄 extractObcKind 决定查哪边；
    // 拆开会让 routeIntents 的返回值多出一个 id，破坏既有契约（v1-blocks-smoke 断言）。
    // 技能边界应当照**用户怎么问**划，不是照代码怎么组织划 —— 用户问「有哪些敌人」
    // 和「有哪些角色」是同一类问题。
    id: 'list', label: '列表与图鉴', category: 'data', icon: '📋', status: 'ready',
    description: '16,870 条词条任意切面：按元素、地区、武器、星级盘点',
    examples: ['有哪些五星火系角色', '稻妻有哪些世界任务', '一共有多少角色'],
    patterns: [/有哪些/, /都有谁/, /一共.*(多少|几)/, /多少个/, /多少位/, /多少把/, /列表/, /全部/, /所有/, /列举/, /盘点/, /清单/, /图鉴/, /词条/],
    priority: 40, excludes: [], needsCharacter: false, kind: 'list', legacy: 'list',
  },

  // ────────────────────────────────────────────── 养成规划
  {
    id: 'plan', label: '练度规划', category: 'growth', icon: '📈', status: 'ready',
    description: '输入你号的现状，输出还差什么、要刷多少、几天能成',
    examples: ['胡桃80级练到90要什么', '帮我规划一下', '可莉和胡桃先练谁'],
    patterns: [
      /培养计划/, /培养规划/, /养成计划/, /练度/, /规划/, /计划/,
      /练到/, /升到/, /养到/, /拉到/,
      /要多少(树脂|摩拉|体力|天)/, /多少(树脂|摩拉)/, /够不够(练|养|升)/,
      /先练/, /该练谁/, /练哪个/, /先养谁/,
      /多久能/, /几天能/, /要刷多久/,
    ],
    priority: 100, excludes: ['ascension', 'build'], needsCharacter: true, kind: 'plan', legacy: 'plan',
  },
  {
    id: 'ascension', label: '突破材料表', category: 'growth', icon: '🧪', status: 'ready',
    description: '一个角色 1→90 的完整材料清单，含获取途径与官方出处',
    examples: ['胡桃的突破材料', '钟离升级要什么'],
    patterns: [/突破材料/, /培养材料/, /升级材料/, /进阶材料/, /要什么材料/, /需要什么材料/, /材料.*(刷|打|获取|在哪)/, /怎么突破/, /突破要/],
    priority: 50, excludes: ['build'], needsCharacter: true, kind: 'ascension', legacy: 'ascension',
  },
  {
    id: 'weapon', label: '武器推荐', category: 'growth', icon: '⚔️', status: 'ready',
    description: '官方攻略的武器推荐与推荐理由',
    examples: ['胡桃带什么武器', '钟离用什么剑'],
    patterns: [/武器/, /用什么剑/, /用什么枪/, /带什么/, /适合.*(武器|装备)/],
    priority: 70, excludes: ['build'], needsCharacter: true, kind: 'stat-table', legacy: 'weapon',
  },
  {
    id: 'artifact', label: '圣遗物推荐', category: 'growth', icon: '💠', status: 'ready',
    description: '套装搭配与主副词条目标',
    examples: ['胡桃带什么圣遗物', '钟离的圣遗物词条'],
    patterns: [/圣遗物/, /套装/, /词条/, /沙漏/, /杯子/, /头冠/],
    priority: 70, excludes: ['build'], needsCharacter: true, kind: 'stat-table', legacy: 'artifact',
  },
  {
    id: 'talent', label: '天赋与倍率', category: 'growth', icon: '✨', status: 'ready',
    description: '天赋描述 + LV1~LV13 完整倍率表',
    examples: ['胡桃的天赋', '钟离的元素爆发倍率'],
    patterns: [/天赋/, /技能/, /倍率/, /元素战技/, /元素爆发/, /普通攻击/, /普攻/, /\be技能\b/i, /\bq技能\b/i],
    priority: 60, excludes: [], needsCharacter: true, kind: 'talent', legacy: 'talent',
  },
  {
    id: 'constellation', label: '命之座', category: 'growth', icon: '🌟', status: 'ready',
    description: '六个命座的名称与效果，逐条可查',
    examples: ['胡桃的命座', '钟离几命'],
    patterns: [/命座/, /命之座/, /几命/, /满命/, /一命/, /二命/, /六命/],
    priority: 60, excludes: [], needsCharacter: true, kind: 'constellation', legacy: 'constellation',
  },
  {
    id: 'build', label: '综合配装', category: 'growth', icon: '🎯', status: 'ready',
    description: '武器 + 圣遗物 + 配队，一次给全',
    examples: ['胡桃怎么配装', '钟离怎么练'],
    patterns: [/配装/, /培养/, /怎么练/, /配队/, /阵容/, /搭配/, /推荐/, /面板/, /数值/, /属性/],
    priority: 30, excludes: [], needsCharacter: true, kind: 'stat-table', legacy: 'build',
  },
  {
    id: 'material-source', label: '材料获取路径', category: 'growth', icon: '🗺️', status: 'planned',
    description: '材料获取路径与反向索引：刷这一个，能同时养哪几个角色',
    examples: ['霓裳花在哪采', '未熟之玉打什么', '刷燃愿玛瑙能养谁'],
    patterns: [], priority: 0, excludes: [], needsCharacter: false, kind: 'list',
  },
  {
    id: 'gacha-cost', label: '抽卡成本测算', category: 'growth', icon: '🎲', status: 'planned',
    description: '按官方公布概率算还差多少抽，需先核对数值',
    examples: ['我还差多少抽能出胡桃', '攒到保底要多久'],
    patterns: [], priority: 0, excludes: [], needsCharacter: false, kind: 'list',
  },

  // ────────────────────────────────────────────── 考据分析
  {
    id: 'stats', label: '全量数据统计', category: 'lore', icon: '📊', status: 'ready',
    description: '台词量、出场频次、章节分布 —— 对着 128,828 行原始数据算',
    examples: ['谁台词最多', '胡桃有多少句台词', '统计一下各角色台词量'],
    patterns: [/谁.*(台词|话).*最多/, /台词.*(最多|排行|统计|排名)/, /多少句(台词|话)/, /出场.*(次数|最多|排行)/, /统计.*(角色|台词|语音|数据)/, /数据.*(统计|排行)/],
    priority: 80, excludes: ['list'], needsCharacter: false, kind: 'stat-table', run: 'stats',
  },
  {
    id: 'timeline', label: '出场时间线', category: 'lore', icon: '🕰️', status: 'planned',
    description: '一个角色在哪些章节、哪些任务出场，按剧情顺序排',
    examples: ['胡桃在哪些章节出现过', '钟离的剧情顺序'],
    patterns: [], priority: 0, excludes: [], needsCharacter: true, kind: 'timeline',
  },
  {
    id: 'consistency', label: '设定一致性核对', category: 'lore', icon: '🔎', status: 'planned',
    description: '一个设定在哪些地方被提到过，逐条带官方出处',
    examples: ['「魔神战争」在哪些地方提过', '核对一下这个设定'],
    patterns: [], priority: 0, excludes: [], needsCharacter: false, kind: 'list',
  },
  {
    id: 'charts', label: '数据可视化出图', category: 'lore', icon: '📉', status: 'planned',
    description: '统计结果直接出成 1920×1080 成品图，能直接放进视频',
    examples: ['出一张台词量排行图', '把倍率表做成图'],
    patterns: [], priority: 0, excludes: [], needsCharacter: false, kind: 'image',
  },
  {
    // 「引用出处导出」放在「导出与效率」而不是「考据」：
    // 分类要照**用户拿到什么**划 —— 考据党要的是分析结果，导出要的是一份能贴进文章的文件。
    id: 'quote-export', label: '引用出处导出', category: 'export', icon: '📑', status: 'planned',
    description: '结论连官方出处一起导成表格 / CSV，写文章直接引用',
    examples: ['把这个列表导出来', '导出成表格'],
    patterns: [], priority: 0, excludes: [], needsCharacter: false, kind: 'list',
  },
  {
    id: 'material-pack', label: '素材打包下载', category: 'export', icon: '📦', status: 'planned',
    description: '按角色或主题把立绘、图标、语音打包下载',
    examples: ['把胡桃的立绘打包', '下载这套素材'],
    patterns: [], priority: 0, excludes: [], needsCharacter: true, kind: 'list',
  },
  {
    id: 'doc-export', label: '导出文档', category: 'export', icon: '📄', status: 'planned',
    description: '把一次对话的结论整理成 Word / PDF',
    examples: ['把刚才这些整理成文档', '导出成 Word'],
    patterns: [], priority: 0, excludes: [], needsCharacter: false, kind: 'list',
  },

  // ────────────────────────────────────────────── 内容创作（多为外部算力）
  {
    id: 'remix-image', label: '二创出图', category: 'create', icon: '🎨', status: 'beta',
    description: '角色改图、换装、参考图生图，本机出图不过云端',
    examples: ['给胡桃换身衣服', '照这张图的感觉画'],
    patterns: [/换装/, /换身/, /改图/, /生图/, /画一[张个]/, /二创.*图/],
    priority: 90, excludes: [], needsCharacter: true, kind: 'image', external: 'comfy',
  },
  {
    id: 'remix-video', label: '立绘动起来', category: 'create', icon: '🎬', status: 'beta',
    description: '图生视频、多镜头短片；可用本机算力，也可接自己的',
    examples: ['让这张立绘动 5 秒', '做一段三个镜头的短片'],
    patterns: [/动起来/, /做个视频/, /生成视频/, /短片/, /动[画图]/],
    priority: 90, excludes: [], needsCharacter: false, kind: 'video-scenes', external: 'seedance',
  },
  {
    id: 'writing', label: '同人写作辅助', category: 'create', icon: '✍️', status: 'planned',
    description: '按角色语气写作 —— 风格样本是 128,828 行真实台词',
    examples: ['按胡桃的语气写一段', '写个同人开头'],
    patterns: [], priority: 0, excludes: [], needsCharacter: true, kind: 'list',
  },
  {
    id: 'script', label: '视频脚本分镜', category: 'create', icon: '🎞️', status: 'planned',
    description: '按剧情素材出分镜脚本，带台词与画面提示',
    examples: ['给这期视频写分镜', '写个 30 秒脚本'],
    patterns: [], priority: 0, excludes: [], needsCharacter: false, kind: 'list',
  },

  // ────────────────────────────────────────────── 导出与效率
  {
    id: 'video', label: 'PV 与过场动画', category: 'data', icon: '🎥', status: 'ready',
    description: '角色 PV、版本 PV、过场动画，支持选段导出',
    examples: ['胡桃的PV', '有哪些过场动画'],
    patterns: [/\bpv\b/i, /视频/, /预告/, /过场动画/],
    priority: 55, excludes: [], needsCharacter: false, kind: 'video-scenes', legacy: 'video',
  },
];

// ------------------------------------------------------------------ 路由

/**
 * 按 id 取技能。找不到返回 null。
 *
 * 给「用户在界面上明确选了一个技能」这条路径用 —— 那时不该再靠正则猜，
 * 用户已经说了要哪个。
 */
export function skillById(id) {
  if (!id) return null;
  return SKILLS.find((s) => s.id === String(id)) || null;
}

/**
 * 哪个技能被这句话命中。按 priority 降序返回。
 *
 * @param {string} question
 * @param {string} [pickedSkillId] 用户在界面上**明确选的**技能。
 *   它排在最前且不受 priority 影响 —— 用户点了它才来问的，不该再靠正则猜。
 *   没有它时纯靠 patterns 路由（老路径）。
 * @returns {Array<{skill:object, matched:string}>}
 */
export function matchSkills(question, pickedSkillId) {
  const s = String(question || '');
  const hit = [];
  const seen = new Set();

  const picked = skillById(pickedSkillId);
  if (picked) {
    hit.push({ skill: picked, matched: '手动选择' });
    seen.add(picked.id);
  }

  for (const sk of SKILLS) {
    if (seen.has(sk.id)) continue;
    if (!sk.patterns || !sk.patterns.length) continue;   // planned 的还没接
    for (const re of sk.patterns) {
      let m = null;
      try { m = s.match(re); } catch { continue; }        // 正则写坏了不该拖垮整体
      if (m) { hit.push({ skill: sk, matched: m[0] }); break; }
    }
  }
  // 手动选的那个已经排在最前，别让排序把它挤下去
  const rest = hit.filter((h) => h.skill.id !== (picked && picked.id));
  rest.sort((a, b) => (b.skill.priority || 0) - (a.skill.priority || 0));
  return picked ? [hit[0], ...rest] : rest;
}

/**
 * 在命中集合上应用 excludes：被更高优先级的技能点名压掉的，剔除。
 * 这就是把原先手写的 `if (intent === 'build' && ...) continue` 变成数据。
 *
 * @param {Array} hits
 * @param {string} [pickedSkillId] 用户手动选的技能 —— **它永远不被压掉**。
 *   他是明确点了这个才来问的；被别的技能用 excludes 挤掉就没道理了。
 */
export function resolveSkills(hits, pickedSkillId) {
  const picked = pickedSkillId ? String(pickedSkillId) : '';
  const dead = new Set();
  for (const h of hits) {
    if (picked && h.skill.id === picked) continue;   // 手动选的不参与「压掉别人」也不被别人压
    for (const id of h.skill.excludes || []) dead.add(id);
  }
  // 保护：一个技能被压掉的前提是「压它的那个」优先级更高。
  // 否则两个技能互相 excludes 会让两边都不出块（空洞）。
  return hits.filter((h) => {
    if (picked && h.skill.id === picked) return true;
    return !dead.has(h.skill.id) || h.skill.priority >= maxExcluderPriority(h.skill.id, hits);
  });
}

function maxExcluderPriority(id, hits) {
  let max = -Infinity;
  for (const h of hits) {
    if ((h.skill.excludes || []).includes(id)) max = Math.max(max, h.skill.priority || 0);
  }
  return max;
}

/**
 * 执行命中的技能，产出块数组。
 *
 * @param {object} ctx  { v1, question, char, entities, roster, videoIndex }
 * @param {object} handlers  legacy 技能的处理函数表（由 blocks.mjs 传进来，避免循环依赖）
 * @param {object} modules   新式技能：id → run(ctx) => block | null
 */
export function buildFromSkills(hits, ctx, handlers = {}, modules = {}) {
  const out = [];
  for (const { skill, matched } of hits) {
    let block = null;
    try {
      if (typeof modules[skill.id] === 'function') block = modules[skill.id](ctx);
      else if (typeof handlers[skill.legacy] === 'function') block = handlers[skill.legacy](ctx);
    } catch { block = null; }   // 一个技能挂了不该影响其它技能
    if (!block) continue;
    block.skill = { id: skill.id, label: skill.label, category: skill.category };
    block.reason = block.reason || matched;
    // 同一回合里已经有图时，不要再塞一张重复的
    if (block.kind === 'image' && out.some((b) => b.kind === 'image')) continue;
    out.push(block);
  }
  return out;
}

/** 需要「一个具体角色」的技能 id 集合。 */
export function needsCharacterSet(hits) {
  return hits.some((h) => h.skill.needsCharacter);
}

// ------------------------------------------------------------------ 目录

/** 喂给客户端画技能面板。不含 patterns/run 这些内部字段。 */
export function skillCatalog() {
  return {
    categories: CATEGORIES.map((c) => ({
      ...c,
      skills: SKILLS.filter((s) => s.category === c.id).map((s) => ({
        id: s.id, label: s.label, icon: s.icon, status: s.status,
        description: s.description, examples: s.examples || [],
        external: s.external || null,
      })),
    })),
    counts: {
      ready: SKILLS.filter((s) => s.status === 'ready').length,
      beta: SKILLS.filter((s) => s.status === 'beta').length,
      planned: SKILLS.filter((s) => s.status === 'planned').length,
    },
  };
}
