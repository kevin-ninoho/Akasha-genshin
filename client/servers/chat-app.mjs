// 类 GPT 前端服务：把知识库内置的 AI 抽出来独立使用。
//
//   node servers/chat-app.mjs [--port 5190]
//
// 零依赖，只用 Node 内置模块。四件事：
//   1. 托管 web/chat/ 的静态页
//   2. Only authenticated /v1 routes are proxied.
//   3. 把 /v1/* 反代到**对外接口**（默认 127.0.0.1:5180）—— 对话用这条。
//      对话走 /v1 而不是 /kb/api/chat 的原因：只有 /v1 会发 grounding（依据强度）、
//      audit（引用审计）和 blocks（结构化答案块）。老接口这三样都没有。
//   4. 关键：/v1/chat 是 SSE 流，必须**原样透传、不缓冲**，
//      否则打字机效果会变成"等全部生成完再一次性出现"
//
// 为什么反代而不是让页面直连：同源可以免掉 CORS，前端不用关心后端地址；
// 而且**本地模式下 token 由这里服务端注入** —— 用户不该为了用自己电脑上的
// 工具，先去手抄一串客户端 token。远端部署时 token 在服务端配置里，客户端同样拿不到。

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.join(HERE, '..');
const WEB = path.join(SUITE, 'web', 'chat');

const argPort = process.argv.indexOf('--port');
const PORT = argPort >= 0 ? Number(process.argv[argPort + 1]) : Number(process.env.CHAT_PORT || 5190);
const V1 = process.env.KB_V1_UPSTREAM || 'http://127.0.0.1:5180';
const V1_URL = new URL(V1);
// 本地默认：从 KB_CLIENT_TOKEN 注入。页面自己带了 Authorization 时以页面的为准
// （远端模式用得上：那时用户有自己的 token）。
const V1_TOKEN = process.env.KB_CLIENT_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function proxyV1(req, res) {
  const sub = req.url.replace(/^\/v1/, '') || '/';
  const headers = { ...req.headers, host: V1_URL.host };
  if (V1_TOKEN && !headers.authorization) headers.authorization = `Bearer ${V1_TOKEN}`;

  const transport = V1_URL.protocol === 'https:' ? https : http;
  const up = transport.request({
    hostname: V1_URL.hostname,
    port: V1_URL.port || (V1_URL.protocol === 'https:' ? 443 : 80),
    path: '/v1' + sub,
    method: req.method,
    headers,
  }, (upRes) => {
    const out = { ...upRes.headers };
    if (String(out['content-type'] || '').includes('text/event-stream')) {
      delete out['content-length'];
      out['cache-control'] = 'no-store';
      out['x-accel-buffering'] = 'no';
    }
    res.writeHead(upRes.statusCode, out);
    upRes.pipe(res);
  });
  up.on('error', (err) => {
    if (res.headersSent) return res.end();
    sendJson(res, 502, {
      ok: false,
      error: 'v1_unreachable',
      message: '无法连接知识库接口，请检查服务配置。',
    });
  });
  req.pipe(up);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(WEB, rel);
  // 目录穿越防护
  const relative = path.relative(WEB, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      // 这是本地工具：改完直接刷新就生效，不要被缓存挡住
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_url' });
  }

  if (url.pathname === '/config.json') {
    // 引用 chip **永远不可点**，与运行模式无关。
    //
    // 这里以前按模式分叉：客户端模式给空地址、本地模式给知识库地址。
    // 结果是本地模式下引用变成了可点链接，一点就打开知识库本体（5178）——
    // 那是一条绕过 /v1 的路：不过 token、不记配额、不做引用审计，
    // 点开就能把整个库翻一遍，把「客户端不得以任何形式直接访问知识库全部内容」
    // 这条硬约束整个绕过去了。
    //
    // 现在规则只剩一条：kbLink / kbBase 恒为空，前端渲染成不可点的标签
    //（见 web/chat/app.js 的 canLink 分支，那条分支本来就在）。
    // 自己要看知识库用浏览器开 5178 —— 那是你的机器，不该是客户端界面里的入口。
    return sendJson(res, 200, {
      kbBase: '',
      // 引用里的 url 形如 "#/character/91"，前缀为空 => 不可点
      kbLink: '',
      v1Base: '/v1',
      // 客户端据此决定要不要显示「自备 Key / 内置额度」那类界面
      hasServerToken: !!V1_TOKEN,
    });
  }
  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'dsh-chat-front' });
  }
  if (url.pathname.startsWith('/v1/')) return proxyV1(req, res);
  if (url.pathname.startsWith('/kb/')) return sendJson(res, 404, { ok: false, error: 'not_available' });
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`类 GPT 前端: http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`  对外接口:   ${V1}${V1_TOKEN ? '（已注入客户端 token）' : '（未配置 token）'}\n`);
});
