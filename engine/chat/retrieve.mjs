// 原神知识库 · RAG 检索层
//
// 职责：把一句自然语言问题，变成一组「带引用的资料块」（sources）。
//
// 设计原则（顺序即优先级）：
//   1) 结构化优先 —— 能靠 characters / story_chapters / voice_lines / dialogue_lines /
//      preferences / relations 精确取到的，直接取，不走全文检索（精确、可引用、可跳转）；
//   2) 全文兜底 —— 剩下的用既有 CJK 二元组 FTS5（search_fts）补齐书籍与跨角色命中；
//   3) 预算裁剪 —— 小上下文模型放不下太多字，按字符预算裁，保证重要的排在前面。
//
// 这一层不依赖任何模型，可独立测试：`node chat/selftest.mjs`。

import { ENTITY_ALIASES as ALIASES } from '../lib/nicknames.mjs';
import { shortNameAtOk } from '../lib/names.mjs';
import { queryExpr, queryExprLoose, stripStopwords } from '../lib/tokenize.mjs';
import { searchObc, obcSourceOf, searchObcByName } from '../lib/obc-search.mjs';
// 观测枢分类知识（哪些域主库没有、什么问法放开哪个域）只此一处，见 lib/obc-kinds.mjs。
import { OBC_ONLY_KINDS, OBC_GEAR_ASK_RE, pickObcKinds } from '../lib/obc-kinds.mjs';

export const MAX_SOURCES = 26;
export const DEFAULT_BUDGET = 6500;
export const LORE_RE = /为什么|为何|原因|设定|剧情|世界观|真相|预言|神座|权能|历史|神之心|五百年|天理/;

export function decomposeQuestion(question) {
  const clauses = String(question).split(/[,，、；;。？！]|而(?:要|是)?|还要|以及|并且|同时/).map(s => s.trim()).filter(s => s.length >= 3);
  return [...new Set(clauses)].slice(0, 6);
}

function loreTerms(question, entities) {
  const concepts = question.match(/神之心|神座|神格|权能|权柄|预言|原罪|天理|龙王|五百年|百年|律偿混能|谕示裁定枢机|诅咒|赦免|审判|毁掉|摧毁|扮演|灵魂|肉体|命运|战争|复活|牺牲|时间|世界树|深渊/g) || [];
  // Query expansion retrieves the adjacent concepts needed for causal answers.
  if (concepts.includes('神座')) concepts.push('权能', '权柄', '古龙大权');
  if (concepts.includes('扮演')) concepts.push('预言', '天理', '赦免');
  const clauses = decomposeQuestion(question).map(s => {
    for (const e of entities) s = s.replaceAll(e.name, '').replaceAll(e.matched === '(承接上文)' ? e.name : e.matched || e.name, '');
    return stripStopwords(s).replace(/为什么|为何|不直接|交给|安排|是什么|如何|怎么|还要|而要|扮演/g, '').trim();
  }).filter(s => s.length >= 2 && s.length <= 8);
  return [...new Set([...concepts, ...clauses])].slice(0, 16);
}

// 意图关键词 -> 资料分区。命中多个则同时取多个分区。
const SCOPE_HINTS = [
  ['relation', ['关系', '怎么看', '评价', '看法', '和谁', '朋友', '敌人', '认识', '相处',
    '搭档', '同事', '家族', '师徒', '队友', '搭档', '对手', '仇恨']],
  ['preference', ['喜欢', '讨厌', '爱好', '习惯', '口味', '烦恼', '讨厌吃', '喜欢吃什么',
    '兴趣', '食物', '爱好是']],
  ['story', ['故事', '身世', '来历', '背景', '过去', '经历', '设定', '传说', '真相',
    '为什么', '原因', '成长']],
  ['voice', ['语音', '台词', '怎么说', '说过', '口头禅', '配音', 'cv', '声音', '闲聊',
    '问候', '道别', '怎么说']],
  ['dialogue', ['剧情', '任务', '对话', '这一幕', '那段', '魔神任务', '传说任务', '邀约',
    '活动剧情', '章节', '台词里']],
  ['profile', ['是谁', '是谁', '介绍', '档案', '元素', '武器', '生日', '稀有度', '星级',
    '几星', '神之眼', '命之座', '势力', '地区', '称号', '身份', '定位', '角色卡']],
];

// 每个分区默认展开上限
const SCOPE_LIMITS = {
  story: 3,
  voice: 6,
  dialogue: 6,
  preference: 6,
  relation: 8,
  book: 4,
};

const rel = (n) => Math.round(Number(n) * 100) / 100;

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function norm(s) {
  return String(s || '').toLowerCase();
}

// 关键词打分：标题命中权重高，正文命中权重低
function scoreOf(keywords, title, body) {
  if (!keywords.length) return 0;
  const t = norm(title);
  const b = norm(body);
  let s = 0;
  for (const kw of keywords) {
    const k = norm(kw);
    if (!k) continue;
    if (t.includes(k)) s += 3;
    let from = 0;
    for (;;) {
      const at = b.indexOf(k, from);
      if (at < 0) break;
      s += 1;
      from = at + k.length;
      if (s > 60) break;
    }
  }
  return s;
}

function pickByKeyword(rows, keywords, limit, titleOf, bodyOf) {
  const scored = rows.map((row, i) => ({
    row, i, score: scoreOf(keywords, titleOf(row), bodyOf(row)),
  }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const hit = scored.filter((x) => x.score > 0);
  const chosen = (hit.length ? hit : scored).slice(0, limit);
  chosen.sort((a, b) => a.i - b.i);
  return chosen.map((x) => x.row);
}

export function createRetriever(db, obcDb = null) {
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  // ---------------------------------------------------------- 实体索引
  // 角色名的所有写法（中文名 / 英文名 / 拼音 / 别名）-> 角色记录
  const byKey = new Map();
  const nameToId = new Map();

  const charRows = all(
    'SELECT id, name, en_name, pinyin, pinyin_spaced, title, region, element FROM characters'
  );
  for (const c of charRows) nameToId.set(c.name, c.id);

  // 单字角色名的集合（琴、魈…）。主库里有 2 个。
  const SHORT_NAMES = new Set(charRows.filter((c) => c.name && c.name.length === 1).map((c) => c.name));

  const addKey = (key, char) => {
    const k = norm(key).trim();
    if (!k) return;
    // 单字名（琴、魈）在中文里到处都是 —— 「风琴」「弹琴」「琴声」。
    // 以前一律拒收长度 <2 的键，结果是**琴这个角色永远识别不出来**：
    // 问「琴是谁」走了纯 FTS，撞出一堆随机 NPC，一条琴的资料都没有。
    // 现在收进来，但只收**真名本身**（拼音/英文名不参与单字匹配），
    // 并且匹配时要求出现在句首或前面不是汉字（见 detectEntities）。
    if (k.length < 2 && !SHORT_NAMES.has(k) && !ALIASES[k]) return;
    if (!byKey.has(k)) byKey.set(k, char);
  };
  for (const c of charRows) {
    addKey(c.name, c);
    addKey(c.en_name, c);
    addKey(c.pinyin, c);
    addKey(c.pinyin_spaced, c);
  }
  // Add names from official dialogue, NPC entries, and named book headings.
  const external = new Map();
  const addExternal = (name, kind, id) => {
    const n = String(name || '').trim();
    if (n.length < 2 || n.length > 16 || /[：:，。！？…\d]/.test(n) || nameToId.has(n) || external.has(n)) return;
    external.set(n, { id: `${kind}:${id}`, name: n, kind });
  };
  for (const r of all('SELECT DISTINCT speaker FROM dialogue_lines')) addExternal(r.speaker, 'speaker', r.speaker);
  if (obcDb) try { for (const r of obcDb.prepare("SELECT id,name FROM obc_entries WHERE kind IN ('npc','character')").all()) addExternal(r.name, 'obc', r.id); } catch { /* optional corpus */ }
  try { for (const r of all('SELECT id,heading FROM book_sections')) { const m = String(r.heading || '').match(/^([\u4e00-\u9fff]{2,8})(?:小传|生平|传记)$/); if (m) addExternal(m[1], 'book-person', r.id); } } catch { /* older schema */ }
  for (const e of external.values()) addKey(e.name, e);
  for (const [alias, canon] of Object.entries(ALIASES)) {
    const id = nameToId.get(canon);
    if (!id) continue;
    const c = charRows.find((x) => x.id === id);
    if (c) { byKey.delete(norm(alias)); addKey(alias, c); }
  }
  // 长名优先，保证最长匹配（「雷电将军」先于「雷电」）
  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  /**
   * 单字名的边界判断（琴、魈）。
   *
   * 规则本身在 lib/names.mjs 里 —— 锚点识别（lib/v1-data.mjs）用的是同一份，
   * 两边不一致会出现「检索认出了这个角色、闸门却不认」的割裂。
   * 这里只是把「在 at 处算不算真名」接过来。
   */
  const shortNameOk = (hay, at, len) => shortNameAtOk(hay, at, len);

  function detectEntities(text) {
    const lc = norm(text);
    if (!lc) return [];
    const masked = lc.split('');
    const found = [];
    const seen = new Set();
    for (const key of keys) {
      const hay = masked.join('');
      let at = hay.indexOf(key);
      if (key.length === 1) {
        while (at >= 0 && !shortNameOk(hay, at, 1)) at = hay.indexOf(key, at + 1);
      }
      if (at < 0) continue;
      const c = byKey.get(key);
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      found.push({ id: c.id, name: c.name, kind: c.kind || 'character', matched: key, at });
      for (let i = at; i < at + key.length; i++) masked[i] = '\u0001';
    }
    // 按**在问题里出现的先后**返回，不按名字长度。
    // keys 是按长度降序的，所以旧实现返回的顺序 = 名字长的在前：
    // 「胡桃和钟离」给的是 [钟离, 胡桃]。而下游到处用「第一个实体」（分区分摊、
    // 回答块的目标角色、检索覆盖回报），顺序错了整套都偏。
    found.sort((a, b) => a.at - b.at || a.id - b.id);
    return found.map((e) => ({ id: e.id, name: e.name, kind: e.kind, matched: e.matched }));
  }

  // ---------------------------------------------------------- 分区识别
  function detectScopes(text, hasEntity) {
    const lc = norm(text);
    const scopes = [];
    for (const [scope, words] of SCOPE_HINTS) {
      if (words.some((w) => lc.includes(norm(w)))) scopes.push(scope);
    }
    if (LORE_RE.test(text)) scopes.push('story', 'dialogue');
    if (!scopes.length) {
      // 没提分区：有角色就默认给档案 + 故事 + 好恶；没角色就走全文检索
      return hasEntity ? ['profile', 'story', 'preference'] : ['all'];
    }
    if (hasEntity) scopes.unshift('profile');
    return [...new Set(scopes)];
  }

  // ---------------------------------------------------------- 分区取数
  // 每个取数函数都带一个「正文上限」参数：问题里只有一个角色时用默认值（给足），
  // 十来个角色时按人头压小，否则预算会被第一个角色吃光（见 retrieve 里的分摊）。
  function profileSource(c, bodyCap = 320) {
    const row = one('SELECT * FROM characters WHERE id=?', c.id);
    if (!row) return null;
    const bits = [
      row.title && `称号：${row.title}`,
      row.identity && `身份：${row.identity}`,
      row.faction && `势力：${row.faction}`,
      row.region && `地区：${row.region}`,
      row.element && `元素：${row.element}`,
      row.weapon && `武器：${row.weapon}`,
      row.rarity && `稀有度：${row.rarity} 星`,
      row.birthday && `生日：${row.birthday}`,
      row.constellation && `命之座：${row.constellation}`,
      row.cv_cn && `中文 CV：${row.cv_cn}`,
      row.release_date && `实装日期：${row.release_date}`,
    ].filter(Boolean);
    const body = [row.persona, row.bio].filter(Boolean).map((x) => clip(x, Math.max(80, Math.round(bodyCap / 2)))).join('\n');
    const forms = all('SELECT label, element, weapon, rarity FROM character_forms WHERE character_id=? ORDER BY id', c.id);
    const formText = forms.length > 1
      ? '\n形态：' + forms.map((f) => `${f.label}（${[f.element, f.weapon].filter(Boolean).join('/')}）`).join('、')
      : '';
    return {
      type: 'profile',
      title: `${row.name} · 基础档案`,
      characterId: row.id,
      characterName: row.name,
      heading: '基础档案',
      text: bits.join('；') + (body ? '\n' + body : '') + formText,
      url: `#/character/${row.id}`,
    };
  }

  function storySources(c, keywords, limit, textCap = 1400) {
    const rows = all(
      'SELECT id, ord, title, body FROM story_chapters WHERE character_id=? ORDER BY ord', c.id
    );
    if (!rows.length) return [];
    const picked = pickByKeyword(rows, keywords, limit, (r) => r.title, (r) => r.body);
    return picked.map((r) => ({
      type: 'story',
      title: `${c.name} · ${r.title}`,
      characterId: c.id,
      characterName: c.name,
      heading: r.title,
      text: clip(r.body, textCap),
      url: `#/character/${c.id}?tab=story`,
    }));
  }

  function voiceSources(c, keywords, limit, textCap = 420) {
    const rows = all(
      'SELECT id, grp, name, text FROM voice_lines WHERE character_id=? ORDER BY ord', c.id
    );
    if (!rows.length) return [];
    const picked = pickByKeyword(rows, keywords, limit, (r) => r.name, (r) => r.text);
    return picked.map((r) => ({
      type: 'voice',
      title: `${c.name} · 语音「${r.name}」`,
      characterId: c.id,
      characterName: c.name,
      heading: r.name,
      text: clip(r.text, textCap),
      url: `#/character/${c.id}?tab=voice`,
    }));
  }

  function dialogueSources(c, keywords, limit, textCap = 320) {
    const words = keywords.filter(Boolean);
    let rows = [];
    if (words.length) {
      const like = words.map(() => 'l.text LIKE ?').join(' OR ');
      rows = all(
        `SELECT l.id, l.heading, l.speaker, l.text, g.chapter, g.quest_title, g.quest_type
         FROM dialogue_lines l JOIN dialogue_groups g ON g.id = l.group_id
         WHERE g.character_id = ? AND (${like})
         LIMIT 400`,
        c.id, ...words.map((w) => `%${w}%`)
      );
    }
    if (!rows.length) {
      rows = all(
        `SELECT l.id, l.heading, l.speaker, l.text, g.chapter, g.quest_title, g.quest_type
         FROM dialogue_lines l JOIN dialogue_groups g ON g.id = l.group_id
         WHERE g.character_id = ? AND length(l.text) > 12
         ORDER BY l.id LIMIT 200`,
        c.id
      );
    }
    const picked = pickByKeyword(
      rows, keywords, limit,
      (r) => `${r.quest_title || ''} ${r.heading || ''}`,
      (r) => r.text
    );
    return picked.map((r) => ({
      type: 'dialogue',
      title: `${c.name} · ${[r.quest_type, r.quest_title].filter(Boolean).join(' · ') || '剧情台词'}`,
      characterId: c.id,
      characterName: c.name,
      heading: r.heading,
      text: clip(r.text, textCap),
      url: `#/character/${c.id}?tab=dialogue`,
    }));
  }

  function preferenceSources(c, keywords, limit, textCap = 300) {
    const rows = all(
      'SELECT id, kind, label, text FROM preferences WHERE character_id=? ORDER BY ord', c.id
    );
    if (!rows.length) return [];
    const picked = pickByKeyword(rows, keywords, limit, (r) => `${r.kind} ${r.label}`, (r) => r.text);
    return picked.map((r) => ({
      type: 'preference',
      title: `${c.name} · ${r.kind}`,
      characterId: c.id,
      characterName: c.name,
      heading: r.label,
      text: clip(r.text, textCap),
      url: `#/character/${c.id}?tab=preference`,
    }));
  }

  function relationSources(c, limit, textCap = 420) {
    const rows = all(
      `SELECT r.target_id, r.target_name, r.quote, t.name AS resolved_name
       FROM relations r LEFT JOIN characters t ON t.id = r.target_id
       WHERE r.src_id = ?
       ORDER BY r.id LIMIT 40`,
      c.id
    );
    const scored = rows.filter((r) => r.quote);
    return scored.slice(0, limit).map((r) => ({
      type: 'relation',
      title: `${c.name} → ${r.resolved_name || r.target_name}`,
      characterId: c.id,
      characterName: c.name,
      heading: `关于${r.resolved_name || r.target_name}`,
      targetId: r.target_id || null,
      text: clip(r.quote, textCap),
      url: r.target_id ? `#/character/${r.target_id}` : `#/character/${c.id}?tab=relation`,
    }));
  }

  // ---------------------------------------------------------- 全文兜底
  function ftsRows(expr, limit) {
    try {
      return all(
        `SELECT d.id, d.doc_type, d.owner_id, d.owner_name, d.heading, d.text, d.extra_json,
                bm25(search_fts) AS score
         FROM search_fts f JOIN search_docs d ON d.id = f.rowid
         WHERE f.tokens MATCH ?
         ORDER BY score LIMIT ?`,
        expr, limit
      );
    } catch {
      return [];
    }
  }

  /**
   * 严格短语 -> 去虚词短语 -> 二元组 OR 的放宽阶梯。
   * 长中文问句整句 AND 必然 0 命中，靠这里回退到可用召回。
   *
   * opts.allowLoose=false 时不允许退化到 OR：已经识别出角色的问题，
   * 结构化分区（档案/语音/故事/关系）就是主答案，OR 召回只会塞进无关引用。
   */
  function ftsSources(query, limit, opts = {}) {
    const allowLoose = opts.allowLoose !== false;
    // 已经识别出角色时，全文兜底只允许两类段落：属于这些角色的，或者正文确实提到这些角色的。
    // 否则「他的语音呢」里的单字会退化成超宽匹配，把别的角色的剧情台词塞进引用区。
    const ownerIds = opts.ownerIds && opts.ownerIds.length ? new Set(opts.ownerIds) : null;
    const names = (opts.names || []).filter((n) => n && String(n).length >= 2).map(norm);
    const cands = [];
    const add = (e) => { if (e && !cands.includes(e)) cands.push(e); };
    add(queryExpr(query));
    const stripped = stripStopwords(query);
    const hasStrip = stripped && stripped !== String(query).trim();
    if (hasStrip) {
      add(queryExpr(stripped));
    }
    if (allowLoose) {
      if (hasStrip) add(queryExprLoose(stripped));
      add(queryExprLoose(query));
    }

    const goal = Math.min(limit, 3);
    let rows = [];
    // 阶梯由精确到宽松。某一档达到 goal 就**采用并停止**，不能因为后面更宽的一档条数
    // 更多就把它换掉 —— 那等于拿「召回多」冒充「召回准」。「神之眼是什么」曾因此
    // 从 200 条精确命中被替换成近 4000 条噪音。各档都不达标时，才退而取最全的一档。
    for (const expr of cands) {
      const got = ftsRows(expr, limit);
      if (got.length >= goal) { rows = got; break; }
      if (got.length > rows.length) rows = got;
    }
    if (!rows.length) return [];
    const out = [];
    const seenOwner = new Set();
    for (const r of rows) {
      if (ownerIds && r.doc_type !== 'book') {
        const owned = ownerIds.has(r.owner_id);
        const mentions = names.some(
          (n) => norm(r.text).includes(n) || norm(r.heading).includes(n)
        );
        if (!owned && !mentions) continue;
      }
      if (r.doc_type === 'book') {
        const bk = one('SELECT id, title FROM books WHERE id=?', r.owner_id);
        if (!bk) continue;
        out.push({
          type: 'book',
          title: `《${bk.title}》${r.heading ? ' · ' + r.heading : ''}`,
          bookId: bk.id,
          heading: r.heading,
          text: clip(r.text, 500),
          url: `#/book/${bk.id}`,
        });
        continue;
      }
      if (r.doc_type === 'character') {
        if (seenOwner.has(r.owner_id)) continue;
        seenOwner.add(r.owner_id);
        const ch = one('SELECT id, name FROM characters WHERE id=?', r.owner_id);
        if (!ch) continue;
        out.push({
          type: 'fts',
          title: `${ch.name} · 相关提及`,
          characterId: ch.id,
          characterName: ch.name,
          heading: r.heading,
          text: clip(r.text, 400),
          url: `#/character/${ch.id}`,
        });
        continue;
      }
      out.push({
        type: r.doc_type,
        title: `${r.owner_name} · ${r.heading || '相关段落'}`,
        characterId: r.owner_id,
        characterName: r.owner_name,
        heading: r.heading,
        text: clip(r.text, 400),
        url: `#/character/${r.owner_id}`,
      });
    }
    return out.map(s => ({ ...s, retrieval: 'fts' }));
  }

  function loreDialogueSources(question, entities, terms) {
    if (!terms.length) return [];
    const ids = entities.filter(e => typeof e.id === 'number').map(e => e.id);
    const names = [...new Set(entities.flatMap(e => [e.name, e.matched]).filter(n => n && n.length >= 2 && n !== '(承接上文)'))];
    const focus = [...ids.map(() => 'g.character_id=?'), ...names.map(() => 'l.speaker=?'), ...names.map(() => 'l.text LIKE ?')];
    const match = terms.map(() => 'l.text LIKE ?');
    const rows = all(`SELECT l.id,l.group_id,l.ord,l.speaker,l.text,g.quest_title,g.chapter FROM dialogue_lines l JOIN dialogue_groups g ON g.id=l.group_id WHERE (${match.join(' OR ')})${focus.length ? ` AND (${focus.join(' OR ')})` : ''} LIMIT 1600`, ...terms.map(t => `%${t}%`), ...ids, ...names, ...names.map(n => `%${n}%`));
    const unique = new Map();
    for (const r of rows) if (!unique.has(r.text)) unique.set(r.text, r);
    const ranked = [...unique.values()].map(r => ({ ...r, rank: terms.reduce((n,t) => n + (r.text.includes(t) ? Math.min(6,t.length) : 0), 0) + (names.includes(r.speaker) ? 2 : 0) })).sort((a,b) => b.rank-a.rank || a.id-b.id);
    // Select across concepts instead of spending all slots on one subject.
    const selected = [], seen = new Set();
    for (const t of terms) { const r = ranked.find(r => r.text.includes(t) && !seen.has(r.id)); if (r) { selected.push(r); seen.add(r.id); } }
    for (const r of ranked) if (!seen.has(r.id) && selected.length < 10) { selected.push(r); seen.add(r.id); }
    return selected.slice(0,10).map(r => {
      const context = all('SELECT speaker,text FROM dialogue_lines WHERE group_id=? AND ord BETWEEN ? AND ? ORDER BY ord', r.group_id, r.ord-1, r.ord+1);
      return { type:'dialogue', id:r.id, sourceId:`dialogue:${r.id}`, title:`${r.quest_title || r.chapter || '任务剧情'} · ${r.speaker}`, text:clip(context.map(x => `${x.speaker}：${x.text}`).join('\n'),620), authority:'official' };
    });
  }

  /**
   * 观测枢官方图鉴（侧车库 obc_* 表）。同样是主库 FTS 碰不到的一块。
   *
   * **武器 / 圣遗物 / 材料 / 食物 / 敌人这几类主库里压根没有**，
   * 所以问到就该给，不然 AI 只能回答「知识库里没有」。
   */
  function obcSources(question, limit, opts = {}) {
    if (!obcDb) return [];
    let hits = [];
    try { hits = searchObc(obcDb, question, limit, opts); } catch { hits = []; }
    return hits.map((h) => obcSourceOf(h));
  }

  // ---------------------------------------------------------- 多实体分摊
  //
  // 一个长问题里可能点十来个角色的名（「芙宁娜、阿蕾奇诺、钟离…谁的语音最多」）。
  // 旧实现只给 entities.slice(0, 2) 取分区资料，其余 11 个只剩 FTS 兜底 ——
  // 于是模型对没取到资料的角色张口就是「知识库里没有」，而芙宁娜 / 阿蕾奇诺
  // 明明在主库 131 个角色和观测枢 136 条角色词条里都有（实测）。
  //
  // 现在**识别到的实体全部取**，但要按人头分摊，否则预算（DEFAULT_BUDGET 6500 字）
  // 会被第一个角色吃光：
  //   ① 每个实体至少一条基础档案 —— 身份信息，最便宜，也最不能缺；
  //   ② 实体多于 2 个时，各分区的条数与正文按人头压（每条正文不超过 share）；
  //   ③ 合并时**轮转**：先人人一条档案，再人人一条故事…… 这样 assembleContext
  //      按顺序吃预算时人人有份，而不是前面的吃饱、后面的饿死。
  const DEEP_ENTITIES = 2;        // 不超过这个数：按原规则取全量分区（用户就是在问这几个人）
  const MAX_ENTITY_FETCH = 26;    // 超过这个数（问「有哪些角色」）就不再逐个展开，交给 FTS / 列表块
  const SHARE_HEADROOM = 40;      // 每条 source 的标题行开销（`[n] (type) title`）

  // ---------------------------------------------------------- 主入口
  /**
   * @param {string} question 用户问题（已合并上下文的检索用文本）
   * @param {{keywords?: string[], inherited?: {id:number,name:string}[],
   *          budget?: number}} opts budget：字符预算，用于多实体分摊（默认 DEFAULT_BUDGET）
   */
  function retrieve(question, opts = {}) {
    if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(question)) return { entities:[], scopes:['all'], keywords:[], sources:[], coverage:{total:0,fetched:0,capped:false,withSources:[],withoutSources:[]} };
    const entities = detectEntities(question);
    // 多轮：本轮没提角色，但上一轮提过 -> 继承实体
    if (!entities.length && opts.inherited && opts.inherited.length) {
      for (const e of opts.inherited) {
        const c = charRows.find((x) => x.id === e.id) || [...external.values()].find(x => x.id === e.id);
        if (c) entities.push({ id: c.id, name: c.name, matched: '(承接上文)' });
      }
    }
    const scopes = detectScopes(question, entities.length > 0);
    // 「考据型」问题：额外补一层官方剧情对白（loreDialogueSources）。
    const lore = LORE_RE.test(question);
    const concepts = lore ? loreTerms(question, entities) : [];

    // 检索关键词：原问题去掉标点后切词，供分区内打分
    const SPLIT_RE = /[\s，。？！、；：,.?!;:「」“”"'（）()《》\-—…]+/;
    let keywords = (opts.keywords && opts.keywords.length
      ? opts.keywords
      : question.split(SPLIT_RE).filter((w) => w.length >= 2)
    ).slice(0, 12);
    // 长问句整句成词时打分无效，补上剥虚词后的短词
    const strippedQ = stripStopwords(question);
    if (!opts.keywords && strippedQ && strippedQ !== String(question).trim()) {
      const extra = strippedQ.split(SPLIT_RE).filter((w) => w.length >= 2);
      keywords = [...new Set([...extra, ...keywords])].slice(0, 12);
    }

    // 多实体分摊参数（见上面「多实体分摊」）
    const fetched = entities.slice(0, MAX_ENTITY_FETCH);
    const many = fetched.length > DEEP_ENTITIES;
    const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? Number(opts.budget) : DEFAULT_BUDGET;
    // 人头份额：留 15% 给非实体资料（书籍 / 考据 / 观测枢），再扣掉标题行开销。
    // 不这么掐的话，13 个实体各写满 500 字就会把最后一个挤出预算 —— 又回到「有的角色一条都没有」。
    const share = many ? Math.max(160, Math.floor((budget * 0.85) / fetched.length) - SHARE_HEADROOM) : 0;
    const cap = (base) => (share ? Math.min(base, share) : base);
    const lim = (base) => (many ? Math.max(1, Math.round((base * DEEP_ENTITIES) / fetched.length)) : base);

    const sources = [];
    const push = (arr) => {
      for (const s of arr) {
        if (!s) continue;
        // 正文为空的资料不带信息，只占一个引用号 —— 直接丢。
        // 实测有 10 个角色的档案字段是全空的（卡皮塔诺 / 多托雷 / 派蒙 / 戴因斯雷布…），
        // 它们的 profile text 就是空串；这种实体在检索覆盖里会被如实报成
        // 「本轮没取到资料」，而不是拿一条空档案假装取到了。
        if (!String(s.text || '').trim()) continue;
        // 正文封顶：不经过下面取数函数的那几路（观测枢 / 书籍 / 考据）也照此裁
        if (share && s.text.length > share) s.text = clip(s.text, share);
        sources.push(s);
      }
    };

    if (lore) {
      push(loreDialogueSources(question, entities, concepts));
    }

    // ① 观测枢「名称直配」**排在最前**。
    //
    // 为什么必须最前：assembleContext 是按顺序吃预算的（DEFAULT_BUDGET 6500 字），
    // 观测枢整个排到了函数最后，等于「永远轮不到」。实测问「木盾丘丘人」，
    // 观测枢那条敌人词条确实被检索到了（它排在第 21 位），但前面先塞进了
    // 6 本《丘丘人诗歌选》《丘丘人习俗考察》加派蒙台词、温迪语音，
    // 预算一截，正好把它截掉 —— 模型于是就回「知识库里没有木盾丘丘人」。
    //
    // 名称直配是**精确匹配**（整名出现在问句里才命中），精度极高，
    // 用户问题里点了名，那就是他最想要的那条，理应第一个给。
    // 而且这条通路覆盖主库完全没有的东西：敌人 / 武器 / 圣遗物 / 任务 / NPC。
    if (obcDb) {
      try {
        const direct = searchObcByName(obcDb, question, many ? Math.min(fetched.length, 6) : 4, []);
        for (const h of direct) {
          const s = obcSourceOf(h);
          // 已经识别成主库角色的，交给下面的分区逻辑，避免同一份内容出现两遍
          if (entities.some((e) => e.name === h.name)) continue;
          push([s]);
        }
      } catch { /* 观测枢检索失败不影响主库那条通路 */ }
    }

    // ② 每个实体取一组资料，再**轮转**合并（顺序 = 引用的优先级）
    // 一「张卡」= 一个实体的全部资料，卡内顺序：档案 -> 故事 -> 语音 -> 台词 -> 好恶 -> 关系。
    const cards = fetched.map((c) => ({ c, list: [] }));
    fetched.forEach((c, i) => {
      if (typeof c.id !== 'number') return;
      const list = cards[i].list;
      // 档案永远给（scopes 里有实体时一定含 profile）：它是「这个角色是谁」的身份信息，
      // 也是检索覆盖里「这个实体取到资料了没有」的判据，一百来字，不亏。
      if (scopes.includes('profile')) list.push(profileSource(c, cap(640)));
      if (scopes.includes('story')) for (const s of storySources(c, keywords, lim(SCOPE_LIMITS.story), cap(lore ? 600 : 1400))) list.push(s);
      if (scopes.includes('voice')) for (const s of voiceSources(c, keywords, lim(SCOPE_LIMITS.voice), cap(420))) list.push(s);
      if (scopes.includes('dialogue')) for (const s of dialogueSources(c, keywords, lim(SCOPE_LIMITS.dialogue), cap(320))) list.push(s);
      if (scopes.includes('preference')) for (const s of preferenceSources(c, keywords, lim(SCOPE_LIMITS.preference), cap(300))) list.push(s);
      if (scopes.includes('relation') && !scopes.includes('story')) {
        for (const s of relationSources(c, lim(SCOPE_LIMITS.relation), cap(420))) list.push(s);
      }
    });
    // 轮转：第 0 轮 = 人人一条档案，第 1 轮 = 人人一条故事…… 保证了「人人有份」
    for (let round = 0; sources.length < MAX_SOURCES; round++) {
      let any = false;
      for (const card of cards) {
        const s = card.list[round];
        if (!s) continue;
        any = true;
        push([s]);
      }
      if (!any) break;
    }

    // 全文兜底：跨角色提及、书籍、以及结构化没覆盖到的部分
    if (scopes.includes('all') || scopes.includes('book') || question.length > 4) {
      push(ftsSources(question, scopes.includes('all') ? 12 : 6, {
        allowLoose: entities.length === 0,
        ownerIds: entities.map((e) => e.id),
        names: entities.map((e) => e.name),
      }));
    }

    // ③ 观测枢官方图鉴（侧车库 obc_* 表）。
    // 主库里**完全没有**武器 / 圣遗物 / 材料 / 食物 / 敌人，所以问到这些必须补，
    // 否则 AI 只会回一句「知识库里没有」。
    // 角色 / 书籍与主库重叠，只在「宽问题」时少补几条，避免稀释。
    if (obcDb) {
      // 先放「锁定角色的官方词条」：天赋倍率 / 命座 / 突破材料是主库角色档案里没有的，
      // 排后面会被装备类结果挤掉（问「胡桃的命座」时一堆推荐过胡桃的武器会顶上来）。
      // 只取名称真能对上的那条，防止串角色。
      // 多实体时给前两个（按提问顺序）—— 一个就够证明「观测枢这边也有这个人」，
      // 再多就是同质内容，把人头份额吃掉了。
      for (const c of fetched.slice(0, many ? 2 : 1)) {
        for (const s of obcSources(c.name, 2, { kinds: ['character'] })) {
          if (String(s.title).startsWith(c.name)) { push([s]); break; }
        }
      }
      // 观测枢这一路的**闸门**。
      //
      // ⚠ 原来的逻辑是个二选一：
      //     gearAsk（武器/圣遗物/材料…）→ 搜，但限 OBC_ONLY_KINDS
      //     否则只有「没识别出实体」或「scopes 含 all」才搜（且不限 kind）
      //   后果：**带角色名的非配装问题，观测枢一条都不搜**。
      //   2026-10-13 补采之后这个问题被放大 —— 问「钟离的角色PV叫什么」，
      //   char-video 在库里有 252 条、obc_fts 也搜得到，却因为闸门没开，
      //   模型只能回答「知识库里没有钟离角色PV的名称信息」。
      //
      //   现在多一档：问题命中某个域的典型词（PV / 考据 / 成就 / 七圣召唤…）
      //   就放开那个域的 kind。词表见 lib/obc-kinds.mjs（唯一事实来源）。
      const gearAsk = OBC_GEAR_ASK_RE.test(question);
      const domainKinds = pickObcKinds(question);
      const domainHit = domainKinds.length > OBC_ONLY_KINDS.length;   // 触发词确实多放开了域
      let obcHits;
      if (gearAsk) {
        obcHits = obcSources(question, 6, { kinds: OBC_ONLY_KINDS });
      } else if (domainHit) {
        obcHits = obcSources(question, 6, { kinds: domainKinds });
      } else if (entities.length === 0 || scopes.includes('all')) {
        obcHits = obcSources(question, 4);
      } else {
        obcHits = [];
      }

      // ── escalation：聚焦检索一条都没取到 → **放开全部 51 个分类**再搜一次 ──
      //
      // 为什么必须有这一层：分类白名单是跟预算挂钩的（gated 分类默认不搜），
      // 所以「问句没命中任何触发词、但库里确实有」的情况一定会发生 ——
      // 此时聚焦检索是 0 条，模型只能回答「知识库里没有」，而库里明明有。
      // 实测就是靠这一层兜住的：那些 gated 分类一旦没被触发词放开，
      // 条目在库里也等于不存在。
      //
      // 只在**聚焦失败**时才放开全库，所以：
      //   · 正常问题走的还是聚焦白名单，候选池不膨胀、6500 字预算不被稀释
      //   · 用户不会因为"不知道要说什么触发词"而搜不到
      if (obcHits.length === 0) {
        obcHits = obcSources(question, 4, { kinds: [] });
      }
      push(obcHits);
    }

    // 去重（同一 type + title + 文本前缀）
    const seen = new Set();
    const deduped = [];
    for (const s of sources) {
      const k = `${s.type}|${s.title}|${String(s.text).slice(0, 40)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(s);
    }
    // 多实体时放宽总条数：否则 13 个实体 × 2 条正好把 MAX_SOURCES 占满，
    // 全文兜底与观测枢一条都进不来。反正 assembleContext 还会按预算再裁一次。
    const maxSources = many ? MAX_SOURCES + 8 : MAX_SOURCES;
    const final = deduped.slice(0, maxSources).map((s, i) => ({ ...s, ref: i + 1 }));

    // ④ 检索覆盖回报：哪些实体取到了资料、哪些一条都没取到。
    // 这是「不许说知识库里没有」的事实依据 —— 能列出来的名字，库里一定有。
    //
    // 判据用**按同一预算裁过的那一份**（和调用方 assembleContext 的结果一致）：
    // 不然「已取到资料」的条目可能正好被预算裁掉 —— 模型看不到它，却被告知取到了。
    const kept = assembleContext(final, budget).kept;
    const covered = new Set();
    for (const s of kept) {
      if (s.characterId) covered.add(s.characterId);
      for (const e of entities) {
        if (covered.has(e.id)) continue;
        const t = `${s.title || ''} ${s.text || ''}`;
        if (t.includes(e.name)) covered.add(e.id);
      }
    }
    const names = (list) => list.map((e) => e.name);
    const coverage = {
      total: entities.length,
      fetched: fetched.length,
      capped: entities.length > fetched.length,
      withSources: names(fetched.filter((e) => covered.has(e.id))),
      withoutSources: names(entities.filter((e) => !covered.has(e.id))),
    };

    return {
      entities: entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind || 'character' })),
      scopes,
      keywords,
      coverage,
      sources: final,
    };
  }

  return { retrieve, detectEntities, detectScopes, charRows };
}

/** 把 sources 拼成提示词里的【资料】块，并遵守字符预算。 */
export function assembleContext(sources, budget = DEFAULT_BUDGET) {
  const lines = [];
  let used = 0;
  const kept = [];
  for (const s of sources) {
    const head = `[${s.ref}] (${s.type}) ${s.title}`;
    const body = String(s.text || '').trim();
    const block = `${head}\n${body}`;
    if (used + block.length > budget && kept.length >= 3) break;
    lines.push(block);
    used += block.length;
    kept.push(s);
  }
  return { text: lines.join('\n\n'), kept, chars: used };
}

export { rel };
