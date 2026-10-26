import './lib/local-policy.mjs';
import { WorkspaceStore } from './lib/workspace-store.mjs';
import { GameRegistry } from './lib/games.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openV1, V1_DOMAINS, SR_V1_DOMAINS, SR_DOMAINS } from './lib/v1-data.mjs';
import { assessRetrieval, auditAnswer } from './lib/grounding.mjs';
import { buildBlocks, summarizeBlocks, blockHintForPrompt, BLOCK_KINDS } from './lib/blocks.mjs';
import { createRetriever, assembleContext, DEFAULT_BUDGET } from './chat/retrieve.mjs';
import { runChat, resetSession } from './chat/agent.mjs';
import { MediaJobs, videoCatalog, videoSources, videoCategorySummary } from './lib/media-jobs.mjs';
import { loadVideoIndex } from './lib/video-index.mjs';
import { corpusRevision } from './lib/corpus-revision.mjs';
import { loadConfig, resolveProvider, resolveThinking } from './chat/llm.mjs';
// 联网兜底：库内检索为空时改查网络。默认关闭，见 lib/websearch.mjs 的说明。
import { searchWeb, renderWebContext, resolveConfig as resolveWebSearchConfig } from './lib/websearch.mjs';
import { buildPlan } from './lib/plan.mjs';
import { skillCatalog, assignIcons, SKILLS } from './lib/skills/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.KB_DATA_DIR || path.join(HERE, 'data');
const games = new GameRegistry();
const workspace = new WorkspaceStore(process.env.AKASHA_WORKSPACE_DB || path.join(process.env.AKASHA_ROOT || path.dirname(HERE), 'userData', 'workbench.sqlite'));
const corpusVersion = () => String(corpusRevision(DATA)) + ':' + (() => { try { return fs.statSync(path.join(DATA, 'kb.sqlite')).mtimeMs; } catch { return 0; } })();
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
  sendJson(res, { error: { code: (err && err.code) || 'internal', message: err?.status && err?.code ? err.message : '服务异常，请稍后重试或检查服务配置。', status } }, status);
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
try { v1 = openV1(DATA, { writable: false }); }
catch { corpusProblem = '未配置资料库。请设置 KB_DATA_DIR 指向自行准备的资料目录。'; }
// 星铁视图（game_id=2）。data/kb.sqlite 本来就是多游戏结构（games 表里
// 1=原神 2=星铁 3=绝区零），openV1 传 gameId 就切过去了。
// 星铁只有图鉴数据，没有剧情/语音语料，所以 chat/research 会拒绝。
let srV1 = null;
try { srV1 = openV1(DATA, { writable: false, gameId: 2 }); } catch { srV1 = null; }
const videoIndex = loadVideoIndex(process.env.KB_VIDEO_INDEX_PATH || '');
const libraryFile=path.join(path.dirname(process.env.AKASHA_WORKSPACE_DB || path.join(process.env.AKASHA_ROOT || path.dirname(HERE),'userData','workbench.sqlite')),'local-videos.json');
const library=loadVideoIndex(libraryFile);
for(const [k,v] of library.entries)videoIndex.entries.set(k,v);
if(library.configured)videoIndex.configured=true;
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

// 视频来源解析：**两层**。
//   ① 先查视频索引（里面可能有本机导入的素材，带 localPath）
//   ② 索引里没有，就直接从观测枢条目现取 URL —— 这样不配索引文件也能剪辑 PV，
//      也就不用为了「能剪片子」强制用户跑一遍 build-video-index。
// 返回 { title, url } 或 { title, localPath }，交给 MediaJobs 决定走哪条取数路径。
const media = new MediaJobs({root:process.env.KB_MEDIA_CACHE || path.join(DATA,'media-cache'),getSource:(id,index)=>{
  const hit = videoIndex.entries.get(`${id}:${index}`);
  if (hit) return hit;
  try {
    const row = v1?.obc?.prepare(
      "SELECT name,raw_json FROM obc_entries WHERE id=? AND kind IN ('char-video','other-video','cutscene')",
    ).get(id);
    if (!row) return null;
    const url = videoSources(JSON.parse(row.raw_json))[index];
    if (!url) return null;
    return { title: row.name, url };
  } catch { return null; }
}});
let statusCache = null;
const HANDLED = new Set(['games', 'workspace', 'evidence', 'meta', 'query', 'record', 'asset', 'retrieve', 'chat', 'health', 'usage', 'domains', 'demo', 'videos', 'media', 'status', 'plan', 'skills', 'skill-icons']);

async function routeV1(req, res, url, seg) {
  const head = seg[1] || '';
  if (!HANDLED.has(head)) {
    throw new ApiError(404, 'not_found', `未知接口：/v1/${head}`);
  }
  // 方法校验：GET 类接口不接受 POST，POST 类接口不接受 GET。
  // 不加这一层的话 POST /v1/query 会被当成普通查询静默放行。
  const GET_ONLY = new Set(['meta', 'domains', 'query', 'record', 'asset', 'demo', 'status', 'skills', 'skill-icons']);
  const POST_ONLY = new Set(['retrieve', 'chat', 'usage', 'plan']);
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
  const gameId = url.searchParams.get('gameId') || 'genshin';
  // 按游戏切数据视图：星铁走 srV1（game_id=2），其余走 v1（原神）。
  const vX = (gameId === 'starrail' && srV1) ? srV1 : v1;
  const vDomains = (gameId === 'starrail') ? SR_V1_DOMAINS : V1_DOMAINS;
  const game = games.get(gameId);
  const owner = games.scope(auth.hash, gameId, 'media');
  if (head === 'games') return sendJson(res, { games: games.list(), localOnly: true });
  if (head === 'workspace') {
    const kind = seg[2], id = seg[3];
    if (req.method === 'GET') return sendJson(res, id ? workspace.get(auth.hash,gameId,kind,id) : {items:workspace.list(auth.hash,gameId,kind)});
    if (req.method === 'POST') {
      const body = await readBody(req, 13 * 1024 ** 2);
      if (body.delete) { workspace.delete(auth.hash,gameId,kind,id,body.revision); return sendJson(res,{ok:true}); }
      return sendJson(res, workspace.put(auth.hash,gameId,kind,id,body.data,body.revision));
    }
    throw new ApiError(405,'method_not_allowed','工作区仅支持 GET / POST');
  }
  if (head === 'evidence') {
    if(req.method !== 'GET')throw new ApiError(405,'method_not_allowed','请用 GET');
    return sendJson(res, workspace.evidence(auth.hash,gameId,seg[2],corpusVersion()));
  }
  if (head === 'chat' && seg[2] === 'reset') {
    if(req.method!=='POST')throw new ApiError(405,'method_not_allowed','请用 POST');
    const body=await readBody(req);resetSession(games.scope(auth.hash,gameId,body.sessionId));return sendJson(res,{ok:true});
  }
  // ── 限流分桶 ────────────────────────────────────────────────
  // 图片（/v1/asset/*）和媒体资源走**独立的高配额桶**，不跟对话抢额度。
  // 原因：一张材料表就有 29 个图标，加上头像、立绘，一次对话能打出上百个
  // 图片请求；这些请求消耗的是磁盘 IO 而不是模型算力，跟对话放一个桶里
  // 结果是「用户看一眼突破材料就被 429」。
  // 而且所有客户端共用一个 token —— 放一个桶等于让所有用户共享 30 次/分钟。
  if (head === 'asset' || (head === 'media' && seg[2] === 'assets')) {
    rateLimit(auth.hash + ':asset', 3000);          // 静态文件：很高，只防打爆
  } else if (head === 'media' && seg[2] === 'jobs') {
    rateLimit(auth.hash + ':media-poll', 240);      // 轮询任务进度
  } else {
    rateLimit(auth.hash);                            // 其余（检索/对话/计划…）按 RATE_PER_MIN
  }
  if(head==='status'){
    if(!statusCache || Date.now()-statusCache.at>30000){
      const cfg=loadConfig(CHAT_DIR),p=await resolveProvider(cfg),ready=p.provider==='openai'&&!p.unreachable;
      statusCache = {
        at: Date.now(),
        value: {
          ok: !!v1,
          ready: !!v1 && ready,
          provider: ready ? 'model' : 'extractive',
          reason: v1 ? (ready ? '本机模型已连接' : cfg.localBlocked ? '已阻止外部模型；本地检索可用' : '本机模型未连接；本地检索可用') : corpusProblem,
          localOnly: true, corpusRevision: corpusVersion(), gameId,
          thinking: resolveThinking(cfg),
          deepThinkDefault: resolveThinking(cfg)?.type === 'enabled',
          capabilities: { corpus: !!v1, videoIndex: videoIndex.configured },
        },
      };
    }
    return sendJson(res,statusCache.value);
  }

  if(head==='videos'){
    // 观测枢视频目录。**视频 URL/本体不会返回给客户端** ——
    // 客户端只用 entryId + videoIndex 去 /v1/videos/:id/scenes 登记任务，
    // 取回本体这件事完全在服务端做（见 MediaJobs 的 download）。
    //
    // 支持 ?q=（按标题搜）与 ?category=（按内容类型筛），
    // 并回一份 categories 统计，客户端据此画筛选栏。
    if(seg[2]==='catalog' && req.method==='GET'){
      const q=String(url.searchParams.get('q')||'').slice(0,120).trim();
      const cat=String(url.searchParams.get('category')||'').slice(0,40).trim();
      let rows=[];
      try {
        // 先按标题粗筛（SQL 能做）；分类在 JS 里做，因为规则是正则
        rows=v1?.obc?.prepare(
          "SELECT id,name,raw_json,kind FROM obc_entries WHERE kind IN ('char-video','other-video','cutscene') AND name LIKE ? ORDER BY name",
        ).all(`%${q}%`) || [];
      } catch {}
      const all=videoCatalog(rows);
      const summary=videoCategorySummary(all);
      const items=cat ? all.filter((x)=>x.category===cat) : all;
      return sendJson(res,{
        items,
        total: items.length,
        categories: summary.categories,   // [{key,label,count}]
        allTotal: summary.total,
        source:'米游社观测枢',
        fetchable:true,                   // 服务端可按需取回本体 → 可剪辑
      });
    }
    if(seg[2]==='import' && req.method==='POST'){
      const body=await readBody(req);const file=String(body.path||'');
      let stat;try{stat=fs.statSync(file)}catch{throw new ApiError(400,'invalid_local_video','请选择本机视频文件')}
      if(!path.isAbsolute(file)||file.startsWith('\\\\')||! /\.(mp4|mov|mkv|webm)$/i.test(file)||!stat.isFile()||stat.size>512*1024*1024)throw new ApiError(400,'invalid_local_video','请选择不超过 512 MB 的本机视频文件');
      let id=1000000000;while(videoIndex.entries.has(id+':0'))id++;
      const item={title:path.basename(file),localPath:fs.realpathSync(file),url:''};library.entries.set(id+':0',item);videoIndex.entries.set(id+':0',item);
      fs.mkdirSync(path.dirname(libraryFile),{recursive:true});
      const tmp=libraryFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({entries:[...library.entries].map(([k,v])=>({...v,entryId:Number(k.split(':')[0]),videoIndex:Number(k.split(':')[1])}))}));fs.renameSync(tmp,libraryFile);
      videoIndex.configured=true;return sendJson(res,{entryId:id,videoIndex:0,title:item.title});
    }
    if (!videoIndex.configured) throw new ApiError(503, 'video_index_not_configured', '未配置本地视频索引。可先使用观测枢元数据目录，或添加本机视频素材。');
    if(!seg[2] && req.method==='GET') return sendJson(res,{items:[...videoIndex.entries.entries()].filter(([,s])=>s.localPath).map(([key,s])=>({entryId:Number(key.split(':')[0]),videoIndex:Number(key.split(':')[1]),title:s.title})).filter(s=>s.title.includes(url.searchParams.get('q')||'')).slice(0,100)});
    const id=Number(seg[2]),index=Number(url.searchParams.get('index')||0);
    try{
      if(!seg[3]&&req.method==='GET')return sendJson(res,media.metadata(id,index));
      if(seg[3]==='scenes'&&req.method==='POST')return sendJson(res,media.scenes(id,index,owner),202);
      if(seg[3]==='clips'&&req.method==='POST'){const body=await readBody(req);return sendJson(res,media.clip(id,index,body.start,body.end,owner),202);}
      throw new ApiError(405,'method_not_allowed','视频接口方法无效');
    }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,'invalid_video_request',e.message)}
  }
  if(head==='media'){
    if(seg[2]==='jobs'&&seg[4]==='cancel'&&req.method==='POST')return sendJson(res,media.cancel(seg[3],owner));
    if(seg[2]==='jobs'&&!seg[3]&&req.method==='GET')return sendJson(res,{items:media.list(owner)});
    if(req.method!=='GET'&&req.method!=='HEAD')throw new ApiError(405,'method_not_allowed','请用 GET');
    if(seg[2]==='jobs'){const job=media.get(seg[3],owner);if(!job)throw new ApiError(404,'job_not_found','没有该任务');return sendJson(res,job);}
    if(seg[2]==='assets'){
      const asset=media.asset(seg[3],seg[4],seg[5],owner);if(!asset)throw new ApiError(404,'asset_not_found','片段或缩略图不存在，请重新生成。');
      const stat=fs.statSync(asset.file);let start=0,end=stat.size-1,status=200;const headers={'Content-Type':asset.type,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600'};
      if(req.headers.range){const m=String(req.headers.range).match(/^bytes=(\d+)-(\d*)$/);if(!m)throw new ApiError(416,'invalid_range','范围无效');start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(start>end)throw new ApiError(416,'invalid_range','范围无效');status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
      headers['Content-Length']=end-start+1;res.writeHead(status,headers);if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(asset.file,{start,end});stream.on('error',()=>res.destroy());return stream.pipe(res);
    }
    throw new ApiError(404,'not_found','未知媒体接口');
  }

  requireCorpus();

  if (head === 'domains') return sendJson(res, { domains: vDomains });

  if (head === 'meta') {
    const cov = vX.coverage();
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
        'GET  /v1/asset/:kind/:id', 'POST /v1/retrieve', 'POST /v1/chat', 'POST /v1/plan',
        'GET  /v1/demo',
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
    if (!vDomains.some((d) => d.domain === domain)) {
      throw new ApiError(400, 'bad_domain', `domain 必须是 ${vDomains.map((d) => d.domain).join(' | ')}`);
    }
    // 星铁的图鉴域（光锥/遗器/材料/成就/模拟宇宙）落在 game_entries 表里，
    // 不是原神那套 characters/books/obc，所以走单独一条 SQL。
    // 星铁的 character 域仍然走 vX.query（characters 表里 game_id=2 的那批）。
    if (gameId === 'starrail' && SR_DOMAINS.includes(domain)) {
      const qtext = (url.searchParams.get('q') || '').trim();
      const lim = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 200);
      const off = Math.max(Number(url.searchParams.get('offset') || 0) || 0, 0);
      const where = ['game_id = ?', 'domain = ?'];
      const params = [2, domain];
      const rarity = url.searchParams.get('rarity');
      if (qtext) { where.push('(name LIKE ? OR text LIKE ?)'); params.push('%' + qtext + '%', '%' + qtext + '%'); }
      if (rarity) { where.push('rarity = ?'); params.push(Number(rarity)); }
      const wsql = where.join(' AND ');
      const total = vX.db.prepare(`SELECT COUNT(*) AS c FROM game_entries WHERE ${wsql}`).get(...params).c;
      const rows = vX.db.prepare(
        `SELECT entry_id AS id, name, sub, rarity, icon_url, text FROM game_entries
         WHERE ${wsql} ORDER BY CAST(entry_id AS INTEGER) LIMIT ? OFFSET ?`
      ).all(...params, lim, off);
      return sendJson(res, {
        domain, total, limit: lim, offset: off, truncated: total > off + rows.length,
        items: rows.map((r) => ({
          id: r.id, name: r.name, sub: r.sub, rarity: r.rarity, text: r.text,
          // 图片统一走同源 /v1/asset/<domain>/<id>（客户端 CSP 是 img-src 'self'）
          art: { icon: r.icon_url ? `/v1/asset/${domain}/${r.id}` : null },
        })),
      });
    }
    const out = vX.query({
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
    const rec = vX.getRecord(kind, id);
    if (!rec) throw new ApiError(404, 'record_not_found', `没有 ${kind} #${id}`);
    return sendJson(res, rec);
  }

  if (head === 'skill-icons') {
    // 技能图标：用角色头像，每次客户端启动换一批。
    // seed 由客户端生成（重开客户端 = 新 seed = 新头像）；同 seed 同结果，刷新页面不会跳。
    //
    // 图标池只取**有落盘头像**的角色（256×256 官方头肩特写）。
    // 敌人图标是游戏内截图（256×120 带背景），做图标很丑；NPC 没有落盘图标 —— 都不入池。
    const seed = Number(url.searchParams.get('seed')) || 1;
    let pool = [];
    try {
      pool = vX.db.prepare(
        'SELECT id, name FROM characters WHERE game_id = 1 AND has_icon = 1 ORDER BY id',
      ).all();
    } catch { pool = []; }
    return sendJson(res, { seed, count: pool.length, icons: assignIcons(SKILLS, pool, seed) });
  }

  if (head === 'skills') {
    // 技能目录。客户端拿它画技能面板 —— 「这客户端能干什么」不该靠用户自己猜。
    // 纯静态元数据（lib/skills/index.mjs 的 SKILLS），不含任何用户数据。
    return sendJson(res, skillCatalog());
  }

  if (head === 'plan') {
    // 练度规划。**纯计算**：不调模型、不写库，同样输入永远同样输出。
    //
    // 玩家的角色清单存在客户端（localStorage）后随请求发来 —— 不是不想存服务端，
    // 是**所有客户端共用同一个 token**，服务端拿不到用户身份。要存服务端得先建
    // 用户体系，那是另一期的事。
    if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', '用法：POST /v1/plan');
    const body = await readBody(req);
    const out = buildPlan(v1, {
      roster: body && body.roster,
      target: body && body.target,
      resin: body && body.resin,
      prefer: body && body.prefer,
      optimize: body && body.optimize,
    });
    if (!out.ok) {
      const code = out.error || 'bad_request';
      // 名单过大是请求体的问题，用 413；其余是参数问题，用 400
      const status = code === 'roster_too_large' ? 413 : 400;
      throw new ApiError(status, code, out.message || '规划参数有误');
    }
    return sendJson(res, out);
  }

  if (head === 'asset') {
    const kind = seg[2], id = seg[3];
    const size = url.searchParams.get('size') || 'icon';
    // 星铁的 kind 走 resolveArt 里的星铁分支（data/assets/sr/**）
    const file = vX.resolveArt(kind, id, size) || (gameId === 'starrail' ? null : v1.resolveArt(kind, id, size));
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
    const sessionId = games.scope(auth.hash,gameId,body.sessionId || 'default');
    const think = typeof body.think === 'boolean' ? body.think : undefined;
    // 玩家自己的角色清单（存在客户端 localStorage，随请求带来）。
    // 规划要「按这个号算」，但服务端拿不到用户身份（所有客户端共用一个 token），
    // 所以清单只能由客户端带。形状与 /v1/plan 的 roster 一致。
    // 只做最外层校验：非数组就当没带，剩下的交给 buildPlan 逐条判断。
    const roster = Array.isArray(body.roster)
      ? body.roster.slice(0, 20).map((r) => ({
        charId: Number(r && r.charId),
        level: Number(r && r.level),
        name: String((r && r.name) || ''),
      })).filter((r) => Number.isFinite(r.charId))
      : [];
    // 用户在输入框上方**明确选的技能**（点技能卡来的）。
    // 有它就不再靠正则猜他要什么 —— 他已经说了。空串表示没选。
    const skill = String(body.skill || '').slice(0, 40);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };

    const ac = new AbortController();
    res.on('close', () => { if(!res.writableEnded) ac.abort(); });

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

    const webSources = []; // Local-only build never performs web fallback.
    send({type:'progress',phase:'retrieving',label:'正在检索本机资料'});
    const it = runChat(v1.db, CHAT_DIR, chatInput);
    try {
      for await (const ev of it) {
        // ---- 检索到的实体 + 覆盖回报，后面造块与闸门都要用
        if (ev.type === 'meta') { entities = ev.entities || []; coverage = ev.coverage || null; send(ev); continue; }
        // ---- 生成之前的闸门：一条都没检索到 -> 直接拒答，**模型根本不被调用**
        if (ev.type === 'sources') {
          kept = ev.sources || [];
          const answerId = workspace.capture(auth.hash,gameId,kept,corpusVersion());
          send({type:'evidence',answerId,revision:corpusVersion()});
          send({type:'progress',phase:'evidence',label:'正在整理依据'});
          send(ev);
          // coverage 一并交给闸门：识别到了库里的条目、只是没取到资料时，不许硬拒答
          // （「问题点名了库里的条目」本身就说明这不是库外问题）。
          gate = assessRetrieval({ sources: kept, anchors, coverage });
          // 库内为空但联网搜到了东西 → 不拒答，改走网络结果生成。
          // level 用 'web' 而不是 'ok'，让客户端能明确区分「可回溯」与「来自网络」。
          if (gate.refuse && webSources.length) {
            gate = {
              level: 'web',
              refuse: false,
              reason: `知识库无相关结果，已改查网络（${webSources.length} 条，未经观测枢核对）`,
              webSources: webSources.map((w) => ({ ref: w.ref, title: w.title, url: w.url })),
            };
          }
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
            blocks = buildBlocks({ v1, question: message, anchors, entities, videoIndex, roster, skill });
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
        // 深度思考增量：**照常转发给客户端**（前端折叠展示）。
        // 早先这里写成 `continue` 直接丢弃，导致界面那个 🧠 开关点了没反应 ——
        // 模型确实在思考（llm.mjs 会 yield thinking），只是被这一行吞了。
        if (ev.type === 'provider') { provider = ev.provider || ''; send({type:'progress',phase:'generating',label:provider==='extractive'?'正在整理资料摘录':'模型正在生成回答'}); }
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
