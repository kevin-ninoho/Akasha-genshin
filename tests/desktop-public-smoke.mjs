import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.AKASHA_SMOKE_EXE;
if (!exe) { console.error('Set AKASHA_SMOKE_EXE to the Electron runtime or packaged Akasha executable.'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'akasha-public-desktop-'));
const userData = path.join(profile, 'userData'); fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ kbDir: path.join(root, 'engine') }));
const port = 40000 + Math.floor(Math.random() * 5000), debug = port + 2;
const env = { ...process.env, AKASHA_ROOT: profile, AKASHA_TEST_USER_DATA: userData, AKASHA_V1_PORT: String(port), AKASHA_TEST_CHAT_PORT: String(port + 1), DESKTOP_DEBUG_PORT: String(debug), AKASHA_TEST_HIDDEN: '1', KB_CLIENT_PORT: String(port), KB_CLIENT_HOST: '127.0.0.1', KB_CLIENT_TOKEN: 'akasha_public_desktop_test_token', KB_LLM_CONFIG_PATH: path.join(profile, 'absent-model.json'), KB_LLM_PROVIDER: 'extractive', KB_DATA_DIR: path.join(profile, 'empty-data'), KB_VIDEO_INDEX_PATH: '', TEMP: profile, TMP: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.AKASHA_TEST_V1;
const args = process.env.AKASHA_SMOKE_DEV === '1' ? [path.join(root, 'client')] : [];
const smokeLog = process.env.AKASHA_SMOKE_LOG ? fs.openSync(process.env.AKASHA_SMOKE_LOG, 'w') : null;
const serviceChildren = [];
let child;
let ws, id = 0, passed = 0; const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = text => { passed++; console.log('PASS ' + text); };
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(Error('CDP timeout ' + method)); }, 15000); pending.set(key, { resolve, reject, timer }); ws.send(JSON.stringify({ id: key, method, params })); }); }
async function evaluate(expression) { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error('Desktop script evaluation failed'); return result.result.value; }
async function until(expression) { for (let i = 0; i < 100; i++) { try { const result = await evaluate(expression); if (result) return result; } catch {} await sleep(200); } throw Error('Desktop condition timed out'); }
try {
  if (process.env.AKASHA_SMOKE_DEV !== '1') {
    const resources = path.join(path.dirname(exe), 'resources');
    serviceChildren.push(spawn(process.execPath, [path.join(resources, 'engine', 'serve-client.mjs')], { cwd: root, env, windowsHide: true, stdio: 'ignore' }));
    serviceChildren.push(spawn(process.execPath, [path.join(resources, 'servers', 'chat-app.mjs'), '--port', String(port + 1)], { cwd: resources, env: { ...env, KB_V1_UPSTREAM: `http://127.0.0.1:${port}` }, windowsHide: true, stdio: 'ignore' }));
    for (let i = 0; i < 150; i++) {
      try {
        const [status, health] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Authorization: 'Bearer akasha_public_desktop_test_token' } }),
          fetch(`http://127.0.0.1:${port + 1}/health`),
        ]);
        if (status.ok && health.ok) break;
      } catch {}
      if (i === 149) throw Error('packaged local services did not become ready');
      await sleep(200);
    }
  }
  child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: smokeLog ? ['ignore', smokeLog, smokeLog] : 'ignore' });
  let target;
  for (let i = 0, max = process.env.AKASHA_SMOKE_DEV === '1' ? 350 : 50; i < max; i++) { try { const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json(); target = targets.find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${port + 1}`)); } catch {} if (target) break; await sleep(200); }
  if (!target) target = (await fetch(`http://127.0.0.1:${debug}/json/list`).then(r => r.json()).catch(() => [])).find(t => t.type === 'page');
  assert.ok(target, 'isolated Electron did not expose a page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return; clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(Error('CDP command failed')) : request.resolve(message.result); });
  await cdp('Page.enable');
  if (!target.url.startsWith(`http://127.0.0.1:${port + 1}`)) {
    await cdp('Page.enable');
    const navigation = await cdp('Page.navigate', { url: `http://127.0.0.1:${port + 1}/` });
    await sleep(1000);
    const currentUrl = await evaluate('location.href');
    console.log(`DIAGNOSTIC initial desktop URL was blank; manual local navigation=${navigation.errorText || 'ok'}; final origin=${new URL(currentUrl).origin}`);
  }
  assert.equal(await evaluate("navigator.userAgent.includes('Electron')"), true); ok('actual isolated Electron window opens chat');
  await until("document.getElementById('model')?.textContent.includes('未配置资料库')"); ok('missing-corpus guidance appears in the desktop status');
  const status = await evaluate("fetch('/v1/status').then(r=>r.json())");
  assert.equal(status.ready, false); assert.equal(status.capabilities.corpus, false); ok('packaged engine starts with no copyrighted data');
  const choices = await evaluate("document.getElementById('wallpaper-picker').click();({count:document.querySelectorAll('#wallpaper-menu [data-wallpaper]').length,thumbs:[...document.querySelectorAll('#wallpaper-menu img')].map(i=>i.src.split('/').pop())})");
  assert.equal(choices.count, 7); assert.equal(new Set(choices.thumbs).size, 7); ok('seven selectable Archon background thumbnails appear in the header');
  const wallpaperIds = ['venti', 'zhongli', 'raiden', 'nahida', 'focalors', 'mavuika', 'tsaritsa'];
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await evaluate("localStorage.setItem('akasha.theme','dark');window.AkashaTheme.apply('dark');true");
  for (const id of wallpaperIds) {
    await evaluate("if(document.getElementById('wallpaper-menu').hidden)document.getElementById('wallpaper-picker').click();true");
    await evaluate(`document.querySelector('[data-wallpaper="${id}"]').click();true`);
    await until(`document.documentElement.style.getPropertyValue('--akasha-wallpaper').includes('/${id}.webp')`);
    console.log('APPLIED '+id);
    await until(`window.AkashaStore.get('preferences','appearance',{}).then(p=>p.wallpaper==='${id}')`);
    console.log('SAVED '+id);
    const themed = await evaluate("(()=>{document.getElementById('theme').click();const first=getComputedStyle(document.body).backgroundImage;document.getElementById('theme').click();return {first,second:getComputedStyle(document.body).backgroundImage,theme:document.documentElement.dataset.theme}})()");
    assert.match(themed.first, new RegExp(`${id}\\.webp`)); assert.match(themed.second, new RegExp(`${id}\\.webp`)); assert.notEqual(themed.first, themed.second, 'theme changes wallpaper overlay');
    assert.equal(themed.theme, 'dark');
    await evaluate(`(async()=>{const img=new Image();img.src='/assets/archons/${id}.webp';await img.decode();return img.naturalWidth>0})()`);
    console.log('CHECKED background '+id);
    await evaluate("document.getElementById('theme').click();true");
    await evaluate("document.getElementById('theme').click();true");
  }
  await evaluate("window.AkashaWorkbench.go('settings')");
  await evaluate("document.getElementById('font-size').value='16';document.getElementById('font-size').dispatchEvent(new Event('change',{bubbles:true}));true");
  await until("window.AkashaStore.get('preferences','appearance',{}).then(p=>p.wallpaper==='tsaritsa'&&p.fontSize===16)");
  ok('font settings preserve the selected background');
  await evaluate('location.reload();true');
  await until("document.documentElement.style.getPropertyValue('--akasha-wallpaper').includes('/tsaritsa.webp')");
  const restoredWallpaper = await evaluate("Promise.all([window.AkashaStore.get('preferences','appearance',{}),Promise.resolve(getComputedStyle(document.body).backgroundImage)])");
  assert.equal(restoredWallpaper[0].wallpaper, 'tsaritsa'); assert.match(restoredWallpaper[1], /tsaritsa\.webp/); ok('selected background persists through reload and both appearance themes');
  for (const [width, height, scale] of [[1280,720,1],[1920,1080,1],[720,900,1],[1280,720,2]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await evaluate("document.getElementById('wallpaper-picker').click();true");
    const layout = await evaluate("(()=>{const m=document.getElementById('wallpaper-menu').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,left:m.left,right:m.right,width:innerWidth}})()");
    assert.equal(layout.overflow, false); assert.ok(layout.left>=0 && layout.right<=layout.width);
    const keyboard = await evaluate("(()=>{const b=document.getElementById('wallpaper-picker');b.focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return {hidden:document.getElementById('wallpaper-menu').hidden,focus:document.activeElement===b,expanded:b.getAttribute('aria-expanded')}})()");
    assert.equal(keyboard.hidden,true); assert.equal(keyboard.focus,true); assert.equal(keyboard.expanded,'false');
  }
  ok('picker fits narrow, desktop and high-DPI layouts; Escape restores focus');
  await evaluate("document.getElementById('input').value='测试问题';document.getElementById('send').click();true");
  const error = await until("document.querySelector('.msg.bot .err')?.textContent"); assert.match(error, /未配置资料库/); assert.doesNotMatch(error, /[A-Z]:\\|Error:|at /); ok('chat error provides configuration guidance without a stack or path');
  const boundary = await evaluate("(async()=>({codes:await Promise.all(['/kb/','/kb/api/chat/status','/kb/api/query'].map(p=>fetch(p).then(r=>r.status))),links:document.querySelectorAll('a[href^=\"http\"]').length}))()");
  assert.ok(boundary.codes.every(code => code === 404)); assert.equal(boundary.links, 0); ok('desktop preserves closed KB routes and external-link boundary');
  assert.equal(await evaluate("window.open('https://example.invalid/') === null"), true); ok('new browser windows remain denied');
  console.log(`DESKTOP PUBLIC ${passed}/${passed} passed`);
} finally {
  if (ws) { try { await cdp('Browser.close'); } catch {} ws.close(); }
  for (const request of pending.values()) clearTimeout(request.timer); pending.clear();
  if (child) { for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100); if (child.exitCode === null) child.kill(); }
  for (const service of serviceChildren) if (service.exitCode === null) service.kill();
  await Promise.all(serviceChildren.map(service => new Promise(resolve => service.exitCode !== null ? resolve() : service.once('exit', resolve))));
  await sleep(500);
  if (smokeLog !== null) fs.closeSync(smokeLog);
  if (process.env.AKASHA_KEEP_TEST_PROFILE !== '1') {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* own test profile may still be releasing handles */ }
  } else console.log(`TEST PROFILE retained for diagnostics: ${profile}`);
}
