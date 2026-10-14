import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const KB = process.env.KB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine');
const { runChat, invalidateRetriever } = await import(pathToFileURL(path.join(KB, 'chat/agent.mjs')));
const db = new DatabaseSync(path.join(process.env.KB_DATA_DIR || (process.env.KB_DATA_DIR || path.join(KB,'data')),'kb.sqlite'), { readOnly: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akasha-empty-answer-'));
const question = fs.readFileSync(new URL('./questions/basic.txt',import.meta.url),'utf8').trim();
let scenario, requests;
const upstream = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-primary' }] })); return; }
  let body = ''; for await (const b of req) body += b;
  const payload = JSON.parse(body); requests.push({ path: req.url, payload });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
  const fallback = req.url.startsWith('/fallback');
  const call = requests.length;
  if (scenario === 'interrupt') { send({ content: 'Partial answer[1].' }); setTimeout(() => res.destroy(), 35); return; }
  if (scenario === 'whitespace') { send({ content: ' \n ' }); }
  else if (scenario === 'cancel') { send({ reasoning_content: 'First reasoning.' }); await new Promise(r => setTimeout(r, 100)); }
  else if (scenario === 'recover' && call > 1) { send({ reasoning_content: 'Retry reasoning must be hidden.' }); send({ content: 'Recovered answer[1].' }); }
  else if (scenario === 'fallback' && fallback) { send({ content: 'Fallback answer[1].' }); }
  else if (scenario !== 'empty') { send({ reasoning_content: 'First reasoning.' }); }
  send({}, scenario === 'recover' && call > 1 ? 'stop' : 'length');
  res.end('data: [DONE]\n\n');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;
fs.writeFileSync(path.join(dir, 'llm.config.json'), JSON.stringify({ provider: 'openai', baseUrl: base + '/primary/v1', model: 'mock-primary', maxTokens: 128, extraBody: { thinking: { type: 'enabled' } }, fallback: { baseUrl: base + '/fallback/v1', model: 'mock-fallback' } }));
// Do not let a developer's real model overrides escape the local mock.
const old = {}; for (const k of ['KB_LLM_BASE_URL', 'KB_LLM_MODEL', 'KB_LLM_API_KEY', 'KB_LLM_PROVIDER','KB_LLM_CONFIG_PATH']) { old[k] = process.env[k]; delete process.env[k]; }
let failures = 0;
async function test(name, kind, check) {
  scenario = kind; requests = []; invalidateRetriever();
  const events = [], ac = new AbortController();
  for await (const ev of runChat(db, dir, { message: question, sessionId: 'mock-' + kind, think: true, signal: ac.signal })) { events.push(ev); if (kind === 'cancel' && ev.type === 'thinking') ac.abort(); }
  try { check(events, events.find(e => e.type === 'done')); console.log('PASS ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); }
}
try {
  await test('reasoning-only retries with thinking disabled and nonempty answer', 'recover', (events, done) => {
    assert.equal(requests.length, 2); assert.equal(requests[1].payload.thinking.type, 'disabled');
    assert.equal(events.filter(e => e.type === 'thinking').map(e => e.text).join(''), 'First reasoning.');
    assert.equal(done.answer, 'Recovered answer[1].'); assert.equal(done.degraded, false);
  });
  await test('empty primary uses real fallback before extraction', 'fallback', (_, done) => {
    assert.equal(requests.length, 4); assert.equal(done.model, 'mock-fallback'); assert.equal(done.answer, 'Fallback answer[1].');
  });
  await test('all empty models yield nonempty degraded extraction', 'empty', (_, done) => {
    assert.equal(requests.length, 5); assert.ok(done.answer.trim()); assert.equal(done.degraded, true);
  });
  await test('all reasoning-only models do not emit repeated thinking', 'reasoning', (events, done) => {
    assert.equal(requests.length, 5); assert.ok(done.answer.trim()); assert.equal(done.degraded, true);
    assert.equal(events.filter(e => e.type === 'thinking').length, 1);
  });
  await test('emitted whitespace cannot retry or report success', 'whitespace', (events, done) => {
    assert.equal(requests.length, 1); assert.equal(done.failed, true); assert.ok(done.degraded || done.answer.trim()); assert.ok(events.some(e => e.type === 'error'));
  });
  await test('partial body interruption never retries or appends extraction', 'interrupt', (events, done) => {
    assert.equal(requests.length, 1); assert.equal(done.answer, 'Partial answer[1].'); assert.equal(done.failed, true);
    assert.equal(events.filter(e => e.type === 'delta').length, 1); assert.equal(done.provider, 'interrupted');
  });
  await test('cancellation does not retry or generate fallback content', 'cancel', (events, done) => {
    assert.equal(requests.length, 1); assert.equal(done.failed, true); assert.equal(done.answer, ''); assert.ok(!events.some(e => e.type === 'delta'));
  });
} finally {
  for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`Result: ${7 - failures}/7 passed`);
process.exitCode = failures ? 1 : 0;
