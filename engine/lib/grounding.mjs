// 「不编造」的两道纯函数护栏。
//
// 为什么单独一个模块、而不是写在 serve-client.mjs 里：
//   这两件事的判定逻辑需要能**脱离 HTTP 单独测**（喂一段人造的幻觉回答，
//   断言审计能标出来），塞在路由里就只能端到端测，回归成本太高。
//
// 两道护栏分工：
//   assessRetrieval —— 生成**之前**。检索为空就根本不该调模型。
//   auditAnswer     —— 生成**之后**。逐句核对引用是否指向真实来源。
//
// 关于「库外问题」的实测结论（别想当然）：
//   试过用「问题词面与资料的覆盖度」来判定库外，**分不开** ——
//   库内问题覆盖度 0.5~1.0，库外 0.0~1.0，完全重叠。
//   原因是中文二元分词不切词，只去停用词，词面重合的信号很脏。
//   真正有判别力的是「锚点」：库外问题 10/10 无锚点，库内 9/13 有锚点。
//   但召回不够（「往生堂是什么」这种内容在库里却没有具名条目），
//   所以锚点只用来标「依据较弱」，硬拒答只留给「一条都没检索到」。

/**
 * 生成前的检索闸门。
 * @param {{sources?:Array, anchors?:Array, coverage?:object}} p
 *   coverage 来自 chat/retrieve.mjs 的检索覆盖回报（识别到哪些条目、哪些没取到资料）。
 */
export function assessRetrieval({ sources = [], anchors = [], coverage = null } = {}) {
  if (!sources.length) {
    // 识别到库里的条目、却一条资料都没取到 —— **不能硬拒答**。
    // 「问题里点名了库里的条目」本身就说明这不是库外问题，只是这个条目没有可取的正文：
    // 实测 10 个角色的档案字段全空（派蒙 / 戴因斯雷布 / 多托雷…），观测枢也没有对应词条。
    // 硬拒答会让用户看到「本轮没有检索到和这个问题相关的内容」，而库里明明有这个角色。
    // 交给模型按【检索覆盖】如实说「本轮没有取到它的资料」。
    if (coverage && coverage.total > 0) {
      return {
        level: 'weak',
        refuse: false,
        reason: `识别到 ${coverage.total} 个知识库条目，但本轮没有取到它们的资料`,
      };
    }
    return {
      level: 'none',
      refuse: true,
      reason: '检索结果为空',
      // 这一句是写死的：**不经过模型**，所以不可能被模型改写成编造内容。
      //
      // 措辞只敢说到「本轮没有检索到」：检索为空**不等于**库里没有 ——
      // 实测有角色档案字段全空、也有问题问的是正文里的东西
      // （「往生堂是什么」在库里却检索不到具名条目）。
      // 旧文案写「知识库里没有检索到…」，用户读到的就是「库里没有」，这是过度断言。
      answer: '本轮没有检索到和这个问题相关的内容（这不代表知识库里没有）。\n\n可以试试直接说角色名或物品名（例如「胡桃的语音」「天空之翼」），或者换个说法。',
    };
  }
  if (!anchors.length) {
    return {
      level: 'weak',
      refuse: false,
      reason: '问题里没有出现知识库的具名条目，检索结果可能只是词面撞上',
    };
  }
  return { level: 'ok', refuse: false, reason: `命中 ${anchors.length} 个锚点` };
}

// ---------------------------------------------------------------- 引用审计

// 这些句子是「拒绝语 / 建议 / 串场话」，不承载事实，不该要求引用。
// 建议类要写得**窄**：像「胡桃可以在夜间出工」这种带「可以」的事实句不能被误判成建议。
const META_PATTERNS = [
  /知识库里没有/, /未(收录|找到|检索到)/, /查(不到|无)/,
  // 「本轮没取到」是提示词里要求模型用的**正确**说法（见 chat/prompt.mjs 的第 1 条）：
  // 资料少只能说「本轮的资料里没有」，不能说「知识库里没有」。
  // 不认这几句，「本轮没有取到它的资料」会被当成无据的事实陈述，整段误判 fail。
  /本轮(的)?(资料|检索)(里|中)?\s*(并)?\s*没有/, /本轮没有(检索到|取到|找到|收录)/,
  /没有取到(它的|该|相关)?资料/,
  // 「资料没有」中间常常夹逗号：「根据提供的资料，没有关于…的描述」。
  // 不容错的话这类**正确的拒答**会被当成无据事实陈述，整段误判 fail。
  /资料[，,、:：]?\s*(里|中)?\s*(并)?\s*没有/,
  /无法(回答|确定|判断)/, /不(能|敢)确定/, /以上(就)?是/, /^综上/, /^总结/,
  // 「有结构化块时，模型用这句表示没有额外可补充的」——提示词里就是这么要求的。
  // 注意是「上面」不是「以上」：漏了这条会把这句收尾语当成无据事实陈述，整段误判 fail。
  /^上面(就)?是全部/, /^这些(就)?是全部/, /^以上就是全部/, /^没有(别的|更多)(补充|可补充)/,
  /^根据(资料|以上|检索)/, /^以下是/, /^先说结论/,
  // 拒答之后的引导语
  /^可以试试/, /^可以换个/, /^可以试试看/, /^请试试/, /^建议(你)?(试试|换)/,
  /试试直接说/, /换个说法/, /^可以(直接)?说(角色|物品)名/, /^试试用/,
];

/** 把回答切成句子（保留列表项作为独立句）。 */
export function splitSentences(text) {
  const out = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 去掉列表符号与 markdown 强调标记，但保留正文
    const body = line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/\*\*/g, '').trim();
    if (!body) continue;
    // 按中文/英文句末标点切，但不要把 [1] 后面的点号切开
    for (const piece of body.split(/(?<=[。！？!?；;])\s*/)) {
      const s = piece.trim();
      if (!s) continue;
      // 中文写作习惯是引用写在句号**之后**：「…是往生堂的堂主。[1]」。
      // 按句末标点切会把 [1] 切成独立的一句，于是前一句被误判成「无引用」——
      // 实测这会让一条明明有引用的回答被判成 0/5 有据。
      // 所以：只由引用标记组成的片段，并回上一句。
      if (out.length && /^(?:\[\d{1,3}\]|资料\s*\d{1,3})[。，,、；;\s]*$/.test(s)) {
        out[out.length - 1] += s;
      } else {
        out.push(s);
      }
    }
  }
  return out;
}

const isMeta = (s) => META_PATTERNS.some((re) => re.test(s));

// 引用编号的识别。标准格式是 [1]，但实测本地小模型常写成
// 「根据【资料】19」「资料19」——只认 [n] 会把这些答案误判成「无据」。
// 「资料」这个前缀足够specific，不会把普通数字误当引用。
const REF_RE = /\[(\d{1,3})\]|资料\s*[】\]]?\s*(\d{1,3})/g;
function refsOf(sentence) {
  const out = [];
  for (const m of String(sentence).matchAll(REF_RE)) {
    const n = Number(m[1] != null ? m[1] : m[2]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** 够不够格算「一句事实陈述」：太短、纯标题、纯符号的都不算。 */
function isClaim(s) {
  const plain = s.replace(/\[\d{1,3}\]/g, '').replace(/[#>*`_\-\s]/g, '');
  if (plain.length < 6) return false;
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(plain);
}

/**
 * 逐句核对引用。
 * @param {string} answer 模型输出
 * @param {Array} sources 检索到的资料（顺序即引用编号 1..n）
 * @param {{extractive?: boolean}} opts extractive=true 表示这是「检索模式」——
 *   没有调用生成模型，正文就是资料原文摘录，不存在编造的可能，直接判 pass。
 *   （不特判的话，摘录正文那一行没有 [n]，会被误报成无据。）
 */
export function auditAnswer(answer, sources = [], opts = {}) {
  const n = sources.length;
  if (!String(answer || '').trim()) {
    return { verdict: 'fail', claims: 0, cited: 0, citations: 0, invalidRefs: [], unsupported: [], unsupportedCount: 0, note: '没有回答正文，无法进行引用审计', empty: true };
  }
  if (opts.extractive) {
    return {
      verdict: 'pass', claims: 0, cited: 0, citations: 0, invalidRefs: [],
      unsupported: [], unsupportedCount: 0,
      note: '检索模式（未接入生成模型），正文为资料原文摘录，不存在生成式编造',
      extractive: true,
    };
  }
  const sentences = splitSentences(answer);
  const usedRefs = new Set();
  const invalidRefs = new Set();
  const unsupported = [];
  let claims = 0, cited = 0;

  for (const s of sentences) {
    const refs = refsOf(s);
    for (const r of refs) {
      if (r >= 1 && r <= n) usedRefs.add(r);
      else invalidRefs.add(r);
    }
    if (isMeta(s) || !isClaim(s)) continue;
    claims++;
    if (refs.some((r) => r >= 1 && r <= n)) cited++;
    else unsupported.push({ text: s.slice(0, 200), reason: refs.length ? 'badref' : 'nocite', refs });
  }

  // 判定：
  //   没有任何事实陈述      -> pass（例如纯拒绝语）
  //   全部有据              -> pass
  //   一半以上有据          -> warn（把无据句标出来，但不推翻整段）
  //   一半以上无据 / 引用了不存在的编号 -> fail
  let verdict = 'pass';
  if (invalidRefs.size) verdict = 'fail';
  else if (claims > 0 && cited === 0) verdict = 'fail';
  else if (unsupported.length > 0) verdict = cited / claims >= 0.5 ? 'warn' : 'fail';

  return {
    verdict,
    claims,
    cited,
    citations: usedRefs.size,
    invalidRefs: [...invalidRefs].sort((a, b) => a - b),
    unsupported: unsupported.slice(0, 12),
    unsupportedCount: unsupported.length,
    note: verdict === 'pass'
      ? '每句事实陈述都能对上检索到的资料'
      : verdict === 'warn'
        ? `${unsupported.length} 句没有可核对的引用，已标出`
        : `有 ${unsupported.length} 句无据或引用了不存在的来源编号 [${[...invalidRefs].join(',')}]`,
  };
}
