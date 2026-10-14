// 检索层自测（不需要任何生成模型、不需要启动 server）
//   node chat/selftest.mjs

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRetriever, assembleContext, DEFAULT_BUDGET } from './retrieve.mjs';
import { buildUserMessage, coverageNote, SYSTEM_PROMPT } from './prompt.mjs';
import { assessRetrieval } from '../lib/grounding.mjs';
import { validateObcKindTable, OBC_KIND_LABEL, OBC_ONLY_KINDS, OBC_OVERLAP_KINDS } from '../lib/obc-kinds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.KB_DATA_DIR || path.join(HERE, '..', 'data');
if (!fs.existsSync(path.join(DATA, 'kb.sqlite'))) { console.error('未配置资料库，请设置 KB_DATA_DIR 后运行自测。'); process.exit(2); }
const db = new DatabaseSync(path.join(DATA, 'kb.sqlite'), { readOnly: true });
const R = createRetriever(db);
// 观测枢在侧车库；没有这个文件（没导入观测枢）时后面的分类检查自动跳过
const WS_PATH = path.join(DATA, 'kb-workspace.sqlite');
const ws = fs.existsSync(WS_PATH) ? new DatabaseSync(WS_PATH, { readOnly: true }) : null;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

console.log('[1] 实体识别');
{
  const e = R.detectEntities('胡桃和钟离是什么关系');
  check('中文名双命中', e.map((x) => x.name).sort().join() === '胡桃,钟离', JSON.stringify(e));
}
{
  const e = R.detectEntities('雷电影的语音');
  check('别名 雷电影 -> 雷电将军', e.some((x) => x.name === '雷电将军'), JSON.stringify(e));
}
{
  const e = R.detectEntities('Venti 的语音');
  check('英文名 Venti -> 温迪', e.some((x) => x.name === '温迪'), JSON.stringify(e));
}
{
  const e = R.detectEntities('hutao 的故事');
  check('拼音 hutao -> 胡桃', e.some((x) => x.name === '胡桃'), JSON.stringify(e));
}
{
  const e = R.detectEntities('摩拉克斯是谁');
  check('别名 摩拉克斯 -> 钟离', e.some((x) => x.name === '钟离'), JSON.stringify(e));
}

console.log('[2] 分区识别');
{
  const s = R.detectScopes('胡桃喜欢吃什么', true);
  check('好恶关键词命中 preference', s.includes('preference'), s.join());
}
{
  const s = R.detectScopes('胡桃和钟离是什么关系', true);
  check('关系关键词命中 relation', s.includes('relation'), s.join());
}
{
  const s = R.detectScopes('胡桃的故事', true);
  check('故事关键词命中 story', s.includes('story'), s.join());
}

console.log('[3] 结构化取数');
{
  const r = R.retrieve('胡桃是谁');
  const prof = r.sources.find((x) => x.type === 'profile');
  check('胡桃档案命中', !!prof, JSON.stringify(r.sources.map((x) => x.type)));
  check('档案含往生堂', !!prof && /往生堂/.test(prof.text), prof ? prof.text.slice(0, 80) : '');
}
{
  const r = R.retrieve('胡桃喜欢吃什么');
  const prefs = r.sources.filter((x) => x.type === 'preference');
  check('好恶资料 >= 2 条', prefs.length >= 2, String(prefs.length));
  check('含食物条目', prefs.some((p) => /食物/.test(p.title + p.heading)), JSON.stringify(prefs.map((p) => p.title)));
}
{
  const r = R.retrieve('胡桃和钟离是什么关系');
  const rels = r.sources.filter((x) => x.type === 'relation');
  check('关系资料存在', rels.length > 0, String(rels.length));
  check('关系里出现钟离', rels.some((x) => /钟离/.test(x.title)), JSON.stringify(rels.map((x) => x.title).slice(0, 5)));
}
{
  const r = R.retrieve('胡桃的语音');
  const voices = r.sources.filter((x) => x.type === 'voice');
  check('语音资料 >= 3 条', voices.length >= 3, String(voices.length));
  check('语音有 url', voices.every((v) => /^#\//.test(v.url)));
}
{
  const r = R.retrieve('胡桃的角色故事');
  const st = r.sources.filter((x) => x.type === 'story');
  check('故事资料 >= 1 条', st.length >= 1, String(st.length));
  check('故事有正文', st.every((s) => s.text && s.text.length > 20));
}

console.log('[4] 全文兜底 / 跨角色');
{
  const r = R.retrieve('往生堂');
  check('无角色名也能检索到内容', r.sources.length > 0, String(r.sources.length));
}
{
  const r = R.retrieve('水神是谁');
  check('水神 -> 芙宁娜', r.entities.some((e) => e.name === '芙宁娜'), JSON.stringify(r.entities));
}

console.log('[5] 多轮承接');
{
  const r = R.retrieve('他的语音呢', { inherited: [{ id: 91, name: '胡桃' }] });
  check('承接上文角色', r.entities.some((e) => e.name === '胡桃'), JSON.stringify(r.entities));
    check('承接后取到语音', r.sources.some((s) => s.type === 'voice'), JSON.stringify(r.scopes));
    // 已识别角色时不得退化到 OR 全文召回，否则会混进别的角色的提及
    const stray = r.sources.filter((s) => s.characterId && s.characterId !== 91 && s.type !== 'book');
    check('不引入无关角色的引用', stray.length === 0, JSON.stringify(stray.map((s) => s.title)));
  }

console.log('[6] 上下文组装与预算');
{
  const r = R.retrieve('胡桃是谁');
  const ctx = assembleContext(r.sources, 6500);
  check('上下文非空', ctx.text.length > 50, String(ctx.text.length));
  check('预算内', ctx.chars <= 6500 + 400, String(ctx.chars));
  check('带引用编号', /\[1\]/.test(ctx.text));
  const tiny = assembleContext(r.sources, 300);
  check('小预算不崩', tiny.kept.length >= 1 && tiny.chars > 0, JSON.stringify({ kept: tiny.kept.length, chars: tiny.chars }));
}

console.log('[7] 多实体检索（长问题里点名很多角色）');
{
  const names13 = ['芙宁娜', '阿蕾奇诺', '钟离', '胡桃', '温迪', '雷电将军', '甘雨', '魈', '琴', '刻晴', '莫娜', '可莉', '达达利亚'];
  const q = names13.join('、') + '这十三个角色谁的语音最多';
  const r = R.retrieve(q);
  check('13 个实体全部抽出（旧实现只给前 2 个取资料）',
    r.entities.length === 13, JSON.stringify(r.entities.map((e) => e.name)));
  check('实体顺序 = 问题里的出现顺序',
    r.entities.map((e) => e.name).join() === names13.join(), r.entities.map((e) => e.name).join());
  const ctx = assembleContext(r.sources, DEFAULT_BUDGET);
  const covered = new Set();
  for (const s of ctx.kept) {
    for (const e of r.entities) {
      if (s.characterId === e.id || `${s.title} ${s.text}`.includes(e.name)) covered.add(e.id);
    }
  }
  check('预算内每个实体都取到了资料（轮转分摊）', covered.size === 13, `${covered.size}/13`);
  check('每个实体都有一条档案', r.entities.every((e) => ctx.kept.some((s) => s.type === 'profile' && s.characterId === e.id)),
    `${ctx.kept.filter((s) => s.type === 'profile').length} 条档案`);
  check('覆盖回报里没人掉队', r.coverage.withoutSources.length === 0, JSON.stringify(r.coverage));
}
{
  const a = R.detectEntities('胡桃和琴什么关系').map((e) => e.name);
  check('列举连接词后的单字名（琴）能认出', a.includes('琴'), a.join());
  const b = R.detectEntities('七七和魈谁大').map((e) => e.name);
  check('列举连接词后的单字名（魈）能认出', b.includes('魈'), b.join());
  check('构词里的单字名仍不误认（弹琴）', R.detectEntities('我喜欢弹琴的时候').length === 0,
    JSON.stringify(R.detectEntities('我喜欢弹琴的时候').map((e) => e.name)));
  const c = R.detectEntities('胡桃和钟离是什么关系').map((e) => e.name);
  check('两个实体按出现位置返回', c.join() === '胡桃,钟离', c.join());
  // 「动词 + 单字名」：旧规则前一个字是汉字就一律不认，于是这类正常问法整个角色消失
  for (const q of ['介绍一下琴', '关于琴的语音', '我喜欢魈', '提到琴', '了解一下琴']) {
    const got = R.detectEntities(q).map((e) => e.name);
    check(`动词/介词后的单字名能认出：「${q}」`, got.includes('琴') || got.includes('魈'), got.join() || '(无)');
  }
  // 白名单的安全网：前一个字在白名单里、但后面跟着构词后缀，或名字本身就是乐器名
  for (const q of ['看琴谱', '介绍琴声', '大提琴和小提琴', '弹一下琴', '风物之诗琴怎么获得']) {
    const got = R.detectEntities(q).map((e) => e.name);
    check(`乐器/构词不误认：「${q}」`, !got.includes('琴'), got.join() || '(无)');
  }
}

console.log('[8] 「没有」的门槛（覆盖回报 + 提示词 + 拒答文案）');
{
  const r = R.retrieve('胡桃和钟离是什么关系');
  check('覆盖回报列出识别到的实体与取到资料的实体',
    r.coverage.withSources.length === 2 && r.coverage.total === 2, JSON.stringify(r.coverage));
  check('全部取到资料时不往提示词里塞【检索覆盖】（避免噪声）',
    coverageNote(r.coverage) === '', coverageNote(r.coverage).slice(0, 40));
  // 有「没取到资料的」条目时才输出，并点名它们
  const part = coverageNote({
    total: 3, fetched: 3, capped: false,
    withSources: ['胡桃', '钟离'], withoutSources: ['派蒙'],
  });
  check('有没取到资料的条目时输出【检索覆盖】', /【检索覆盖】/.test(part) && /派蒙/.test(part), part.replace(/\n/g, ' ').slice(0, 60));
  check('系统提示词禁止「知识库里没有 X」的写法',
    /不许\*\*写「知识库里没有/.test(SYSTEM_PROMPT) || /不许.*知识库里没有/.test(SYSTEM_PROMPT),
    SYSTEM_PROMPT.split('\n').slice(2, 6).join(' ').slice(0, 120));
  const gate = assessRetrieval({ sources: [], anchors: [] });
  check('零检索的硬拒答不再断言库里没有',
    gate.refuse === true && !/知识库里没有检索到/.test(gate.answer) && /不代表知识库里没有/.test(gate.answer),
    gate.answer.slice(0, 46));
  // 识别到库里的条目、只是没取到正文（实测 10 个角色档案字段全空，派蒙就是其中之一）：
  // 不许硬拒答 —— 「问题点名了库里的条目」本身就说明这不是库外问题。
  const p = R.retrieve('派蒙是谁');
  const pg = assessRetrieval({
    sources: assembleContext(p.sources, DEFAULT_BUDGET).kept,
    anchors: [{ name: '派蒙' }],
    coverage: p.coverage,
  });
  check('档案为空的角色（派蒙）不触发硬拒答，且覆盖回报如实标出',
    pg.refuse === false && p.coverage.withoutSources.includes('派蒙'),
    `level=${pg.level} coverage=${JSON.stringify(p.coverage)}`);
  check('真的库外问题（零实体零资料）仍硬拒答',
    assessRetrieval({ sources: [], anchors: [], coverage: { total: 0, withSources: [], withoutSources: [] } }).refuse === true);
}
{
  // 实体多到超过逐展开上限时，覆盖回报要**如实**说明「没展开 ≠ 库里没有」
  const all = R.charRows.map((c) => c.name);
  const r = R.retrieve(all.join('、') + '谁的语音最多');
  check('超过展开上限时如实回报',
    r.coverage.capped === true && r.coverage.withoutSources.length > 0,
    JSON.stringify({ total: r.coverage.total, fetched: r.coverage.fetched, without: r.coverage.withoutSources.length }));
  const msg = buildUserMessage('x', 'y', r.coverage);
  check('「没展开不等于库里没有」写进了提示词', /不代表库里没有/.test(msg), msg.slice(-70).replace(/\n/g, ' '));
}

if (ws) {
  console.log('[9] 观测枢分类只有一处（lib/obc-kinds.mjs）');
  const dbKinds = ws.prepare('SELECT DISTINCT kind FROM obc_entries').all().map((r) => r.kind);
  const problems = validateObcKindTable(dbKinds);
  check('分类表自检通过（含库里每个 kind 都有中文标签）', problems.length === 0, problems.join(' | '));
  check('only / overlap 白名单都非空', OBC_ONLY_KINDS.length > 0 && OBC_OVERLAP_KINDS.length > 0,
    `only=${OBC_ONLY_KINDS.length} overlap=${OBC_OVERLAP_KINDS.length}`);
  check('库里没有落成英文 slug 的 kind', dbKinds.every((k) => OBC_KIND_LABEL[k]), dbKinds.filter((k) => !OBC_KIND_LABEL[k]).join());
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
db.close();
if (ws) ws.close();
process.exit(fail ? 1 : 0);
