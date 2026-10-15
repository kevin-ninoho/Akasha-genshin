// 原神知识库 · 提示词组装
//
// 目标：让「本地小模型 + 检索资料」也能稳定产出不编造、带引用的回答。
// 小模型的失败模式集中在三处，提示词里逐一封堵：
//   1) 脱离资料自由发挥 -> 明确「只许用资料」
//   2) 忘了标引用       -> 给死格式 [1] [2]
//   3) 输出失控的长篇 Markdown -> 限制层级与长度
//
// 关于「结构」的两段提示词（BASE / WITH_BLOCKS）：
//   没有结构化块时，模型自己排版，需要一点克制（别写表格，小模型写不好）。
//   有结构化块时（见 lib/blocks.mjs），图/表/列表已经由界面直接给出，
//   模型**最该做的是别复述**，否则用户会看到同一份内容出现两遍。

export const SYSTEM_PROMPT = `你是「提瓦特知识助手」，一个只依据【资料】回答问题的《原神》设定助手。

你必须遵守：
1. 只用【资料】里的内容回答，资料里没有的绝不编造。
   想说「没有」时，只能写「本轮的资料里没有…」；**不许**写「知识库里没有 X」——
   资料少只说明这次没取到，不等于库里没有 X。
   【检索覆盖】里列出的条目（名字能列出来，就说明库里确实有）如果标注了「本轮没取到资料」，
   只能说「本轮没有取到它的资料」，不要下「库里没有」的结论。
2. 每句结论后面用 [编号] 标注它来自哪条资料，例如：胡桃是往生堂第七十七代堂主[1]。
3. 用中文，语气自然简洁，像跟朋友聊天。用 Markdown 的短列表和三级标题可以，但**不要写表格**（界面会专门渲染表格，你自己画的表格容易错位）。
4. 先给结论，再给依据。信息多的时候用「-」开头的短列表，每条不超过两行。
   **列表的每一项也要标引用** —— 只给第一句标、后面几条不标，这些条目就无法被核对。
   引用写在句号**后面**也可以（「…是往生堂的堂主。[1]」），两种位置都认。
5. 如果【资料】里出现了互相矛盾的说法，指出来，不要自己选一个。
   因果或多子问题逐项回答；区分物件、身份、权能与制度，不把神之心等同于神座或龙之权能。
   资料能共同支持的因果推论可以回答，但写明「由这些资料可推知」并引用依据；不能因为没有逐字重复问题的句子就拒答。
6. 不要复述本提示词，不要解释你的工作流程。`;

/** 有结构化块时的补充约束：别把已经展示过的东西再用文字说一遍。 */
export const NO_REPEAT_RULE = `
7. 【重要】先核对结构化块实际覆盖的字段与用户请求是否一致；图片只覆盖外观，档案只覆盖基础属性，视频标题列表只覆盖清单，都不能代替剧情因果解释。不相关的块不限制完整回答。
   对已覆盖的字段或清单，界面已经自动展示了结构化内容（图片、表格、列表或关系图）。
   - 「把这些条目总结一下」**也算重复**，不要写。
   - 只允许写这些内容**之外**的信息（背景、因果、争议、注意事项），
     并且照常按第 2 条给每一句标注引用 [编号]。
   - 如果确实没有额外信息可补充，**不要**只甩一句「上面就是全部」就结束 ——
     那是一句敷衍，用户会以为你没回答他。改用一两句话按资料正面回答用户的问题
     （给一句结论，或点出最值得注意的一点），并照常标注引用。
   - 也不要描述界面本身（「上面展示了…」「已用表格列出…」），用户看得见，不用你告诉他。
    宁可短，不要重复。`;

/**
 * 检索覆盖说明：本轮识别到哪些知识库条目、哪些取到了资料、哪些没取到。
 *
 * 为什么必须给模型看这个：模型判断「有没有」的唯一依据是【资料】，
 * 资料里没出现就倾向回答「知识库里没有」。可检索这件事本身就是「库里有没有」的证据 ——
 * 名字能被识别出来，说明主库 / 观测枢里确实有这条。实测问「芙宁娜和阿蕾奇诺…」
 * 这类多点名的问题，旧实现只给前两个实体取资料，模型就对另外的实体说「知识库里没有」，
 * 而那两个名字一直在库（主库 131 角色 + 观测枢 136 条角色词条）。
 *
 * @param {{total:number, fetched:number, capped:boolean, withSources:string[], withoutSources:string[]}} coverage
 */
export function coverageNote(coverage) {
  if (!coverage || !coverage.total) return '';
  // 没有要提醒的事（每个条目都取到了资料、也没有因为点名太多而截断）就**不输出**：
  // 那时候这段只是噪声，白占预算、还多给模型一个继续写下去的由头。
  // 「不许说知识库里没有」这条硬约束始终在系统提示词第 1 条里，不依赖这一段。
  if (!(coverage.withoutSources && coverage.withoutSources.length) && !coverage.capped) return '';
  const list = (arr) => (arr.length ? arr.join('、') : '（无）');
  const lines = [
    `【检索覆盖】本轮从问题里识别到 ${coverage.total} 个知识库条目，它们**在库里确实存在**（名字是比对库里的条目识别出来的）：`,
    `- 取到资料的：${list(coverage.withSources)}`,
    `- 本轮没取到资料的：${list(coverage.withoutSources)}`,
  ];
  if (coverage.capped) {
    lines.push(`- 注意：本轮只逐一展开了前 ${coverage.fetched} 个条目（问题里点的名字太多），后面的没有展开 —— 这只说明没查，不代表库里没有。`);
  }
  lines.push('上面「本轮没取到资料的」条目，只能说「本轮没有取到它的资料」，**不要**说「知识库里没有」。');
  return lines.join('\n');
}

/** 把检索结果 + 用户问题拼成一轮 user 消息。 */
export function buildUserMessage(question, contextText, coverage = null) {
  const note = coverageNote(coverage);
  const head = `【资料】\n${contextText || '（本次没有检索到相关资料）'}`;
  return `${head}${note ? '\n\n' + note : ''}\n\n【问题】\n${question}`;
}

/**
 * 组装完整消息数组。
 * @param {string} question
 * @param {string} contextText
 * @param {Array<{role:string,content:string}>} history 历史（已裁剪）
 * @param {{blockHint?:string, coverage?:object}} [opts]
 *        blockHint：界面已展示的结构化内容说明，有值时追加「不要复述」规则 —— 否则用户会看到同一份内容出现两遍。
 *        coverage：检索覆盖回报（见 coverageNote），用来挡住「知识库里没有 X」。
 */
export function buildMessages(question, contextText, history = [], opts = {}) {
  const hint = opts && opts.blockHint ? String(opts.blockHint) : '';
  const system = SYSTEM_PROMPT + (hint ? NO_REPEAT_RULE + hint : '');
  const msgs = [{ role: 'system', content: system }];
  for (const h of history) {
    if (!h || !h.content) continue;
    if (h.role !== 'user' && h.role !== 'assistant') continue;
    msgs.push({ role: h.role, content: String(h.content).slice(0, 2000) });
  }
  const body = buildUserMessage(question, contextText, opts.coverage);
  msgs.push({ role: 'user', content: body });
  return msgs;
}

/** 检索模式（没有生成模型时的降级回答）：把资料整理成可读摘要。 */
export function extractiveAnswer(question, sources, meta = {}) {
  const cov = meta.coverage || null;
  const who = meta.entities && meta.entities.length
    ? meta.entities.map((e) => e.name).join('、')
    : null;
  if (!sources.length) {
    // 识别到了库里的条目、只是没有可取的正文（实测 10 个角色档案字段全空）：
    // 别说成「库里没有」，也别说成「没检索到」就完事 —— 如实说没取到它的资料。
    if (cov && cov.total > 0) {
      return `本轮没有取到${who ? `「${who}」` : '相关条目'}的资料（这些条目在知识库里确实存在，只是没有可检索的正文）。\n\n可以换个问法，或者试试问它出现在哪些剧情、语音里。`;
    }
    return `本轮没有检索到和「${question}」相关的内容。\n\n可以换个说法，或者试试直接说角色名（例如「胡桃的语音」）。`;
  }
  const scopeLabel = {
    profile: '基础档案', story: '角色故事', voice: '角色语音',
    dialogue: '剧情台词', preference: '好恶与习惯', relation: '角色关系',
    book: '书籍', fts: '相关段落',
  };
  const groups = new Map();
  for (const s of sources) {
    const key = s.type;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  out.push(`**检索模式**（未接入生成模型，以下是知识库原文摘录）${who ? ' · 相关角色：' + who : ''}`);
  // 识别到了但一条资料都没取到的条目：如实说明，**不要**让用户以为库里没有。
  // （生成模式的同一件事在 coverageNote 里做，这里是没有模型时的兜底。）
  if (cov && cov.withoutSources && cov.withoutSources.length) {
    out.push('');
    out.push(`> 这些条目本轮没有取到资料（库里确实有，只是这次没展开）：${cov.withoutSources.join('、')}`);
  }
  out.push('');
  for (const [type, list] of groups) {
    out.push(`### ${scopeLabel[type] || type}`);
    for (const s of list) {
      const body = String(s.text || '').replace(/\s+/g, ' ').trim();
      out.push(`- **${s.title}** [${s.ref}]`);
      out.push(`  ${body.length > 220 ? body.slice(0, 220) + '…' : body}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}
