// 诊断：走客户端唯一契约 /v1，确认 UTF-8 正常 + 实体识别正常。
// 用法：node tools/diag-v1-probe.mjs --file tools/diag-think.txt
const BASE = process.env.KB_V1 || 'http://127.0.0.1:5180';
const TOKEN = process.env.KB_TOKEN || '';
if (!TOKEN) {
  console.error('Missing KB_TOKEN. Example: $env:KB_TOKEN = "your-token"; node tools/diag-v1-probe.mjs --file questions.txt');
  process.exit(2);
}

// 中文问题绝不走 argv（PowerShell/CMD 会把非 ASCII 变成 ?），
// 一律从 UTF-8 文件读：node tools/diag-v1-probe.mjs --file questions.txt
import fs from 'node:fs';
const args = process.argv.slice(2);
let questions;
const fi = args.indexOf('--file');
if (fi >= 0) {
  const file = args[fi + 1];
  questions = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
} else {
  throw new Error('Chinese probes must use --file with a UTF-8 question file.');
}
// --think 让本轮开启深度思考（客户端「深度思考」开关走的就是这个字段）
const THINK = args.includes('--think');

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

for (const q of questions) {
  process.stdout.write(`\n================ ${q}\n`);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: q, sessionId: 'diag-' + Math.random().toString(36).slice(2, 8), think: THINK }),
  });
  if (!res.ok) {
    console.log(`HTTP ${res.status} ${await res.text()}`);
    continue;
  }
  const raw = await res.text();
  // 解析 SSE
  let meta = null, provider = null, done = null, deltas = [], thinking = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d) continue;
    let j; try { j = JSON.parse(d); } catch { continue; }
    if (j.type === 'meta') meta = j;
    else if (j.type === 'provider') provider = j;
    else if (j.type === 'delta') deltas.push(j.text);
    else if (j.type === 'thinking') thinking.push(j.text || '');
    else if (j.type === 'done') done = j;
  }
  console.log('entities :', JSON.stringify(meta?.entities));
  console.log('scopes   :', JSON.stringify(meta?.scopes));
  console.log('coverage :', JSON.stringify(meta?.coverage));
  console.log('srcCount :', meta?.sourceCount, ' chars:', meta?.contextChars);
  console.log('provider :', provider?.provider, provider?.model);
  console.log('done     :', done?.provider, done?.model, 'degraded=' + done?.degraded);
  console.log('elapsed  :', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const answer = done?.answer || deltas.join('');
  console.log('正文     :', answer.length, '字   思考:', done?.reasoningChars ?? '(未知)', '字');
  if (!answer.trim()) console.log('⚠⚠ 正文为空 —— 这一轮没有可用回答');
  console.log('--- answer (first 600) ---');
  console.log(answer.slice(0, 600));
  console.log('--- /answer ---');
}
