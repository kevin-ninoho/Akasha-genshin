import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(repo, 'engine');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'akasha-media-api-'));
const port = 33000 + Math.floor(Math.random() * 2000);
const token = 'akasha_media_contract_test_token';
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(engine, 'serve-client.mjs')], {
  cwd: engine, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, KB_CLIENT_PORT: String(port), KB_CLIENT_TOKEN: token, KB_DATA_DIR: path.join(temp, 'empty-data'), KB_VIDEO_INDEX_PATH: '', KB_MEDIA_CACHE: path.join(temp, 'media-cache'), KB_LLM_PROVIDER: 'extractive' },
});
const owned = [child];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const ok = (name) => { passed++; console.log(`PASS ${name}`); };
async function api(route, body, auth = token, upstream = base) {
  const response = await fetch(upstream + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + '/v1/health')).ok; } catch { /* wait */ }
    if (ready) break;
    await sleep(50);
  }
  assert.ok(ready, 'test service did not start');
  assert.equal((await api('/v1/status', undefined, '')).status, 401);
  const status = await api('/v1/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.ready, false);
  assert.equal(status.body.capabilities.corpus, false);
  assert.equal(status.body.capabilities.videoIndex, false);
  ok('status stays authenticated and reports missing corpus/index capabilities');
  const catalog = await api('/v1/videos/catalog?q=synthetic');
  assert.equal(catalog.status, 200); assert.deepEqual(catalog.body.items, []); assert.equal(catalog.body.bodyAvailableLocally, false);
  ok('OBC metadata catalogue remains available without a local video index');
  const retrieve = await api('/v1/retrieve', { question: '测试' });
  assert.equal(retrieve.status, 503);
  assert.equal(retrieve.body.error.code, 'corpus_not_configured');
  ok('retrieval returns a structured missing-corpus error');
  const chat = await api('/v1/chat', { message: '测试' });
  assert.equal(chat.status, 503); assert.equal(chat.body.error.code, 'corpus_not_configured');
  ok('chat returns configuration guidance before entering SSE');
  const video = await api('/v1/videos/1');
  assert.equal(video.status, 503);
  assert.match(video.body.error.message, /未配置本地视频索引/);
  assert.doesNotMatch(JSON.stringify(video.body), /https?:|[A-Z]:\\|\.mp4/i);
  ok('unconfigured video index fails clearly without source leakage');
  for (const route of ['/v1/videos/1', '/v1/media/jobs/test', '/v1/media/assets/test/thumb/0']) {
    assert.equal((await api(route, undefined, '')).status, 401);
  }
  ok('video metadata, job state and media assets require authentication');
  // Seed a synthetic cached index; no source is downloaded and no copyrighted fixture is needed.
  const sourceUrl = path.join(temp,'synthetic.mp4');fs.writeFileSync(sourceUrl,'synthetic');const stamp=fs.statSync(sourceUrl);
  const cache = path.join(temp, 'cached-media');
  const key = crypto.createHash('sha256').update('1:0:' + sourceUrl + stamp.size + ':' + stamp.mtimeMs).digest('hex').slice(0, 24);
  const descriptor = path.join(cache, key); fs.mkdirSync(path.join(descriptor, 'thumbs'), { recursive: true });
  const relativeThumb = `/v1/media/assets/${key}/thumb/0`;
  fs.writeFileSync(path.join(descriptor, 'thumbs', '0.jpg'), Buffer.from([255, 216, 255, 217]));
  fs.writeFileSync(path.join(descriptor, 'index.json'), JSON.stringify({ indexVersion: 2, threshold: 0.30, duration: 12, hasAudio: true, scenes: [{ index: 0, start: 0, end: 6, thumbnail: relativeThumb }, { index: 1, start: 6, end: 12, thumbnail: relativeThumb }] }));
  const indexFile = path.join(temp, 'video-index.json');
  fs.writeFileSync(indexFile, JSON.stringify({ entries: [{ entryId: 1, videoIndex: 0, title: 'Synthetic PV', localPath: sourceUrl }] }));
  const configuredBase = `http://127.0.0.1:${port + 1}`;
  owned.push(spawn(process.execPath, [path.join(engine, 'serve-client.mjs')], { cwd: engine, windowsHide: true, stdio: 'ignore', env: { ...process.env, KB_CLIENT_PORT: String(port + 1), KB_CLIENT_TOKEN: token, KB_DATA_DIR: path.join(temp, 'empty-data'), KB_VIDEO_INDEX_PATH: indexFile, KB_MEDIA_CACHE: cache, KB_LLM_PROVIDER: 'extractive' } }));
  let configured = false; for (let i = 0; i < 100; i++) { try { configured = (await fetch(configuredBase + '/v1/health')).ok; } catch {} if (configured) break; await sleep(50); } assert.ok(configured);
  const metadata = await api('/v1/videos/1', undefined, token, configuredBase);
  assert.equal(metadata.status, 200); assert.equal(metadata.body.indexed, true);
  assert.doesNotMatch(JSON.stringify(metadata.body), /https?:|[A-Z]:\\/i);
  ok('configured video metadata never exposes the private source URL or path');
  let job = await api('/v1/videos/1/scenes', {}, token, configuredBase);
  for (let i = 0; i < 100 && job.body.state !== 'completed'; i++) { await sleep(20); job = await api('/v1/media/jobs/' + job.body.id, undefined, token, configuredBase); }
  assert.equal(job.body.state, 'completed'); assert.equal(job.body.result.scenes.length, 2);
  assert.doesNotMatch(JSON.stringify(job.body), /https?:|[A-Z]:\\/i);
  ok('cached scene API completes with authenticated relative thumbnail URLs');
  const thumb = await fetch(configuredBase + relativeThumb, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(thumb.status, 200); assert.equal((await thumb.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(configuredBase + relativeThumb)).status, 401);
  const full = await api('/v1/videos/1/clips', { start: 0, end: 12 }, token, configuredBase);
  assert.equal(full.status, 400); assert.doesNotMatch(JSON.stringify(full.body), /https?:|[A-Z]:\\/i);
  ok('asset API preserves auth and clipping API rejects a full-source export');
  console.log(`Result: ${passed}/${passed} passed`);
} finally {
  for (const process of owned) process.kill();
  await Promise.all(owned.map(process => new Promise(resolve => process.exitCode !== null ? resolve() : process.once('exit', resolve))));
  fs.rmSync(temp, { recursive: true, force: true });
}
