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
const env = { ...process.env, AKASHA_ROOT: profile, AKASHA_TEST_USER_DATA: userData, AKASHA_V1_PORT: String(port), AKASHA_TEST_CHAT_PORT: String(port + 1), DESKTOP_DEBUG_PORT: String(debug), AKASHA_TEST_HIDDEN: '1', KB_CLIENT_TOKEN: 'akasha_public_desktop_test_token', KB_LLM_PROVIDER: 'extractive', KB_DATA_DIR: path.join(profile, 'empty-data'), KB_VIDEO_INDEX_PATH: '', TEMP: profile, TMP: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.AKASHA_TEST_V1;
const args = process.env.AKASHA_SMOKE_DEV === '1' ? [path.join(root, 'client')] : [];
const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' });
let ws, id = 0, passed = 0; const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = text => { passed++; console.log('PASS ' + text); };
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(Error('CDP timeout')); }, 15000); pending.set(key, { resolve, reject, timer }); ws.send(JSON.stringify({ id: key, method, params })); }); }
async function evaluate(expression) { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error('Desktop script evaluation failed'); return result.result.value; }
async function until(expression) { for (let i = 0; i < 100; i++) { try { const result = await evaluate(expression); if (result) return result; } catch {} await sleep(200); } throw Error('Desktop condition timed out'); }
try {
  let target;
  for (let i = 0; i < 150; i++) { try { const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json(); target = targets.find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${port + 1}`)); } catch {} if (target) break; await sleep(200); }
  assert.ok(target, 'isolated desktop did not load chat');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return; clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(Error('CDP command failed')) : request.resolve(message.result); });
  assert.equal(await evaluate("navigator.userAgent.includes('Electron')"), true); ok('actual isolated Electron window opens chat');
  const status = await evaluate("fetch('/v1/status').then(r=>r.json())");
  assert.equal(status.ready, false); assert.equal(status.capabilities.corpus, false); ok('packaged engine starts with no copyrighted data');
  await until("document.getElementById('model')?.textContent.includes('未配置资料库')"); ok('missing-corpus guidance appears in the desktop status');
  await evaluate("document.getElementById('input').value='测试问题';document.getElementById('send').click();true");
  const error = await until("document.querySelector('.msg.bot .err')?.textContent"); assert.match(error, /未配置资料库/); assert.doesNotMatch(error, /[A-Z]:\\|Error:|at /); ok('chat error provides configuration guidance without a stack or path');
  const boundary = await evaluate("(async()=>({codes:await Promise.all(['/kb/','/kb/api/chat/status','/kb/api/query'].map(p=>fetch(p).then(r=>r.status))),links:document.querySelectorAll('a[href^=\"http\"]').length}))()");
  assert.ok(boundary.codes.every(code => code === 404)); assert.equal(boundary.links, 0); ok('desktop preserves closed KB routes and external-link boundary');
  assert.equal(await evaluate("window.open('https://example.invalid/') === null"), true); ok('new browser windows remain denied');
  console.log(`DESKTOP PUBLIC ${passed}/${passed} passed`);
} finally {
  if (ws) { try { await cdp('Browser.close'); } catch {} ws.close(); }
  for (const request of pending.values()) clearTimeout(request.timer); pending.clear();
  for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* own test profile may still be releasing handles */ }
}
