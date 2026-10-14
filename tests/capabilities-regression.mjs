import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { buildMessages } from '../engine/chat/prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'akasha-capabilities-'));
const data = path.join(temp, 'data'), source = path.join(temp, 'source');
fs.mkdirSync(path.join(source, '原神'), { recursive: true });
fs.writeFileSync(path.join(source, '原神', '【原神】测试角色.md'), '# 测试角色\n\n## 基础档案\n\n| 字段 | 内容 |\n| --- | --- |\n| 身份 | 模拟测试人员 |\n\n## 角色故事\n\n#### 故事一\n\n测试角色在测试地区参加模拟剧情。这段文字仅用于程序测试。\n');
const env = { ...process.env, KB_SOURCE_DIR: source, KB_DATA_DIR: data, KB_VIDEO_INDEX_PATH: '', KB_LLM_CONFIG_PATH: path.join(temp, 'no-config.json'), KB_LLM_PROVIDER: 'auto', KB_LLM_BASE_URL: 'http://127.0.0.1:1/v1', KB_LLM_API_KEY: '' };
const build = spawnSync(process.execPath, [path.join(root, 'engine', 'build.mjs')], { cwd: root, env, encoding: 'utf8', windowsHide: true });
assert.equal(build.status, 0, 'synthetic corpus build failed');
const port = 35000 + Math.floor(Math.random() * 2000), token = 'akasha_capabilities_test_token';
const child = spawn(process.execPath, [path.join(root, 'engine', 'serve-client.mjs')], { cwd: root, env: { ...env, KB_CLIENT_PORT: String(port), KB_CLIENT_TOKEN: token, KB_MEDIA_CACHE: path.join(temp, 'media') }, windowsHide: true, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`, headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
let count = 0; const ok = name => { count++; console.log('PASS ' + name); };
try {
  let up = false; for (let i = 0; i < 100; i++) { try { up = (await fetch(base + '/v1/health')).ok; } catch {} if (up) break; await new Promise(r => setTimeout(r, 50)); } assert.ok(up);
  const status = await (await fetch(base + '/v1/status', { headers })).json();
  assert.equal(status.capabilities.corpus, true); assert.equal(status.storylineAvailable, false); assert.equal(status.provider, 'extractive');
  ok('corpus works while absent local model and storyline are explicitly reported');
  const response = await fetch(base + '/v1/chat', { method: 'POST', headers, body: JSON.stringify({ message: '测试角色的剧情故事', sessionId: 'synthetic' }) });
  assert.equal(response.status, 200); const text = await response.text();
  const events = text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  const done = events.find(event => event.type === 'done');
  assert.equal(done.provider, 'extractive'); assert.equal(done.failed, false); assert.ok(done.answer.trim());
  assert.match(done.answer, /当前未配置剧情线考据资料/); assert.match(done.answer, /测试角色/);
  assert.ok(events.find(event => event.type === 'sources').sources.length);
  ok('no-model mode preserves actual retrieval, citations and a storyline capability notice');
  const sequence = ['meta', 'sources', 'grounding', 'blocks', 'provider', 'audit', 'done', 'eof'];
  let previous = -1; for (const type of sequence) { const position = events.findIndex(event => event.type === type); assert.ok(position > previous, type); previous = position; }
  ok('normal SSE keeps the declared source/block/audit order');
  const messages = buildMessages('剧情考据', 'synthetic evidence', [], { storylineAvailable: false });
  assert.match(messages[0].content, /当前未配置剧情线考据资料/);
  ok('model prompt distinguishes unavailable storyline data from missing knowledge');
  console.log(`Result: ${count}/${count} passed`);
} finally { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
