// 联网搜索兜底。
//
// ── 它解决什么 ──────────────────────────────────────────────────────
// 知识库只收观测枢的官方内容。用户问库外的东西（新版本前瞻、社区攻略、
// 非观测枢收录的角色）时，`assessRetrieval` 会判定「一条都没检索到」→ 硬拒答。
// 这个模块让那条路径**先试试联网**，搜到东西就带着它生成，搜不到再拒答。
//
// ── 三条硬规矩（写在这里，改之前先读）─────────────────────────────────
//   1. **只在库内检索为空时启用。** 库内能答就绝不联网 —— 官方数据优先。
//   2. **网络结果单独标记** `[W1][W2]…`，与观测枢引用 `[1][2]` 分开。
//      界面和审计都能据此分辨「可回溯」与「不可回溯」。
//   3. **配置驱动，默认关闭。** 没配就完全不影响现有行为。
//
// ── 为什么用 curl 子进程 ────────────────────────────────────────────
// 实测（2026-10-19）：
//   Node 内置 fetch 默认**不走** Windows 系统代理 → DuckDuckGo/Wikipedia 全超时
//   NODE_USE_ENV_PROXY=1 + HTTPS_PROXY       → 仍然超时（Node 24.21 对代理协议支持有限）
//   undici.ProxyAgent                        → 这个项目没装 undici
//   curl 子进程 --proxy                      → ✓ 3.6 秒拿到 10 条真结果
// 所以走 curl。Windows 10+ 自带 curl.exe；Linux 自带 curl。
import { execFile } from 'node:child_process';

/**
 * 搜索配置。放在 chat/llm.config.json 的 webSearch 段里。
 *
 * ── 后端选择（实测结论，2026-10-19）──────────────────────────────
 * 免费爬 HTML 的后端**都不可靠**，不要指望它们做生产：
 *   duckduckgo  —— 连查 4 次就限流，返回 14 KB 空壳页（有结果时 31 KB）
 *   bing        —— 返回通用页，三次不同查询结果一模一样（识别成了 bot）
 *   searxng 公共实例 —— 测了 10 个，JSON 接口全关（返回网页或 17 字节拒绝）
 *
 * 所以生产要一把 key。支持三家（都很简单，返回 JSON）：
 *   tavily  —— https://tavily.com        专为 LLM 设计，有免费额度
 *   brave   —— https://brave.com/search/api/
 *   serper  —— https://serper.dev        Google 结果的代理
 * 拿不到 key 时 duckduckgo 仍可「尽力而为」，但会被限流，结果可能为空。
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,          // 默认关。没配就不联网 —— 不改变现有行为
  // deepseek 是**首选**：和调模型共用同一个 key 与域名，用户不需要再申请别的服务，
  // 也不受「GitHub/DDG 被墙」影响（api.deepseek.com 本来就能直连）。
  backend: 'deepseek',     // deepseek | tavily | brave | serper | duckduckgo | bing
  apiKey: '',              // deepseek/tavily/brave/serper 都要
  baseUrl: '',             // 仅 deepseek 用；空则 https://api.deepseek.com
  proxy: '',               // deepseek 一般不需要；走别的后端且有 VPN 时填
  limit: 6,
  timeoutMs: 25000,
  // Fetch 精读：把排名第一的页面抓成 Markdown 正文。
  // 只在「摘要偏短」（< fetchIfSummaryShorterThan 字）时才抓 —— 摘要够长就没必要多花一次。
  fetchTop: 1,
  fetchIfSummaryShorterThan: 350,
});

function decodeEnt(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
const stripTags = (s) => decodeEnt(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** curl 发一个请求，返回文本。支持代理与自定义方法/头/体。 */
function curlRequest(url, { proxy = '', timeoutMs = 20000, method = 'GET', headers = {}, body = '', userAgent } = {}) {
  const args = ['-s', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000))];
  if (proxy) args.push('-x', proxy);
  if (method !== 'GET') args.push('-X', method);
  args.push('-A', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body) args.push('--data-binary', body);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs + 8000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(String(stdout || ''));
    });
  });
}

const curlGet = (url, c) => curlRequest(url, { proxy: c.proxy, timeoutMs: c.timeoutMs });
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** DeepSeek 官方 Search API —— **首选后端**。
 *
 * 为什么首选：它和调模型用**同一个 key、同一个域名**（api.deepseek.com），
 * 所以用户不用再申请任何别的服务，也不需要代理（这个域名本来就能直连）。
 *
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search/
 *   POST /v1/tools/search
 *   请求 { query, count(1~50), ori_question?, need_content?, localization? }
 *   响应 { results: [{ rerank_score, title, url, snippet, summary, content, site_name, date, authority }] }
 *
 * 计费：5 元 / 1000 次成功请求；无结果不计费。所以 count 调大不额外花钱。
 */
async function searchDeepSeek(q, c, oriQuestion) {
  const body = JSON.stringify({
    query: q,
    count: Math.min(50, Math.max(1, c.limit)),
    ori_question: oriQuestion || null,
    // 不要正文：summary（600~800 字）已经够模型读，开 content 会让响应变大很多
    need_content: false,
  });
  const txt = await curlRequest(`${c.baseUrl || 'https://api.deepseek.com'}/v1/tools/search`, {
    proxy: c.proxy, timeoutMs: c.timeoutMs, method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
    body,
  });
  const j = safeJson(txt);
  if (!j || !Array.isArray(j.results)) return [];
  return j.results
    // 文档说 rerank_score >= 1.5 为优质结果。低于 1.0 的基本是撞词，直接丢。
    .filter((r) => (typeof r.rerank_score !== 'number' ? true : r.rerank_score >= 1.0))
    .sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0))
    .map((r) => ({
      title: String(r.title || '').slice(0, 160),
      url: String(r.url || ''),
      // ⚠ 这里**不要**截断 summary。截断会让后面的「摘要是否够短、要不要抓正文」
      // 判断失真（踩过：切成 400 字后，阈值 350 永远判成「够长」，Fetch 永不触发）。
      // 真正要控制长度的地方是 renderWebContext。
      snippet: String(r.summary || r.snippet || '').replace(/\s+/g, ' '),
      // 额外信息，前端可以展示「来源站点 / 发布时间 / 权威度」
      site: r.site_name || '',
      date: r.date || '',
      authority: typeof r.authority === 'number' ? r.authority : -1,
      score: typeof r.rerank_score === 'number' ? r.rerank_score : 0,
    }))
    .filter((r) => r.title && /^https?:/i.test(r.url));
}

/** DeepSeek 官方 Fetch API —— 把单个网页抓成 Markdown 正文。
 *
 * 用途：搜索返回的 `summary` 只有 600~800 字，遇到攻略长文不够用。
 * 这时抓**排名第一**的那个页面，把完整正文喂给模型精读。
 *
 *   POST /v1/tools/fetch  { url }  →  { title, content(Markdown) }
 *
 * 计费：5 元 / 1000 次，只在真的抓到正文时计费。所以「抓不到就算了」不会花钱。
 * 失败一律返回 null（联网是兜底，不能因为它让整轮对话失败）。
 */
async function fetchDeepSeekPage(url, c) {
  try {
    const txt = await curlRequest(`${c.baseUrl || 'https://api.deepseek.com'}/v1/tools/fetch`, {
      proxy: c.proxy, timeoutMs: c.timeoutMs, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ url }),
    });
    const j = safeJson(txt);
    if (!j || typeof j.content !== 'string' || !j.content.trim()) return null;
    return {
      title: String(j.title || '').slice(0, 160),
      // 截断：一页几千到几万字，全塞进 prompt 会挤掉知识库上下文、也让成本失控。
      // 4000 字足够覆盖攻略的关键结论。
      content: j.content.replace(/\s+\n/g, '\n').trim().slice(0, 4000),
    };
  } catch { return null; }
}

/** Tavily —— 专为 LLM 设计的搜索，返回带 content 的 JSON。 */
async function searchTavily(q, c) {
  const body = JSON.stringify({
    api_key: c.apiKey,
    query: q,
    max_results: c.limit,
    search_depth: 'basic',
    include_answer: false,
  });
  const txt = await curlRequest('https://api.tavily.com/search', {
    proxy: c.proxy, timeoutMs: c.timeoutMs, method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body,
  });
  const j = safeJson(txt);
  if (!j || !Array.isArray(j.results)) return [];
  return j.results.map((r) => ({
    title: String(r.title || '').slice(0, 160),
    url: String(r.url || ''),
    snippet: String(r.content || '').replace(/\s+/g, ' ').slice(0, 300),
  })).filter((r) => r.title && /^https?:/i.test(r.url));
}

/** Brave Search API —— 返回 web.results。 */
async function searchBrave(q, c) {
  const txt = await curlRequest('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + c.limit, {
    proxy: c.proxy, timeoutMs: c.timeoutMs,
    headers: { Accept: 'application/json', 'X-Subscription-Token': c.apiKey },
  });
  const j = safeJson(txt);
  const rows = (j && j.web && j.web.results) || [];
  return rows.map((r) => ({
    title: String(r.title || '').slice(0, 160),
    url: String(r.url || ''),
    snippet: String(r.description || '').replace(/\s+/g, ' ').slice(0, 300),
  })).filter((r) => r.title && /^https?:/i.test(r.url));
}

/** Serper.dev —— Google 结果的代理，返回 organic 数组。 */
async function searchSerper(q, c) {
  const txt = await curlRequest('https://google.serper.dev/search', {
    proxy: c.proxy, timeoutMs: c.timeoutMs, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': c.apiKey },
    body: JSON.stringify({ q, num: c.limit, hl: 'zh-cn' }),
  });
  const j = safeJson(txt);
  const rows = (j && j.organic) || [];
  return rows.map((r) => ({
    title: String(r.title || '').slice(0, 160),
    url: String(r.link || ''),
    snippet: String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 300),
  })).filter((r) => r.title && /^https?:/i.test(r.url));
}

/**
 * 搜一次网。
 * @returns {Promise<Array<{title:string,url:string,snippet:string,ref:string}>>}
 *   失败或无结果一律返回空数组（**不抛异常**：联网是兜底，不能因为它让整轮对话失败）。
 */
export async function searchWeb(query, cfg = {}, oriQuestion = '') {
  const c = resolveConfig(cfg);
  if (!c.enabled) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  // 需要 key 的后端没配 key，直接放弃（不要白花一次网络往返）
  if (['deepseek', 'tavily', 'brave', 'serper'].includes(c.backend) && !c.apiKey) return [];

  try {
    let raw = [];
    if (c.backend === 'deepseek') raw = await searchDeepSeek(q, c, oriQuestion);
    else if (c.backend === 'tavily') raw = await searchTavily(q, c);
    else if (c.backend === 'brave') raw = await searchBrave(q, c);
    else if (c.backend === 'serper') raw = await searchSerper(q, c);
    else if (c.backend === 'bing') {
      const html = await curlGet('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN', c);
      const re = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m; const seen = new Set();
      while ((m = re.exec(html)) !== null && raw.length < c.limit) {
        const url = decodeEnt(m[1]);
        const title = stripTags(m[2]);
        if (!title || !/^https?:/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        raw.push({ title, url, snippet: '' });
      }
    } else {
      const html = await curlGet('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), c);
      raw = parseDuckDuckGo(html, c.limit);
    }
    // 统一编号：W1、W2…（与观测枢的 [1][2] 区分开）
    const numbered = raw.filter((r) => r.title && r.url).slice(0, c.limit).map((r, i) => ({ ...r, ref: `W${i + 1}` }));

    // ---- Fetch 精读：把排名第一的页面抓成 Markdown 正文
    //
    // 只在「搜索摘要不够长」时才抓 —— 摘要本来就 600~800 字的话，
    // 再抓一次网页既慢（多 1~3 秒）又多花一次计费，没意义。
    if (c.fetchTop > 0 && numbered.length && c.backend === 'deepseek') {
      const top = numbered[0];
      const summaryLen = String(top.snippet || '').length;
      if (summaryLen < c.fetchIfSummaryShorterThan) {
        const page = await fetchDeepSeekPage(top.url, c);
        if (page && page.content) {
          numbered[0] = { ...top, content: page.content, fetched: true };
        }
      }
    }
    return numbered;
  } catch {
    return [];
  }
}

/** 把 DuckDuckGo 的重定向链接还原成真实目标 URL。
 *
 * ⚠ 这里踩过坑：DDG 的 href 常是**协议相对**的 `//duckduckgo.com/l/?uddg=<encode>`
 * 和纯相对路径 `/l/?uddg=…`。早先用 `/^https?:/` 直接过滤，`//` 开头的全被丢掉，
 * 于是「原神 7.1 版本」能出 5 条、「胡桃 突破材料」一条都出不来 —— 不是没结果，
 * 是解析器把结果扔了。所以必须先补协议，再判是不是跳转链接。
 */
function realUrl(href) {
  let u = decodeEnt(String(href || '').trim());
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  else if (u.startsWith('/')) u = 'https://duckduckgo.com' + u;
  // 跳转链接里的真实地址
  const uddg = u.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try { u = decodeURIComponent(uddg[1]); } catch { /* 保留原样 */ }
  }
  return /^https?:/i.test(u) ? u : '';
}

/** 从 DuckDuckGo HTML 里抽结果。 */
function parseDuckDuckGo(html, limit) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const url = realUrl(m[1]);
    const title = stripTags(m[2]);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    // 摘要：在标题之后、同一条结果范围内找 result__snippet
    const tail = html.slice(m.index, m.index + 3500);
    const sn = tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = sn ? stripTags(sn[1]).slice(0, 300) : '';
    out.push({ title: title.slice(0, 160), url, snippet });
  }
  return out;
}

/** 读配置：优先环境变量，其次传入的 cfg 对象。 */
export function resolveConfig(cfg = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  // 环境变量可覆盖（部署时不必改文件，也不会把 key 写进仓库）
  if (process.env.KB_WEBSEARCH === '1') merged.enabled = true;
  if (process.env.KB_WEBSEARCH === '0') merged.enabled = false;
  if (process.env.KB_WEBSEARCH_BACKEND) merged.backend = process.env.KB_WEBSEARCH_BACKEND;
  if (process.env.KB_WEBSEARCH_API_KEY) merged.apiKey = process.env.KB_WEBSEARCH_API_KEY;
  if (process.env.KB_WEBSEARCH_PROXY) merged.proxy = process.env.KB_WEBSEARCH_PROXY;
  // 没显式配 proxy 时，从环境变量兜一次（用户 VPN 常写在 HTTPS_PROXY）
  if (!merged.proxy) {
    merged.proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  }
  const lim = Number(merged.limit);
  merged.limit = Number.isFinite(lim) && lim > 0 ? Math.min(10, Math.floor(lim)) : DEFAULT_CONFIG.limit;
  return merged;
}

/**
 * 搜一次网。
 *
 * 注意：这个函数的**唯一实现**在上面（紧跟 Tavily/Brave/Serper 那三个后端函数之后）。
 * 这里原本还有一份旧的「只用 DDG/Bing」的实现，加 API 后端时忘了删，
 * 导致 `Identifier 'searchWeb' has already been declared` —— 已经删掉了。
 *
 * 把网络结果拼成给模型看的上下文块。
 * 措辞里明确说「这是网络内容、未与观测枢核对」，并要求模型用 [W] 标记引用。
 */
export function renderWebContext(sources) {
  if (!sources || !sources.length) return '';
  const lines = sources.map((s) => {
    const meta = [s.site, s.date ? String(s.date).slice(0, 10) : ''].filter(Boolean).join(' · ');
    const head = `[${s.ref}] ${s.title}${meta ? '  （' + meta + '）' : ''}\n    ${s.url}`;
    // 抓过正文的用正文（更有信息量），否则用摘要
    const body = s.content
      ? `\n    —— 页面正文（已抓取）——\n    ${s.content.split('\n').join('\n    ')}`
      : (s.snippet ? '\n    ' + s.snippet.slice(0, 500) : '');
    return head + body;
  });
  return [
    '【以下是网络搜索结果，不是知识库内容】',
    '知识库内没有检索到与这个问题相关的官方资料，以下内容来自公开网络：',
    '',
    ...lines,
    '',
    '使用这些内容时：',
    '- 引用网络内容必须标 [W1][W2] 这样的标记，不要混用知识库的 [1][2]。',
    '- 只陈述上面写到的内容；没写到的就说不知道，不要补。',
    '- 明确告诉用户这些来自网络、未经官方资料核对。',
  ].join('\n');
}

/** 配置摘要（给 /v1/meta 展示用，不含敏感信息）。 */
export function webSearchSummary(cfg = {}) {
  const c = resolveConfig(cfg);
  return { enabled: c.enabled, backend: c.backend, proxy: c.proxy ? '已配置' : '', limit: c.limit };
}
