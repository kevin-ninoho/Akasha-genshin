// 「不编造」护栏测试 —— 闸门（生成前）与引用审计（生成后）。
//
//   node test/v1-grounding-smoke.mjs
//
// 分两半：
//   A. 纯函数审计 —— 喂人造的幻觉回答，断言能标出来。不依赖服务、不依赖模型。
//   B. 端到端闸门 —— 断言「检索为空时模型根本没被调用」。
//      判据是事件流里**没有 provider 事件**：runChat 是在 sources 之后才发 provider 的，
//      闸门在 sources 处就 return 掉生成器，所以 provider 永远发不出来。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB = process.env.KB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine');
const PORT = Number(process.env.V1_GROUND_PORT || 5183);
const TOKEN = 'kb_test_token_for_grounding_smoke';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 纯函数部分直接 import 被测模块（Windows 上必须用 file:// URL）
const { assessRetrieval, auditAnswer, splitSentences } =
  await import(pathToFileURL(path.join(KB, 'lib', 'grounding.mjs')).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [ok] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

// ================================================================ A. 纯函数
console.log('  ── A. 引用审计（纯函数） ──');

const SOURCES = [
  { type: 'profile', title: '胡桃 · 基础档案', text: '胡桃是往生堂第七十七代堂主，神之眼为火元素。' },
  { type: 'story', title: '胡桃 · 角色故事1', text: '胡桃的命之座是引蝶座。' },
  { type: 'voice', title: '胡桃 · 语音「初次见面…」', text: '我是往生堂第七十七代堂主胡桃。' },
];

let a = auditAnswer('胡桃是往生堂第七十七代堂主[1]。她的命之座是引蝶座[2]。', SOURCES);
ok('全部有据 → pass', a.verdict === 'pass', `verdict=${a.verdict} claims=${a.claims} cited=${a.cited}`);

a = auditAnswer('胡桃是往生堂第七十七代堂主[1]。她的生日是7月15日[9]。', SOURCES);
ok('引用了不存在的编号 [9] → fail', a.verdict === 'fail' && a.invalidRefs.includes(9),
  `verdict=${a.verdict} invalid=${JSON.stringify(a.invalidRefs)}`);

a = auditAnswer('胡桃是往生堂第七十七代堂主。她最喜欢吃水煮鱼配虾饺，讨厌清心炒史莱姆凝液。', SOURCES);
ok('通篇无引用的事实陈述 → fail', a.verdict === 'fail', `verdict=${a.verdict} unsupported=${a.unsupportedCount}`);

a = auditAnswer('胡桃是往生堂第七十七代堂主[1]。她还有一个妹妹叫胡桃桃，住在须弥。', SOURCES);
ok('有据与无据混排 → warn 并标出无据句', a.verdict === 'warn' && a.unsupportedCount >= 1,
  `verdict=${a.verdict} unsupported=${a.unsupportedCount}`);

a = auditAnswer('知识库里没有检索到和这个问题相关的内容。\n\n可以试试直接说角色名。', SOURCES);
ok('纯拒绝语不产生事实陈述 → pass', a.verdict === 'pass' && a.claims === 0, `verdict=${a.verdict} claims=${a.claims}`);

a = auditAnswer('胡桃是往生堂堂主。\n她喜欢作诗。', SOURCES, { extractive: true });
ok('检索模式直接判 pass（内容即原文摘录）', a.verdict === 'pass' && a.extractive === true, a.note);

const sents = splitSentences('- **胡桃 · 基础档案** [1]\n胡桃是往生堂堂主[2]。\n\n下一句。');
ok('分句能拆出列表项与正文', sents.length === 3, JSON.stringify(sents));

// 拒答措辞的容错：模型写「根据提供的资料，没有关于…的描述」时，
// 「资料」和「没有」中间夹着逗号。不容错会把这句**正确的拒答**误判成无据陈述。
for (const t of [
  '知识库里没有这条信息。',
  '知识库里没有这条信息。根据提供的资料，没有关于红烧肉制作方法的描述。',
  '资料没有提到相关内容。',
  '资料，没有提到相关内容。',
  '根据资料，没有收录该条目。',
  '未找到相关内容。',
]) {
  const r = auditAnswer(t, SOURCES);
  ok(`拒答措辞判 pass：「${t.slice(0, 20)}…」`, r.verdict === 'pass' && r.claims === 0,
    `verdict=${r.verdict} claims=${r.claims}`);
}
// 提示词里要求模型改用的**新说法**也必须认（见 chat/prompt.mjs 第 1 条）：
// 「本轮的资料里没有…」「本轮没有取到它的资料」 —— 不认就会把正确的拒答判成无据陈述。
for (const t of [
  '本轮的资料里没有关于红烧肉制作方法的描述。',
  '本轮的资料中没有这条信息。',
  '本轮没有取到它的资料。',
  '本轮没有检索到相关内容。',
  '关于坎蒂丝，本轮没有取到资料。',
]) {
  const r = auditAnswer(t, SOURCES);
  ok(`新拒答措辞判 pass：「${t.slice(0, 18)}…」`, r.verdict === 'pass' && r.claims === 0,
    `verdict=${r.verdict} claims=${r.claims}`);
}
// 容错不能容过头：真的编造仍须抓出来
{
  const r1 = auditAnswer('胡桃最喜欢吃水煮鱼配虾饺，住在璃月港北边。', SOURCES);
  ok('加了容错后，真幻觉仍判 fail', r1.verdict === 'fail', `verdict=${r1.verdict}`);
  const r2 = auditAnswer('胡桃是往生堂堂主[1]。她还有一只叫大丘丘的猫。', SOURCES);
  ok('加了容错后，半真半假仍判 warn', r2.verdict === 'warn', `verdict=${r2.verdict}`);
}

// 闸门的分档：识别到库里的条目、只是没取到正文时**不许硬拒答**
// （实测 10 个角色档案字段全空：派蒙 / 戴因斯雷布 / 多托雷…，观测枢也没有它们的词条）
{
  const g1 = assessRetrieval({
    sources: [], anchors: [{ name: '派蒙' }],
    coverage: { total: 1, fetched: 1, capped: false, withSources: [], withoutSources: ['派蒙'] },
  });
  ok('识别到条目却零资料 → 不硬拒答', g1.refuse === false, `level=${g1.level} refuse=${g1.refuse}`);
  const g2 = assessRetrieval({
    sources: [], anchors: [],
    coverage: { total: 0, fetched: 0, capped: false, withSources: [], withoutSources: [] },
  });
  ok('零实体零资料（真库外）→ 仍硬拒答', g2.refuse === true, `level=${g2.level} refuse=${g2.refuse}`);
  const g3 = assessRetrieval({ sources: [{ type: 'profile', text: 'x' }], anchors: [], coverage: null });
  ok('有资料无锚点 → 依据较弱', g3.level === 'weak' && g3.refuse === false, `level=${g3.level}`);
}

// ================================================================ B. 闸门
console.log('\n  ── B. 检索闸门（端到端） ──');

const child = spawn(process.execPath, [path.join(KB, 'serve-client.mjs')], {
  cwd: KB,
  env: { ...process.env, KB_CLIENT_PORT: String(PORT), KB_CLIENT_HOST: '127.0.0.1', KB_CLIENT_TOKEN: TOKEN, KB_CLIENT_RATE: '5000', KB_CLIENT_AUTH: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/v1/health`); if (r.ok) { up = true; break; } } catch { /* 等 */ }
  await sleep(250);
}
if (!up) { console.error('服务没能启动：\n' + log); child.kill(); process.exit(1); }

async function chat(message) {
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: 'ground-smoke-' + Math.random().toString(36).slice(2) }),
  });
  const raw = await res.text();
  const events = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try { events.push(JSON.parse(t.slice(5).trim())); } catch { /* 忽略 */ }
  }
  return events;
}
const typeOf = (evs, t) => evs.find((e) => e.type === t);

try {
  // 检索为空的退化输入 -> 硬拒答，且模型根本不该被调用
  let evs = await chat('!!!!');
  const g = typeOf(evs, 'grounding');
  const done = typeOf(evs, 'done');
  ok('退化输入触发硬拒答', !!g && g.refused === true && g.level === 'none', `level=${g && g.level} refused=${g && g.refused}`);
  ok('拒答时**没有** provider 事件（模型未被调用）', !typeOf(evs, 'provider'),
    typeOf(evs, 'provider') ? '竟然出现了 provider' : '确认未进入生成');
  ok('拒答文案是写死的、不经模型', !!done && /本轮没有检索到/.test(done.answer || ''), (done && done.answer || '').slice(0, 30));
  // 「没有」的门槛：检索为空**不等于**库里没有 —— 实测有角色档案字段全空（派蒙/戴因斯雷布…），
  // 也有内容在库里却检索不到具名条目（「往生堂是什么」）。所以拒答文案不许下「库里没有」的断言。
  ok('拒答文案不下「知识库里没有」的断言',
    !!done && /不代表知识库里没有/.test(done.answer || '') && !/^知识库里没有/.test(done.answer || ''),
    (done && done.answer || '').slice(0, 46));
  ok('拒答回合不发 audit（没有可审计的生成内容）', !typeOf(evs, 'audit'));

  // 多实体长问题：识别到的每个实体都要取到资料，并如实回报覆盖
  // （旧实现只给前 2 个实体取分区资料，模型于是对其余角色说「知识库里没有」）
  const names13 = ['芙宁娜', '阿蕾奇诺', '钟离', '胡桃', '温迪', '雷电将军', '甘雨', '魈', '琴', '刻晴', '莫娜', '可莉', '达达利亚'];
  evs = await chat(names13.join('、') + '这十三个角色谁的语音最多');
  const m13 = typeOf(evs, 'meta');
  ok('13 实体长问题：全部识别出来', !!m13 && (m13.entities || []).length === 13,
    m13 && JSON.stringify((m13.entities || []).map((e) => e.name)));
  ok('13 实体长问题：每个实体都取到资料', !!m13 && !!m13.coverage && m13.coverage.withoutSources.length === 0,
    m13 && JSON.stringify(m13.coverage));
  ok('13 实体长问题：覆盖回报里带上「没取到资料的」字段（客户端可直接显示）',
    !!m13 && Array.isArray(m13.coverage.withSources) && Array.isArray(m13.coverage.withoutSources),
    m13 && JSON.stringify(m13.coverage && m13.coverage.withSources));

  // 检索有内容的正常问题
  evs = await chat('胡桃的命座是什么');
  const g2 = typeOf(evs, 'grounding');
  ok('正常问题不拒答', !!g2 && g2.refused === false, `level=${g2 && g2.level}`);
  ok('正常问题进入生成（有 provider 事件）', !!typeOf(evs, 'provider'), `provider=${(typeOf(evs, 'provider') || {}).provider}`);
  const au = typeOf(evs, 'audit');
  ok('正常问题带审计结果', !!au && typeof au.verdict === 'string', `verdict=${au && au.verdict} :: ${au && au.note}`);
  ok('审计结论不是 fail', !!au && au.verdict !== 'fail', `verdict=${au && au.verdict}`);
  ok('grounding 里带锚点（客户端可显示来源边界）', !!g2 && Array.isArray(g2.anchors), `锚点 ${g2 && g2.anchors.length} 个`);

  // 库外问题：不该硬拒答（有噪声命中），但必须标成「依据较弱」
  evs = await chat('红烧肉怎么做才好吃');
  const g3 = typeOf(evs, 'grounding');
  ok('库外问题标为「依据较弱」', !!g3 && g3.level === 'weak', `level=${g3 && g3.level} reason=${g3 && g3.reason}`);

  // 具名问题应判 ok
  evs = await chat('天空之翼这把武器适合谁');
  const g4 = typeOf(evs, 'grounding');
  ok('具名问题判 ok', !!g4 && g4.level === 'ok', `level=${g4 && g4.level}`);

} finally {
  child.kill();
  await sleep(400);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
