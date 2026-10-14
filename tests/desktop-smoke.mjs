// 验证「原神知识库 · 桌面版」这个 Electron 应用本身。
//
//   node desktop/launch.mjs --debug-port 9340     # 先把桌面版拉起来
//   node test/desktop-smoke.mjs                   # 再跑本测试
//
// 连到桌面版自己的 Chromium 调试端口，断言的是**应用窗口里真实渲染的东西**，
// 不是另开一个浏览器去访问同一个网址。
//
// 关键点：桌面版启动时会先显示 splash 再切到主界面，**导航会作废 CDP 的执行上下文**，
// 早期 evaluate 会抛「Inspected target navigated or closed」。所以这里统一用
// waitFor() —— 出错就重试，而不是假设页面已经稳定。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'test-results', 'ui-smoke');
const PORT = Number(process.argv[2] || 9340);
const EXPECT_URL = process.env.CHAT_URL || 'http://127.0.0.1:5190/';

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = async (label, fn) => {
  try { const i = await fn(); console.log(`  [ok] ${label}${i ? ' :: ' + String(i).slice(0, 170) : ''}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${label} :: ${e.message}`); }
};

let ws; let msgId = 0; const pending = new Map();
function send(method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, t });
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

/** 轮询直到表达式返回真值；期间容忍「导航导致上下文失效」这类错误。 */
async function waitFor(expr, { timeout = 40000, every = 350, what = '条件' } = {}) {
  const until = Date.now() + timeout;
  let last = null;
  while (Date.now() < until) {
    try {
      const v = await evaluate(expr);
      if (v) return v;
      last = new Error('返回空: ' + JSON.stringify(v));
    } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`等 ${what} 超时${last ? '（最后一次：' + last.message.slice(0, 90) + '）' : ''}`);
}

async function shot(name) {
  if (process.env.SMOKE_CAPTURE === '0') return '(hidden package screenshot disabled)';
  // 截图是取证用的，偶发超时（窗口被遮挡/合成慢）不该让整个测试失败
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 90000);
  const f = path.join(OUT, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}

try {
  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  if (!ver) throw new Error(`连不上桌面版的调试端口 ${PORT}。先跑：node desktop/launch.mjs --debug-port ${PORT}`);
  console.log(`桌面版运行时: ${ver.Browser}`);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有窗口');
  console.log(`  窗口标题: ${page.title}`);

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, t } = pending.get(m.id);
      clearTimeout(t); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  await send('Page.enable'); await send('Runtime.enable');

  await check('确实是 Electron 运行时（不是普通浏览器）', async () => {
    const r = await waitFor(
      `return navigator.userAgent.includes('Electron') ? { ua: navigator.userAgent } : null;`,
      { what: '拿到 UA' });
    return r.ua.slice(0, 112);
  });

  await check('窗口自动加载对话前端（并自动拉起 5190）', async () => {
    const r = await waitFor(
      `return (location.href.startsWith(${JSON.stringify(EXPECT_URL)}) && document.title) ? { href: location.href, title: document.title } : null;`,
      { what: '窗口落到 5190' });
    if (!r.href.startsWith(EXPECT_URL)) throw new Error(`地址不对: ${r.href}`);
    return `${r.href} · ${r.title}`;
  });

  await check('界面完整渲染（外壳 + 模型状态 + 侧栏）', async () => {
    // 注意：桌面版会持久化上次的对话，进来**不一定是空状态**（所以不能拿 .starter 当就绪标志）
    const r = await waitFor(`
      const model = document.getElementById('model');
      if (!model || /连接中/.test(model.textContent)) return null;
      if (!document.getElementById('input') || !document.getElementById('send')) return null;
      if (!document.getElementById('new')) return null;
      return { model: model.textContent, dot: document.getElementById('dot').className,
               convos: document.querySelectorAll('.convo').length };
    `, { what: '界面就绪' });
    return `${r.model} · ${r.dot} · 侧栏 ${r.convos} 个会话`;
  });

  await check('点「新对话」回到空状态（起始提示出现）', async () => {
    await evaluate(`document.getElementById('new').click(); return 1;`);
    const r = await waitFor(
      `const s = document.querySelectorAll('.starter'); return s.length ? { n: s.length } : null;`,
      { timeout: 12000, what: '起始提示' });
    return `${r.n} 个起始提示`;
  });

  await check('在桌面窗口里真能问答（流式 + 引用）', async () => {
    // 走输入框 + 发送按钮（和真人操作一致），不依赖起始提示
    await evaluate(`
      const ta = document.getElementById('input');
      ta.value = '胡桃是谁？一句话';
      ta.dispatchEvent(new Event('input'));
      document.getElementById('send').click();
      return 1;
    `);
    const r = await waitFor(`
      const body = document.querySelector('.msg.bot .body');
      if (!body || body.innerText.trim().length <= 10 || document.querySelector('.cursor')) return null;
      return { chars: body.innerText.trim().length,
               cites: body.querySelectorAll('.cite').length,
               srcs: document.querySelectorAll('.sources .src').length,
               sample: body.innerText.trim().slice(0, 70) };
    `, { timeout: 60000, what: '回答生成完' });
    if (!r.cites) throw new Error('回答里没有引用标记');
    return `${r.chars} 字 · ${r.cites} 个引用 · ${r.srcs} 个来源 · 「${r.sample.replace(/\s+/g, ' ')}」`;
  });

  await check('侧栏会话在桌面版里正常（问过的会留下）', async () => {
    const r = await waitFor(
      `const c = document.querySelectorAll('.convo'); return c.length ? { n: c.length, title: c[0].querySelector('.t').textContent } : null;`,
      { what: '侧栏会话' });
    return `${r.n} 个会话 · 首个「${r.title}」`;
  });

  // 截图前再问一句，让画面有内容
  try {
    await evaluate(`document.querySelectorAll('.starter')[1]?.click(); return 1;`);
    await waitFor(`
      const b = document.querySelector('.msg.bot .body');
      return (b && b.innerText.trim().length > 10 && !document.querySelector('.cursor')) ? 1 : null;
    `, { timeout: 60000, what: '内容渲染' });
  } catch { /* 截图不因这句失败 */ }
  try {
    const s = await shot('desktop-app.png');
    console.log(`  [截图] ${s}`);
  } catch (e) {
    console.log(`  [截图] 跳过（${e.message}）—— 不影响功能结论`);
  }
} catch (e) {
  fail++; console.log(`\n[FATAL] ${e.message}`);
} finally {
  try { ws && ws.close(); } catch {}
}
console.log(fail ? `\n${fail} 项失败` : '\n桌面版验证通过 🖥️');
process.exit(fail ? 1 : 0);
