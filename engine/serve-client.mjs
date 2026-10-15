import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openV1, V1_DOMAINS } from './lib/v1-data.mjs';
import { assessRetrieval, auditAnswer } from './lib/grounding.mjs';
import { buildBlocks, summarizeBlocks, blockHintForPrompt, BLOCK_KINDS } from './lib/blocks.mjs';
import { createRetriever, assembleContext, DEFAULT_BUDGET } from './chat/retrieve.mjs';
import { runChat } from './chat/agent.mjs';
import { MediaJobs } from './lib/media-jobs.mjs';
import { loadVideoIndex } from './lib/video-index.mjs';
import { corpusRevision } from './lib/corpus-revision.mjs';
import { loadConfig, resolveProvider, resolveThinking } from './chat/llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.KB_DATA_DIR || path.join(HERE, 'data');
const CHAT_DIR = path.join(HERE, 'chat');
const HOST = '127.0.0.1';
const PORT = Number(process.env.KB_CLIENT_PORT || 5180);
const AUTH_OFF = false;
const SINGLE_TOKEN = process.env.KB_CLIENT_TOKEN || '';
const RATE_PER_MIN = Number(process.env.KB_CLIENT_RATE || 30);
const DAILY_DEFAULT = Number(process.env.KB_CLIENT_QUOTA || 500);
const ALLOWED_ORIGINS = String(process.env.KB_CLIENT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------ 工具

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const dayKey = () => new Date().toISOString().slice(0, 10);

function sendJson(res, payload, status = 200, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}
function sendErr(res, err) {
  const status = err && err.status ? err.status : 500;
  sendJson(res, { error: { code: (err && err.code) || 'internal', message: err instanceof ApiError ? err.message : '服务异常，请稍后重试或检查服务配置。', status } }, status);
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new ApiError(413, 'body_too_large', '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new ApiError(400, 'bad_json', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  // 注意：默认不给 CORS 头。客户端是桌面应用，不需要浏览器式跨域。
}

// ------------------------------------------------------------------ 限流

const buckets = new Map();     // tokenHash -> number[]（最近一分钟的毫秒时间戳）
function rateLimit(hash, maximum = RATE_PER_MIN) {
  const now = Date.now();
  let arr = buckets.get(hash);
  if (!arr) { arr = []; buckets.set(hash, arr); }
  while (arr.length && now - arr[0] > 60000) arr.shift();
  if (arr.length >= maximum) {
    const wait = Math.ceil((60000 - (now - arr[0])) / 1000);
    throw new ApiError(429, 'rate_limited', `请求过于频繁，请 ${wait} 秒后重试`);
  }
  arr.push(now);
}

let v1 = null;
let corpusProblem = '';
try { v1 = openV1(DATA, { writable: true }); }
catch { corpusProblem = '未配置资料库。请设置 KB_DATA_DIR 指向自行准备的资料目录。'; }
const videoIndex = loadVideoIndex(process.env.KB_VIDEO_INDEX_PATH || '');
function requireCorpus() {
  if (!v1) throw new ApiError(503, 'corpus_not_configured', corpusProblem || '未配置资料库。');
  return v1;
}

function recordUsage(hash, patch = {}) {
  try {
    const key = `usage:${dayKey()}:${hash}`;
    if (!v1) return null;
    const cur = v1.ws.getKv(key);
    const val = (cur && cur.value) || { requests: 0, tokensIn: 0, tokensOut: 0 };
    val.requests += 1;
    if (patch.tokensIn) val.tokensIn += Number(patch.tokensIn) || 0;
    if (patch.tokensOut) val.tokensOut += Number(patch.tokensOut) || 0;
    v1.ws.setKv(key, val);
    return val;
  } catch { return null; }
}
function usageOf(hash) {
  try {
    if (!v1) return { requests: 0, tokensIn: 0, tokensOut: 0 };
    const cur = v1.ws.getKv(`usage:${dayKey()}:${hash}`);
    return (cur && cur.value) || { requests: 0, tokensIn: 0, tokensOut: 0 };
  } catch { return { requests: 0, tokensIn: 0, tokensOut: 0 }; }
}

function authenticate(req) {
  if (AUTH_OFF) return { hash: 'local', name: '本地模式', local: true };
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok) throw new ApiError(401, 'unauthorized', '缺少 Authorization: Bearer <token>');
  if (SINGLE_TOKEN && tok === SINGLE_TOKEN) return { hash: sha(tok), name: 'env-token' };
  throw new ApiError(401, 'unauthorized', SINGLE_TOKEN ? 'token 无效' : '未配置 KB_CLIENT_TOKEN，请通过环境变量提供 token。');
}
function quotaLeft(auth) {
  if (auth.local) return Infinity;
  const quota = Number((auth.info && auth.info.dailyQuota) || DAILY_DEFAULT);
  return quota - usageOf(auth.hash).requests;
}

// ------------------------------------------------------------------ 检索缓存

let retriever = null;
let retrieverRevision = 0;
function getRetriever() {
  requireCorpus();
  if (retrieverRevision !== corpusRevision()) { retriever = null; retrieverRevision = corpusRevision(); }
  if (!retriever) retriever = createRetriever(v1.db, v1.obc);
  return retriever;
}

/** 统一的检索入口：始终回报「扫了哪些域、各命中多少、有没有锚点」，供覆盖自检。 */
function doRetrieve(question, opts = {}) {
  const r = getRetriever();
  const budget = Number.isFinite(opts.budget) ? opts.budget : DEFAULT_BUDGET;
  const result = r.retrieve(question, { inherited: opts.inherited || [], budget });
  const ctx = assembleContext(result.sources, budget);
  const byType = {};
  for (const s of result.sources) {
    byType[s.type] = (byType[s.type] || 0) + 1;
    if(s.retrieval==='fts'&&s.type!=='fts')byType.fts=(byType.fts||0)+1;
  }
  // 锚点 = 问题里出现的知识库具名条目。实测精确度高、召回偏低：
  // 库外问题 10/10 无锚点，库内问题 9/13 有锚点。
  // 所以它只用来标「依据较弱」，**不**用来硬拒答。
  const anchors = v1.findAnchors(question);
  return {
    question,
    entities: result.entities || [],
    scopes: result.scopes || [],
    keywords: result.keywords || [],
    // 覆盖回报：识别到哪些条目、哪些取到资料、哪些没取到（见 chat/retrieve.mjs）
    coverage: result.coverage || null,
    hitsByType: byType,
    scannedDomains: V1_DOMAINS.map((d) => d.domain),
    anchors,
    kept: ctx.kept,
    dropped: Math.max(0, result.sources.length - ctx.kept.length),
    chars: ctx.chars,
    text: ctx.text,
  };
}

// ------------------------------------------------------------------ 路由

const media = new MediaJobs({root:process.env.KB_MEDIA_CACHE || path.join(DATA,'media-cache'),getSource:(id,index)=>{
  if (!videoIndex.configured) return { error: '未配置视频索引。请设置 KB_VIDEO_INDEX_PATH。' };
  return videoIndex.entries.get(`${id}:${index}`) || null;
}});
let statusCache = null;
const HANDLED = new Set(['meta', 'query', 'record', 'asset', 'retrieve', 'chat', 'health', 'usage', 'domains', 'demo', 'videos', 'media', 'status']);

async function routeV1(req, res, url, seg) {
  const head = seg[1] || '';
  if (!HANDLED.has(head)) {
    throw new ApiError(404, 'not_found', `未知接口：/v1/${head}`);
  }
  // 方法校验：GET 类接口不接受 POST，POST 类接口不接受 GET。
  // 不加这一层的话 POST /v1/query 会被当成普通查询静默放行。
  const GET_ONLY = new Set(['meta', 'domains', 'query', 'record', 'asset', 'demo', 'status']);
  const POST_ONLY = new Set(['retrieve', 'chat', 'usage']);
  if (GET_ONLY.has(head) && req.method !== 'GET' && req.method !== 'HEAD') {
    throw new ApiError(405, 'method_not_allowed', `/v1/${head} 只接受 GET`);
  }
  if (POST_ONLY.has(head) && req.method !== 'POST') {
    throw new ApiError(405, 'method_not_allowed', `/v1/${head} 只接受 POST`);
  }
  if (head === 'health') return sendJson(res, { ok: true, service: 'kb-client', version: 1 });

  // 演示页：由服务自己托管，这样和 /v1 同源，不用配 CORS 白名单。
  // 页面本身不含任何知识库数据（它只是个客户端），所以不需要 token 就能拿到 HTML；
  // 真正取数时页面会要求用户填 token。
  if (head === 'demo') {
    try {
      const html = fs.readFileSync(path.join(HERE, 'demo.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch {
      throw new ApiError(404, 'no_demo', 'demo.html 不存在');
    }
  }

  const auth = authenticate(req);
  if (head === 'media' && seg[2] === 'jobs') rateLimit(auth.hash + ':media-poll', 120);
  else if (!(head === 'media' && seg[2] === 'assets')) rateLimit(auth.hash);
  if(head==='status'){
    if(!statusCache || Date.now()-statusCache.at>30000){
      const cfg=loadConfig(CHAT_DIR),p=await resolveProvider(cfg),ready=p.provider==='openai'&&!p.unreachable;
      statusCache = {
        at: Date.now(),
        value: {
          ok: !!v1,
          ready: !!v1 && ready,
          provider: ready ? 'model' : 'extractive',
          reason: v1 ? (ready ? '生成服务已连接' : '当前为检索模式') : corpusProblem,
          thinking: resolveThinking(cfg),
          deepThinkDefault: resolveThinking(cfg)?.type === 'enabled',
          capabilities: { corpus: !!v1, videoIndex: videoIndex.configured },
        },
      };
    }
    return sendJson(res,statusCache.value);
  }

  if(head==='videos'){
    if (!videoIndex.configured) throw new ApiError(503, 'video_index_not_configured', '未配置视频索引。请设置 KB_VIDEO_INDEX_PATH。');
    const id=Number(seg[2]),index=Number(url.searchParams.get('index')||0);
    try{
      if(!seg[3]&&req.method==='GET')return sendJson(res,media.metadata(id,index));
      if(seg[3]==='scenes'&&req.method==='POST')return sendJson(res,media.scenes(id,index,auth.hash),202);
      if(seg[3]==='clips'&&req.method==='POST'){const body=await readBody(req);return sendJson(res,media.clip(id,index,body.start,body.end,auth.hash),202);}
      throw new ApiError(405,'method_not_allowed','视频接口方法无效');
    }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,'invalid_video_request',e.message)}
  }
  if(head==='media'){
    if(req.method!=='GET'&&req.method!=='HEAD')throw new ApiError(405,'method_not_allowed','请用 GET');
    if(seg[2]==='jobs'){const job=media.get(seg[3],auth.hash);if(!job)throw new ApiError(404,'job_not_found','没有该任务');return sendJson(res,job);}
    if(seg[2]==='assets'){
      const asset=media.asset(seg[3],seg[4],seg[5],auth.hash);if(!asset)throw new ApiError(404,'asset_not_found','片段或缩略图不存在，请重新生成。');
      const stat=fs.statSync(asset.file);let start=0,end=stat.size-1,status=200;const headers={'Content-Type':asset.type,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600'};
      if(req.headers.range){const m=String(req.headers.range).match(/^bytes=(\d+)-(\d*)$/);if(!m)throw new ApiError(416,'invalid_range','范围无效');start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(start>end)throw new ApiError(416,'invalid_range','范围无效');status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
      headers['Content-Length']=end-start+1;res.writeHead(status,headers);if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(asset.file,{start,end});stream.on('error',()=>res.destroy());return stream.pipe(res);
    }
    throw new ApiError(404,'not_found','未知媒体接口');
  }

  requireCorpus();

  if (head === 'domains') return sendJson(res, { domains: V1_DOMAINS });

  if (head === 'meta') {
    const cov = v1.coverage();
    const limit = quotaLeft(auth);
    return sendJson(res, {
      ...cov,
      client: {
        auth: AUTH_OFF ? 'off' : 'token',
        tokenName: auth.name,
        rateLimitPerMin: RATE_PER_MIN,
        quotaToday: Number.isFinite(limit) ? limit : null,
        usageToday: usageOf(auth.hash),
      },
      endpoints: [
        'GET  /v1/meta', 'GET  /v1/domains', 'GET  /v1/query', 'GET  /v1/record/:kind/:id',
        'GET  /v1/asset/:kind/:id', 'POST /v1/retrieve', 'POST /v1/chat', 'GET  /v1/demo',
      ],
      // 结构化答案块：客户端据此决定要不要注册对应渲染器。
      // 不在这里声明的话，旧客户端收到 block 事件也不会画，只能看到文字回答。
      blocks: {
        version: 1,
        kinds: BLOCK_KINDS,
        note: 'POST /v1/chat 在生成前会发一次 blocks 事件；done 事件里带同样内容的概要。',
      },
    });
  }

  if (head === 'query') {
    const domain = url.searchParams.get('domain') || '';
    if (!V1_DOMAINS.some((d) => d.domain === domain)) {
      throw new ApiError(400, 'bad_domain', `domain 必须是 ${V1_DOMAINS.map((d) => d.domain).join(' | ')}`);
    }
    const out = v1.query({
      domain,
      q: url.searchParams.get('q') || '',
      where: url.searchParams.get('where') || '',
      sort: url.searchParams.get('sort') || '',
      limit: url.searchParams.get('limit') || 20,
      offset: url.searchParams.get('offset') || 0,
      countOnly: url.searchParams.get('count') === '1',
    });
    return sendJson(res, out);
  }

  if (head === 'record') {
    const kind = seg[2], id = seg[3];
    if (!kind || !id) throw new ApiError(400, 'bad_request', '用法：/v1/record/:kind/:id（kind = character | book | obc）');
    const rec = v1.getRecord(kind, id);
    if (!rec) throw new ApiError(404, 'record_not_found', `没有 ${kind} #${id}`);
    return sendJson(res, rec);
  }

  if (head === 'asset') {
    const kind = seg[2], id = seg[3];
    const size = url.searchParams.get('size') || 'icon';
    const file = v1.resolveArt(kind, id, size);
    if (!file) throw new ApiError(404, 'asset_not_found', `没有 ${kind} #${id} 的 ${size} 资源`);
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end(buf);
  }

  if (head === 'retrieve') {
    if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', '请用 POST');
    const body = await readBody(req);
    const question = String(body.question || '').trim();
    if (!question) throw new ApiError(400, 'empty_question', 'question 不能为空');
    const out = doRetrieve(question, body);
    recordUsage(auth.hash);
    return sendJson(res, {
      question: out.question, entities: out.entities, scopes: out.scopes,
      coverage: out.coverage,
      hitsByType: out.hitsByType, scannedDomains: out.scannedDomains,
      anchors: out.anchors,
      kept: out.kept.length, dropped: out.dropped, chars: out.chars,
      sources: out.kept,
    });
  }

  if (head === 'usage') {
    if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', '请用 POST');
    const body = await readBody(req);
    recordUsage(auth.hash, { tokensIn: body.tokensIn, tokensOut: body.tokensOut });
    return sendJson(res, { ok: true, usageToday: usageOf(auth.hash) });
  }

  if (head === 'chat') {
    if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', '请用 POST');
    const left = quotaLeft(auth);
    if (left <= 0) throw new ApiError(429, 'quota_exceeded', '今日额度已用完');
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message) throw new ApiError(400, 'empty_message', 'message 不能为空');
    const sessionId = String(body.sessionId || auth.hash).slice(0, 64);
    const think = typeof body.think === 'boolean' ? body.think : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    // 锚点先算好：它决定闸门是「硬拒答」还是「依据较弱」
    const anchors = v1.findAnchors(message);
    let kept = [];
    let answer = '';
    let gate = null;
    let provider = '';
    // 真正出字的模型 + 是否降级到检索模式：这两个只有 agent.mjs 知道，
    // 必须从它发的 done 事件里接过来，否则重建 done 时信息就丢了。
    let model = '';
    let degraded = false;
    let failed = false;
    let reasoningChars = 0;
    let elapsedMs = 0;
    let entities = [];
    let coverage = null;
    let blocks = [];

    const chatInput = {
      sessionId, message, think, signal: ac.signal,
      obcDb: v1.obc,
    };
    const it = runChat(v1.db, CHAT_DIR, chatInput);
    try {
      for await (const ev of it) {
        // ---- 检索到的实体 + 覆盖回报，后面造块与闸门都要用
        if (ev.type === 'meta') { entities = ev.entities || []; coverage = ev.coverage || null; send(ev); continue; }
        // ---- 生成之前的闸门：一条都没检索到 -> 直接拒答，**模型根本不被调用**
        if (ev.type === 'sources') {
          kept = ev.sources || [];
          send(ev);
          // coverage 一并交给闸门：识别到了库里的条目、只是没取到资料时，不许硬拒答
          // （「问题点名了库里的条目」本身就说明这不是库外问题）。
          gate = assessRetrieval({ sources: kept, anchors, coverage });
          send({ type: 'grounding', level: gate.level, reason: gate.reason, refused: gate.refuse, anchors });
          if (gate.refuse) {
            answer = gate.answer;
            send({ type: 'delta', text: answer });
            await it.return();          // 终止生成器，后面的生成一步都不走
            break;
          }
          // 结构化块在这里造：此时已过闸门（有资料），但生成还没开始 ——
          // 是唯一既能拿到检索结果、又来得及影响提示词的时机。
          // 块挂在 chatInput 上，agent.mjs 会在 buildMessages 时读到，
          // 从而告诉模型「这些内容界面已经展示了，别复述」。
          try {
            blocks = buildBlocks({ v1, question: message, anchors, entities, videoIndex });
          } catch { blocks = []; }
          if (blocks.length) {
            chatInput.blockHint = blockHintForPrompt(blocks, message);
          }
          send({ type: 'blocks', blocks });
          continue;
        }
        // ---- done 先扣下，等审计算完再自己发（模型与降级标志要接过来，别丢）
        if (ev.type === 'done') {
          answer = ev.answer || answer;
          provider = ev.provider || provider;
          model = ev.model || model;
          degraded = ev.degraded === true || provider === 'extractive';
          failed = ev.failed === true;
          reasoningChars = ev.reasoningChars || 0;
          elapsedMs = ev.elapsedMs || 0;
          continue;
        }
        if (ev.type === 'provider') provider = ev.provider || '';
        send(ev);
      }
    } catch (err) {
      failed = true;
      send({ type: 'error', message: err.message || '生成失败' });
    }

    // ---- 生成之后的审计：逐句核对引用是否指向真实来源
    if (gate && !gate.refuse) {
      if (!String(answer).trim()) { failed = true; degraded = true; }
      const audit = auditAnswer(answer, kept, { extractive: provider === 'extractive' });
      send({ type: 'audit', ...audit });
      send({ type: 'done', answer, grounding: gate, provider, model, degraded, failed, reasoningChars, elapsedMs, audit, blocks: summarizeBlocks(blocks) });
    } else if (gate && gate.refuse) {
      // 闸门拒答：模型根本没被调用，provider/model 就该是空的
      send({ type: 'done', answer, refused: true, grounding: gate, provider: '', model: '', degraded: false });
    } else {
      send({ type: 'done', answer, grounding: { level: 'unknown', reason: '未能取得检索结果' }, provider, model, degraded: degraded || !answer.trim(), failed: true, reasoningChars, elapsedMs });
    }

    recordUsage(auth.hash);
    send({ type: 'eof' });
    return res.end();
  }

  throw new ApiError(404, 'not_found', '未知接口');
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); }
  catch { return sendErr(res, new ApiError(400, 'bad_url', 'URL 不合法')); }
  const seg = url.pathname.split('/').filter(Boolean);
  try {
    if (seg[0] !== 'v1') throw new ApiError(404, 'not_found', '本服务只提供 /v1/*');
    // 明确挡掉本地开发面的东西（就算有人照抄路径也拿不到）
    if (['query', 'schema', 'sql'].includes(seg[1]) && seg[2] === 'api') {
      throw new ApiError(403, 'forbidden', '本服务不提供任意 SQL 与 schema');
    }
    await routeV1(req, res, url, seg);
  } catch (err) {
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    sendErr(res, err);
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write('客户端接口 /v1: http://' + HOST + ':' + PORT + '\n');
  process.stdout.write(SINGLE_TOKEN ? '鉴权：环境变量 token\n' : '未配置 KB_CLIENT_TOKEN，所有资料接口保持锁定。\n');
});
