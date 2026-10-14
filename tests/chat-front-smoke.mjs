// 类 GPT 前端端到端验证（真实无头 Chrome + CDP）。
//
//   node test/chat-front-smoke.mjs [base]
//
// 覆盖：空状态起始提示 → 发问 → 流式渲染 → 引用 chip 带知识库链接 →
//      侧栏会话标题 → 多轮追问 → 刷新后本地持久化 → 新对话 → 截图

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'test-results', 'ui-smoke');
const BASE = process.argv[2] || 'http://127.0.0.1:5190';
const PORT = Number(process.env.CHAT_SMOKE_DEBUG_PORT || (38000 + Math.floor(Math.random() * 10000)));

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BROWSER = CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) { console.error('找不到 Chrome/Edge'); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-front-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-allow-origins=*', '--window-size=1280,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: 'ignore' });

let ws; let msgId = 0; const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); }, 60000);
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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const f = path.join(OUT, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}

let fail = 0;
const check = async (label, fn) => {
  try { const i = await fn(); console.log(`  [ok] ${label}${i ? ' :: ' + String(i).slice(0, 170) : ''}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${label} :: ${e.message}`); }
};

try {
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  if (!ver) throw new Error('调试端口未就绪');
  console.log(`浏览器: ${ver.Browser}   目标: ${BASE}`);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
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

  await check('页面加载：空状态 + 起始提示 + 模型状态', async () => {
    await send('Page.navigate', { url: BASE + '/' });
    const r = await evaluate(`
      for (let i=0;i<80;i++){
        const starters = document.querySelectorAll('.starter');
        const model = document.getElementById('model').textContent;
        if (starters.length && !/连接中/.test(model)) {
          return { starters: starters.length, model,
                   title: document.title,
                   dot: document.getElementById('dot').className,
                   provider: document.getElementById('provider').textContent };
        }
        await new Promise(r=>setTimeout(r,250));
      }
      return null;
    `);
    if (!r) throw new Error('页面没就绪（起始提示或模型状态没出来）');
    return `${r.starters} 个起始提示 · 模型「${r.model}」· 状态 ${r.dot}`;
  });

  await check('点起始提示发问 → 流式渲染出回答', async () => {
    const r = await evaluate(`
      document.querySelector('.starter').click();
      // 先确认出现过"生成中"状态（证明是流式而不是一次性返回）
      let sawStreaming = false;
      for (let i=0;i<120;i++){
        if (document.getElementById('hint').textContent.indexOf('生成中') >= 0) sawStreaming = true;
        const body = document.querySelector('.msg.bot .body');
        const done = !document.querySelector('.msg.bot .cursor') && body && body.innerText.trim().length > 10;
        if (done) return { sawStreaming, chars: body.innerText.trim().length };
        await new Promise(r=>setTimeout(r,250));
      }
      return { error: '30s 内没有生成完' };
    `);
    if (r.error) throw new Error(r.error);
    if (!r.chars) throw new Error('回答为空');
    return `${r.chars} 字 · 期间看到"生成中"=${r.sawStreaming}`;
  });

  await check('Markdown 渲染 + [n] 引用内联', async () => {
    const r = await evaluate(`
      const body = document.querySelector('.msg.bot .body');
      return { hasTag: /<(p|ul|ol|h[2-6]|pre|blockquote)>/.test(body.innerHTML),
               cites: body.querySelectorAll('.cite').length,
               html: body.innerHTML.slice(0, 90) };
    `);
    if (!r.hasTag) throw new Error('没有块级标签（Markdown 没渲染）');
    if (!r.cites) throw new Error('没有 [n] 引用标记');
    return `${r.cites} 个 [n] · ${r.html.replace(/\s+/g, ' ')}`;
  });

  // ⚠ 这条以前断言「引用 chip 是指向知识库的链接」（href 匹配 http://127.0.0.1:5178/#/…）。
  //   那正是被明令禁止的行为：客户端不得以任何形式直接访问知识库全部内容。
  //   现在反过来断言 —— chip 必须是**不可点**的标签，且不带 href。
  await check('引用来源 chip 不可点击（客户端不得跳回知识库）', async () => {
    const r = await evaluate(`
      for (let i=0;i<40;i++){
        const el = document.querySelector('.sources .src');
        if (el) return {
          n: document.querySelectorAll('.sources .src').length,
          tag: el.tagName.toLowerCase(),
          href: el.getAttribute('href'),
          plain: el.classList.contains('src-plain'),
          title: el.textContent.trim().slice(0,30),
        };
        await new Promise(r=>setTimeout(r,250));
      }
      return { error: '没有引用 chip' };
    `);
    if (r.error) throw new Error(r.error);
    if (r.href !== null) throw new Error(`chip 竟然带 href=${r.href}（客户端能跳回知识库）`);
    if (r.tag === 'a') throw new Error('chip 是 <a>，可点击');
    if (!r.plain) throw new Error('chip 缺少 src-plain 标记');
    return `${r.n} 个 · <${r.tag}> 无 href · ${r.title}`;
  });

  await check('侧栏出现会话且标题取自首问', async () => {
    const r = await evaluate(`
      const on = document.querySelector('.convo.on');
      return { n: document.querySelectorAll('.convo').length,
               title: on ? on.querySelector('.t').textContent : null,
               header: document.getElementById('title').textContent };
    `);
    if (!r.n) throw new Error('侧栏没有会话');
    if (!r.title || r.title === '新对话') throw new Error('标题没有从首问生成: ' + r.title);
    return `${r.n} 个会话 · 侧栏「${r.title}」· 顶栏「${r.header}」`;
  });

  await check('多轮追问（服务端保留上下文）', async () => {
    const r = await evaluate(`
      const before = document.querySelectorAll('.msg.bot').length;   // 必须在 click 之前取
      const ta = document.getElementById('input');
      ta.value = '他的语音有哪些？';
      ta.dispatchEvent(new Event('input'));
      document.getElementById('send').click();
      for (let i=0;i<120;i++){
        const bots = document.querySelectorAll('.msg.bot');
        if (bots.length > before) {
          const last = bots[bots.length-1];
          const body = last.querySelector('.body');
          if (!last.querySelector('.cursor') && body && body.innerText.trim().length > 5) {
            return { bots: bots.length, answer: body.innerText.trim().slice(0, 70),
                     nested: document.querySelectorAll('.wrap .wrap').length };
          }
        }
        await new Promise(r=>setTimeout(r,250));
      }
      return { error: '第二轮没有完成（before=' + before + '）' };
    `);
    if (r.error) throw new Error(r.error);
    if (r.nested) throw new Error(`DOM 出现嵌套 .wrap（${r.nested} 层），收尾替换写错了`);
    return `${r.bots} 条回答 · 末条「${r.answer.replace(/\s+/g, ' ')}」`;
  });

  const shot1 = await shot('chat-front.png');
  console.log(`  [截图] ${shot1}`);

  // ---------------------------------------------------------- 结构化答案块
  // 这一段是「要什么给什么」的回归：块是纯数据，画不画得出来只有真浏览器能证明。

  /** 问一句，等到出现指定选择器（或超时）。 */
  async function askAndWait(q, selector, ms = 45000) {
    return evaluate(`
      const ta = document.getElementById('input');
      ta.value = ${JSON.stringify(q)};
      ta.dispatchEvent(new Event('input'));
      const before = document.querySelectorAll('.msg.bot').length;
      document.getElementById('send').click();
      const t0 = Date.now();
      while (Date.now() - t0 < ${ms}) {
        const bots = document.querySelectorAll('.msg.bot');
        if (bots.length > before) {
          const last = bots[bots.length - 1];
          if (!last.querySelector('.cursor') && last.querySelector(${JSON.stringify(selector)})) {
            return { ok: true, waited: Date.now() - t0 };
          }
        }
        await new Promise(r => setTimeout(r, 250));
      }
      const bots = document.querySelectorAll('.msg.bot');
      const last = bots[bots.length - 1];
      return { ok: false, html: last ? last.innerHTML.slice(0, 300) : '(没有新消息)' };
    `);
  }

  await check('块：语音列表渲染成可折叠分组', async () => {
    const r = await askAndWait('胡桃的语音', '.blk-voice-list .blk-vg');
    if (!r.ok) throw new Error('没渲染出语音块: ' + (r.html || ''));
    const d = await evaluate(`
      const last = document.querySelectorAll('.msg.bot')[document.querySelectorAll('.msg.bot').length-1];
      return { groups: last.querySelectorAll('.blk-vg').length,
               title: last.querySelector('.blk h3').textContent,
               first: last.querySelector('.blk-vg summary').textContent.trim(),
               lines: last.querySelectorAll('.blk-line').length };
    `);
    return `${d.title} · ${d.groups} 组 · 首组「${d.first}」· 已渲染 ${d.lines} 条`;
  });

  await check('块：立绘图片真的加载出来（不是坏图）', async () => {
    const r = await askAndWait('胡桃的立绘', '.blk-image img');
    if (!r.ok) throw new Error('没渲染出图片块: ' + (r.html || ''));
    const d = await evaluate(`
      const last = document.querySelectorAll('.msg.bot')[document.querySelectorAll('.msg.bot').length-1];
      const imgs = [...last.querySelectorAll('.blk-image img')];
      // 等图片解码完，naturalWidth>0 才算真的取到了（否则是 404 的占位）
      for (let i=0;i<40;i++){
        if (imgs.every(im => im.complete)) break;
        await new Promise(r=>setTimeout(r,200));
      }
      return { n: imgs.length,
               loaded: imgs.filter(im => im.naturalWidth > 0).length,
               labels: imgs.map(im => (im.nextElementSibling||{}).textContent || im.alt),
               src: imgs[0] ? imgs[0].getAttribute('src') : null };
    `);
    if (d.loaded !== d.n) throw new Error(`${d.n} 张图只有 ${d.loaded} 张加载成功（src=${d.src}）`);
    return `${d.n} 张全部加载成功 · ${d.labels.join('/')}`;
  });

  await check('块：关系图 / 数据表 / 列表 / 时间轴都能画', async () => {
    const out = [];
    for (const [q, sel, label] of [
      ['胡桃和钟离什么关系', '.blk-relation-graph .blk-graph', '关系图'],
      ['胡桃的配装推荐', '.blk-stat-table .blk-tbl', '数据表'],
      ['璃月有哪些角色', '.blk-list .blk-tbl', '列表'],
      ['故事线的时间顺序', '.blk-timeline .blk-ti', '时间轴'],
    ]) {
      const r = await askAndWait(q, sel);
      if (!r.ok) throw new Error(`${label} 没渲染出来（问「${q}」）: ` + (r.html || ''));
      const d = await evaluate(`
        const last = document.querySelectorAll('.msg.bot')[document.querySelectorAll('.msg.bot').length-1];
        return { n: last.querySelectorAll(${JSON.stringify(sel)}).length };
      `);
      out.push(`${label}×${d.n}`);
    }
    return out.join(' · ');
  });

  await check('信任标记：依据强度与引用审计都显示', async () => {
    const d = await evaluate(`
      const bots = document.querySelectorAll('.msg.bot');
      const last = bots[bots.length-1];
      const tb = [...last.querySelectorAll('.tb')].map(e => e.textContent.trim());
      return { badges: tb, hasTrust: !!last.querySelector('.trust') };
    `);
    if (!d.hasTrust) throw new Error('没有 .trust 标记');
    if (!d.badges.some((b) => /依据/.test(b))) throw new Error('缺少依据强度标记: ' + d.badges.join(','));
    return d.badges.join(' · ');
  });

  await check('块不该出现在库外问题上', async () => {
    await askAndWait('红烧肉怎么做才好吃', '.body');
    const d = await evaluate(`
      const bots = document.querySelectorAll('.msg.bot');
      const last = bots[bots.length-1];
      return { blocks: last.querySelectorAll('.blocks .blk').length,
               body: (last.querySelector('.body')||{}).innerText || '' };
    `);
    if (d.blocks) throw new Error(`库外问题竟然出了 ${d.blocks} 个块`);
    return `0 个块 · 回答「${d.body.trim().slice(0, 30)}」`;
  });

  const shotBlocks = await shot('chat-front-blocks.png');
  console.log(`  [截图] ${shotBlocks}`);

  await check('刷新后会话从 localStorage 恢复', async () => {
    await send('Page.navigate', { url: BASE + '/' });
    const r = await evaluate(`
      for (let i=0;i<80;i++){
        const bots = document.querySelectorAll('.msg.bot');
        const convos = document.querySelectorAll('.convo');
        if (bots.length && convos.length) {
          return { bots: bots.length, convos: convos.length,
                   title: document.querySelector('.convo.on .t').textContent };
        }
        await new Promise(r=>setTimeout(r,200));
      }
      return { error: '刷新后没恢复' };
    `);
    if (r.error) throw new Error(r.error);
    return `${r.convos} 个会话 / ${r.bots} 条回答 · 标题「${r.title}」`;
  });

  await check('「新对话」清空视图且新增侧栏条目', async () => {
    const r = await evaluate(`
      const before = document.querySelectorAll('.convo').length;
      document.getElementById('new').click();
      await new Promise(r=>setTimeout(r,400));
      return { convos: document.querySelectorAll('.convo').length,
               before,
               msgs: document.querySelectorAll('.msg').length,
               starters: document.querySelectorAll('.starter').length,
               header: document.getElementById('title').textContent };
    `);
    if (r.convos !== r.before + 1) throw new Error(`侧栏没新增（${r.before} → ${r.convos}）`);
    if (r.msgs !== 0) throw new Error('新对话里还有旧消息');
    if (!r.starters) throw new Error('新对话没有回到空状态');
    return `${r.before} → ${r.convos} 个会话 · 回到空状态 · 标题「${r.header}」`;
  });

  await check('深度思考开关可切换并记住', async () => {
    const r = await evaluate(`
      const b = document.getElementById('think');
      b.click();
      await new Promise(r=>setTimeout(r,200));
      const on = b.classList.contains('on');
      const label = b.textContent;
      const stored = localStorage.getItem('dsh-chat-front/think');
      b.click();   // 还原
      return { on, label, stored };
    `);
    if (!r.on) throw new Error('开关没有打开');
    if (r.stored !== '1') throw new Error('没有写进 localStorage: ' + r.stored);
    return `${r.label} · localStorage=${r.stored}`;
  });

  const shot2 = await shot('chat-front-empty.png');
  console.log(`  [截图] ${shot2}`);
} catch (e) {
  fail++; console.log(`\n[FATAL] ${e.message}`);
} finally {
  try { ws && ws.close(); } catch {}
  browser.kill(); await sleep(300);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(fail ? `\n${fail} 项失败` : '\n类 GPT 前端端到端验证通过 💬');
process.exit(fail ? 1 : 0);
