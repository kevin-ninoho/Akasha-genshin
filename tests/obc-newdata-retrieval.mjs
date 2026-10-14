// 新数据检索回归测试（判据修正版）。
//
// ⚠ 第一版判据是错的：只看了「回答有没有引用」，结果
//   「知识库里没有钟离角色PV的信息」这种**礼貌的失败**也被判成通过。
//   现在判据改成：**期望的那个域，有没有出现在检索候选里**。
//   候选里没有 → 无论回答写得多好，都是失败。
//
// 两个层次分开验：
//   ① /v1/retrieve  → 检索器有没有把对应域的条目捞出来（机制层）
//   ② /v1/chat      → 端到端回答（表现层，只做参考）
//
// 用法：node test/obc-newdata-retrieval.mjs

const V1 = process.env.V1 || 'http://127.0.0.1:5180';
const TOKEN = process.env.KB_CLIENT_TOKEN || process.env.KB_TOKEN || '';
if (!TOKEN) throw new Error('Set KB_CLIENT_TOKEN in the environment before running this probe.');

// expect: 期望出现在候选里的域名（按标题/来源判断，不依赖返回结构里的 kind 字段）
const CASES = [
  // ── 新域（补采才有）──
  { q: '钟离的角色PV叫什么名字',              tag: '新·角色视频', want: /角色PV|额外的记账/ },
  { q: '有哪些关于蒙德历史的考据文章',        tag: '新·考据',     want: /考据|蒙德.*历史|贵族旧事|羽球节/ },
  { q: '七圣召唤里流浪者这张角色牌有什么效果', tag: '新·七圣',     want: /流浪者.*牌|角色牌|行动牌/ },
  { q: '雕花庭院墙尾是什么',                  tag: '新·洞天',     want: /雕花庭院墙尾/ },
  { q: '伏鳌谷古战场观景点在哪',              tag: '新·观景点',   want: /伏鳌谷/ },
  { q: '佑灵砾漠这个成就是什么',              tag: '新·成就',     want: /佑灵砾漠/ },
  // ── 老域（回归）──
  { q: '胡桃的推荐武器',                      tag: '老·配装',     want: /武器|护摩|胡桃/ },
  { q: '木盾丘丘人',                          tag: '老·敌人',     want: /木盾丘丘人/ },
  { q: '往生堂是什么',                        tag: '老·机构',     want: /往生堂|胡桃/ },
  { q: '薇斯纳是谁',                          tag: '老·角色',     want: /薇斯纳/ },
];

async function retrieve(question) {
  const res = await fetch(`${V1}/v1/retrieve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ question, limit: 20 }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return { err: `${res.status} ${(await res.text()).slice(0, 90)}` };
  return await res.json();
}

/** 把候选的标题拼成一个串，用来判断"期望的域在不在" */
function candidateTitles(r) {
  const src = r.sources || [];
  return src.map((s) => `${s.title || ''} ${s.name || ''} ${(s.text || '').slice(0, 400)}`).join('\n');
}

async function chat(question) {
  const res = await fetch(`${V1}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ message: question, sessionId: 'newdata-test2' }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) return { err: `${res.status}` };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', provider = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let j; try { j = JSON.parse(raw); } catch { continue; }
      if (j.type === 'delta') text += j.text || '';
      if (j.type === 'provider') provider = j.provider || '';
    }
  }
  return { text, provider };
}

console.log(`  目标 ${V1}\n`);
let pass = 0;
for (const c of CASES) {
  const r = await retrieve(c.q);
  if (r.err) { console.log(`  ✗ [${c.tag}] ${c.q}\n      检索失败: ${r.err}`); continue; }
  const blob = candidateTitles(r);
  const n = (r.sources || []).length;
  const hit = c.want.test(blob);

  const ans = await chat(c.q);
  const cites = (String(ans.text || '').match(/\[\d+\]/g) || []).length;
  const saidNo = /知识库里没有|没有收录|没有专门/.test(String(ans.text || ''));

  if (hit) pass++;
  console.log(`  ${hit ? '✓' : '✗'} [${c.tag}] ${c.q}`);
  console.log(`      候选 ${n} 条 · 期望域${hit ? '已进候选 ✓' : '**不在候选里** ✗'}`);
  console.log(`      回答 ${String(ans.text || '').length} 字 · 引用 ${cites} 个 · ${saidNo ? '⚠ 答"没有"' : '正面作答'}`);
  if (!hit) {
    const titles = (r.sources || []).slice(0, 5).map((s) => String(s.title || '').slice(0, 40)).join(' | ');
    console.log(`      实际候选: ${titles}`);
  }
}

console.log(`\n  ────────────────────────────────`);
console.log(`  期望域进候选: ${pass} / ${CASES.length}${pass === CASES.length ? '   全部通过 ✓' : '   **仍有缺失**'}`);
