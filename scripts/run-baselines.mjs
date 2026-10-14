import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'engine'), client = path.join(root, 'client');
if (!process.env.KB_DATA_DIR || !fs.existsSync(path.join(process.env.KB_DATA_DIR, 'kb.sqlite'))) {
  console.error('Baselines require an independently prepared KB_DATA_DIR. No corpus is bundled.'); process.exit(2);
}
const work = path.join(root, 'test-results', 'baselines'), temp = path.join(root, 'temp');
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(temp, { recursive: true });
const token = 'akasha_isolated_baseline_test_token';
const port = 16000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${port}`, chat = `http://127.0.0.1:${port + 1}`;
const owned = [];
const env = { ...process.env, TEMP: temp, TMP: temp, KB_DIR: engine, KB_LLM_PROVIDER: 'extractive', KB_CLIENT_TOKEN: token, KB_TOKEN: token, KB_CLIENT_RATE: '5000', KB_LLM_CONFIG_PATH: path.join(temp, 'no-model-config.json'), KB_MEDIA_CACHE: path.join(temp, 'baseline-media') };
async function ready(url) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Isolated baseline service did not become ready.'); }
function start(file, cwd, extra) { const log = fs.openSync(path.join(work, path.basename(file) + '.server.log'), 'w'); const child = spawn(process.execPath, [file], { cwd, env: { ...env, ...extra }, stdio: ['ignore', log, log], windowsHide: true }); fs.closeSync(log); owned.push(child); return child; }
async function run(name, args = [], extra = {}) {
  return new Promise(resolve => {
    const log = fs.createWriteStream(path.join(work, name + '.log')); let output = '';
    const child = spawn(process.execPath, [path.join(root, 'tests', name + '.mjs'), ...args], { cwd: root, env: { ...env, ...extra }, windowsHide: true }); owned.push(child);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log.write(chunk); output = (output + chunk).slice(-20000); });
    const timer = setTimeout(() => child.kill(), 240000);
    child.on('exit', code => { clearTimeout(timer); log.end(); const record = { name, code, tail: output.trim().split(/\r?\n/).slice(-3), failures: output.split(/\r?\n/).filter(line => /FAIL|✗/.test(line)).slice(0, 10) }; console.log(JSON.stringify(record)); resolve(record); });
  });
}
try {
  start(path.join(engine, 'serve-client.mjs'), root, { KB_CLIENT_PORT: String(port) }); await ready(base + '/v1/health');
  start(path.join(client, 'servers', 'chat-app.mjs'), root, { CHAT_PORT: String(port + 1), KB_V1_UPSTREAM: base }); await ready(chat + '/config.json');
  const results = [];
  results.push(await run('client-boundary-smoke', [], { CHAT_URL: chat }));
  results.push(await run('obc-kind-reachability'));
  results.push(await run('v1-coverage-smoke', [], { V1_COV_PORT: String(port + 2) }));
  results.push(await run('v1-grounding-smoke', [], { V1_GROUND_PORT: String(port + 3) }));
  results.push(await run('obc-newdata-retrieval', [], { V1: base }));
  results.push(await run('chat-front-smoke', [chat]));
  fs.writeFileSync(path.join(work, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('BASELINES ' + results.filter(result => result.code === 0).length + '/6');
  process.exitCode = results.every(result => result.code === 0) ? 0 : 1;
} finally { for (const child of owned) if (child.exitCode === null) child.kill(); }
