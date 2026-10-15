// 客户端接口（/v1）的数据层。
//
// 为什么单独一份、而不是复用 server.mjs 里的函数：
//   1. server.mjs 是 Codex 正在改的文件，动它有冲突风险；
//   2. 给客户端吃的载荷和给浏览器 SPA 吃的载荷**本来就该不一样** ——
//      客户端要的是稳定、分页、字段固定、可写进文档的形状，
//      浏览器要的是「够渲染就行」。
// 所以这里只重写「取数」这一薄层，检索/分词/观测枢/故事线这些难的部分
// 一律 import 现成实现，不复制逻辑。
//
// 只读：kb.sqlite 以 readOnly 打开；侧车库只用来放客户端 token 与用量（KV）。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openWorkspace } from './workspace.mjs';
import { openObc, obcList, obcEntry, obcStats, obcLabel, obcSourceUrl } from './obc.mjs';
import { OBC_ICON_KINDS } from './obc-kinds.mjs';
import { shortNameAtOk } from './names.mjs';
import { canonicalizeNames } from './nicknames.mjs';
import { corpusRevision } from './corpus-revision.mjs';

// kb.sqlite 里 game_id 是**整数** 1（不是 'genshin' 字符串）——
// 写 'genshin' 会让 characters / books 全部查空。
const GID = 1;

/** /v1 对外暴露的知识域清单（客户端用来做覆盖自检与能力发现）。 */
export const V1_DOMAINS = [
  { domain: 'character', label: '角色', source: '米游社观测枢', filterable: ['element', 'weapon', 'rarity', 'region', 'faction'] },
  { domain: 'book', label: '书籍', source: '米游社观测枢', filterable: [] },
  { domain: 'obc', label: '官方图鉴', source: '米游社观测枢', filterable: ['kind', 'menu'] },
  { domain: 'voice', label: '角色语音', source: '米游社观测枢', filterable: ['character'] },
  { domain: 'dialogue', label: '剧情台词', source: '米游社观测枢', filterable: ['character', 'chapter', 'questType'] },
  { domain: 'relation', label: '角色关系', source: '米游社观测枢', filterable: ['character'] },
];

const DEC = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

// 语音分组规则（照搬 server.mjs:341，那边是内联常量、没导出）。
// 必须按**名字**分组，不能直接用 voice_lines.grp 列 —— grp 存的是采集时的原始分组，
// 直接用会让一个角色的语音从 5 组塌成 1 组（胡桃就是这种情况）。
const VOICE_GROUPS = [
  [/^(闲聊|关于我们|关于[^·]*自己|有什么想要分享|感兴趣的见闻|想要了解)/, '闲聊与了解'],
  [/^(早上好|中午好|晚上好|晚安|下雨|打雷|下雪|起风|刮大风)/, '天气与问候'],
  [/^(初次见面|生日|收到赠礼|突破的感受)/, '印象与成长'],
  [/^(元素战技|元素爆发)/, '战斗技能'],
  [/^(冲刺开始|打开风之翼|打开宝箱|生命值低|同伴生命值低|倒下|重受击|加入队伍|普通攻击|重击|下落攻击)/, '战斗表现'],
  [/^(喜欢的食物|讨厌的食物|胡桃的爱好|爱好|烦恼|心愿)/, '喜好'],
];
export function voiceGroupOf(name) {
  for (const [re, label] of VOICE_GROUPS) if (re.test(String(name || ''))) return label;
  return '其他';
}

/** 分组顺序：按 VOICE_GROUPS 的声明序，落不进任何规则的归「其他」。 */
export const VOICE_GROUP_ORDER = [...VOICE_GROUPS.map(([, label]) => label), '其他'];

export function openV1(dataDir, { writable = true } = {}) {
  const db = new DatabaseSync(path.join(dataDir, 'kb.sqlite'), { readOnly: true });
  const ws = openWorkspace(dataDir, { readonly: !writable });
  const obc = openObc(dataDir);
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  // ---------------------------------------------------------------- 覆盖清单

  function coverage() {
    // 注意：characters / books 必须带 game_id 参数，漏了会恒为 0
    const cnt = (t, where = '', ...p) => {
      try { return one(`SELECT COUNT(*) AS c FROM ${t}${where ? ' WHERE ' + where : ''}`, ...p).c; } catch { return 0; }
    };
    const obcCounts = {};
    try {
      for (const r of obcStats(obc) || []) obcCounts[r.kind] = r.count;
    } catch { /* 没导入观测枢数据 */ }
    const domains = V1_DOMAINS.map((d) => {
      let total = 0;
      if (d.domain === 'character') total = cnt('characters', 'game_id = ?', GID);
      else if (d.domain === 'book') total = cnt('books', 'game_id = ?', GID);
      else if (d.domain === 'obc') total = Object.values(obcCounts).reduce((a, b) => a + b, 0);
      else if (d.domain === 'voice') total = cnt('voice_lines');
      else if (d.domain === 'dialogue') total = cnt('dialogue_groups');
      else if (d.domain === 'relation') total = cnt('relations');
      return { ...d, total };
    });
    return {
      game: GID,
      domains,
      obcKinds: Object.entries(obcCounts).map(([kind, count]) => ({ kind, label: obcLabel(kind), count })),
      // 数据来源与边界：客户端必须能把它显示给用户
      sources: [
        { name: '米游社观测枢', url: 'https://baike.mihoyo.com/ys/obc/', note: '米哈游自营，角色 / 语音 / 剧情台词 / 书籍 / 图鉴' },
      ],
      // 尚未替换为公开发布来源的角色（客户端可据此提示用户）
      unreplacedCharacters: q("SELECT name FROM characters WHERE note LIKE '%来源说明（尚未替换）%' ORDER BY name").map((r) => r.name),
    };
  }

  // ---------------------------------------------------------------- 结构化查询

  const FILTER_COL = {
    character: { element: 'element', weapon: 'weapon', rarity: 'rarity', region: 'region', faction: 'faction' },
    book: {},
    obc: { kind: 'kind' },                 // 观测枢分类：kind=enemy / weapon / quest …
    voice: { character: 'character_id' },
    dialogue: { character: 'character_id', chapter: 'chapter', questType: 'quest_type' },
    relation: { character: 'src_id' },
  };
  const SORTS = {
    character: { name: 'name ASC', release_desc: 'release_date DESC', release_asc: 'release_date ASC', rarity_desc: 'rarity DESC, name ASC' },
    book: { title: 'title ASC' },
    voice: { ord: 'character_id ASC, ord ASC' },
    dialogue: { ord: 'character_id ASC, ord ASC' },
    relation: { name: 'src_id ASC, id ASC' },
  };

  /** 把 `element:火,rarity:5` 解析成安全的 WHERE 片段（列名走白名单，值走绑定）。 */
  function parseWhere(domain, raw) {
    const allow = FILTER_COL[domain] || {};
    const clauses = [];
    const params = [];
    for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      const col = allow[key];
      if (!col || !val) continue;                     // 不在白名单直接忽略，不报错
      if (col === 'rarity') { clauses.push('rarity = ?'); params.push(Number(val) || 0); }
      else { clauses.push(`${col} = ?`); params.push(val); }
    }
    return { clauses, params };
  }

  function resolveCharacterId(nameOrId) {
    if (nameOrId == null || nameOrId === '') return null;
    const n = Number(nameOrId);
    if (Number.isFinite(n) && String(n) === String(nameOrId).trim()) return n;
    const r = one('SELECT id FROM characters WHERE game_id = ? AND name = ?', GID, String(nameOrId));
    return r ? r.id : null;
  }

  function query({ domain, q: text = '', where = '', sort = '', limit = 20, offset = 0, countOnly = false }) {
    const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
    const off = Math.max(0, Number(offset) || 0);
    const like = `%${String(text).trim()}%`;

    if (domain === 'obc') {
      // kind 走白名单解析；obcList 只认单一 kind 字符串
      const parsed = parseWhere('obc', where);
      const kind = parsed.clauses.length ? String(parsed.params[0]) : '';
      const res = obcList(obc, { kind, q: text, page: Math.floor(off / lim) + 1, size: lim });
      return {
        domain, total: res.total, limit: lim, offset: off, truncated: res.total > off + res.items.length,
        items: res.items.map((it) => ({
          id: it.id, name: it.name, kind: it.kind, label: it.label, menuLabel: it.menuLabel,
          chars: it.chars, snippet: it.snippet || '', url: `/obc.html#e${it.id}`,
        sourceUrl: it.sourceUrl || obcSourceUrl(it.id),
        })),
      };
    }

    const TABLE = {
      character: 'characters', book: 'books', voice: 'voice_lines',
      dialogue: 'dialogue_groups', relation: 'relations',
    }[domain];
    if (!TABLE) return null;

    const { clauses, params } = parseWhere(domain, where);
    if (domain !== 'obc' && text) {
      if (domain === 'character') { clauses.push('name LIKE ?'); params.push(like); }
      else if (domain === 'book') { clauses.push('title LIKE ?'); params.push(like); }
      else if (domain === 'voice') { clauses.push('(name LIKE ? OR text LIKE ?)'); params.push(like, like); }
      else if (domain === 'dialogue') { clauses.push('(chapter LIKE ? OR quest_title LIKE ?)'); params.push(like, like); }
      else if (domain === 'relation') { clauses.push('target_name LIKE ?'); params.push(like); }
    }
    if (domain === 'character' || domain === 'book') { clauses.push('game_id = ?'); params.push(GID); }
    const W = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';

    const total = one(`SELECT COUNT(*) AS c FROM ${TABLE}${W}`, ...params).c;
    if (countOnly) return { domain, total, limit: lim, offset: off, items: [], truncated: false };

    const order = (SORTS[domain] || {})[sort] || 'id ASC';
    const rows = q(`SELECT * FROM ${TABLE}${W} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, lim, off);

    let items;
    if (domain === 'character') items = rows.map(characterCard);
    else if (domain === 'book') items = rows.map((r) => ({ id: r.id, title: r.title, volumes: r.volume_count, chars: r.char_count, url: `/#/book/${r.id}` }));
    else if (domain === 'voice') items = rows.map((r) => voiceItem(r));
    else if (domain === 'dialogue') items = rows.map((r) => dialogueItem(r));
    else items = rows.map((r) => relationItem(r));

    return { domain, total, limit: lim, offset: off, truncated: total > off + items.length, items };
  }

  // ---------------------------------------------------------------- 条目形状

  // 「基础档案」的核心字段。用来判断一个角色的档案是不是空壳。
  const PROFILE_CORE = ['title', 'faction', 'region', 'constellation', 'element',
    'weapon', 'rarity', 'birthday', 'cv_cn', 'release_date', 'role'];

  function characterCard(r) {
    const filledCore = PROFILE_CORE.reduce((n, k) => {
      const v = r[k];
      return n + (v !== null && v !== undefined && v !== '' ? 1 : 0);
    }, 0);
    return {
      id: r.id, name: r.name, enName: r.en_name || '', pinyin: r.pinyin || '',
      title: r.title || '', identity: r.identity || '', faction: r.faction || '',
      region: r.region || '', constellation: r.constellation || '',
      element: r.element || '', weapon: r.weapon || '', rarity: r.rarity || null,
      // 观测枢角色页的「定位」，如「爆发型输出角色」。此前因字段名对不上整列丢失。
      role: r.role || '',
      // 词条 id 与观测枢原文地址：让用户能回官方核对，而不是只能看我们的转述。
      obcId: r.obc_id || null,
      sourceUrl: obcSourceUrl(r.obc_id),
      // 档案是否为空壳。两个信号：
      //   ① 观测枢没有对应角色词条（obcId 为空）—— 这是**源头限制**，
      //      观测枢只收可玩角色，派蒙/戴因斯雷布/愚人众执行官都没有角色页；
      //   ② 词条在、但核心字段少得异常。
      // 客户端据此显示「观测枢未收录其档案，但台词已收录 N 条」，而不是甩一张空表 ——
      // 空表会让用户以为是我们没做全。
      profileIncomplete: !r.obc_id || filledCore < 4,
      profileFields: filledCore,
      birthday: r.birthday || '', cv: r.cv_cn || '', releaseDate: r.release_date || '',
      unreplaced: /来源说明（尚未替换）/.test(r.note || ''),
      art: {
        icon: r.has_icon ? `/v1/asset/character/${r.id}?size=icon` : null,
        thumb: r.has_full_art ? `/v1/asset/character/${r.id}?size=thumb` : null,
        display: r.has_full_art ? `/v1/asset/character/${r.id}?size=display` : null,
      },
      url: `/#/character/${r.id}`,
    };
  }
  function voiceItem(r) {
    const c = one('SELECT name FROM characters WHERE id = ?', r.character_id);
    return {
      id: r.id, characterId: r.character_id, character: c ? c.name : '',
      group: r.grp || '', name: r.name, text: r.text,
      url: `/#/character/${r.character_id}`,
    };
  }
  function dialogueItem(r) {
    const c = one('SELECT name FROM characters WHERE id = ?', r.character_id);
    return {
      id: r.id, characterId: r.character_id, character: c ? c.name : '',
      questType: r.quest_type || '', chapter: r.chapter || '', questTitle: r.quest_title || '',
      lines: r.line_count, url: `/#/character/${r.character_id}`,
    };
  }
  function relationItem(r) {
    const s = one('SELECT name FROM characters WHERE id = ?', r.src_id);
    return {
      id: r.id, from: s ? s.name : String(r.src_id), fromId: r.src_id,
      to: r.target_name || '', toId: r.target_id, quote: r.quote || '',
    };
  }

  // ---------------------------------------------------------------- 单条详情

  function getRecord(kind, id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    if (kind === 'character') {
      const r = one('SELECT * FROM characters WHERE id = ? AND game_id = ?', n, GID);
      if (!r) return null;
      const voices = q('SELECT grp, name, text FROM voice_lines WHERE character_id = ? ORDER BY ord', n);
      const vg = new Map();
      for (const v of voices) {
        const g = voiceGroupOf(v.name);
        if (!vg.has(g)) vg.set(g, []);
        vg.get(g).push({ name: v.name, text: v.text });
      }
      return {
        ...characterCard(r),
        bio: r.bio || '', persona: r.persona || '', note: r.note || '',
        stories: q('SELECT ord, title, body FROM story_chapters WHERE character_id = ? ORDER BY ord', n)
          .map((s) => ({ title: s.title, body: s.body })),
        voices: [...vg.entries()].map(([group, items]) => ({ group, items })),
        preferences: q('SELECT kind, label, text FROM preferences WHERE character_id = ? ORDER BY ord', n),
        dialogue: q('SELECT id, quest_type, chapter, quest_title, line_count FROM dialogue_groups WHERE character_id = ? ORDER BY ord', n)
          .map((g) => ({ id: g.id, questType: g.quest_type, chapter: g.chapter, questTitle: g.quest_title, lines: g.line_count })),
        relations: q(`SELECT r.id, r.target_id, r.target_name, r.quote,
                             (SELECT name FROM characters WHERE id = r.target_id) AS resolved
                        FROM relations r WHERE r.src_id = ? ORDER BY r.id`, n)
          .map((e) => ({ toId: e.target_id, to: e.resolved || e.target_name, quote: e.quote })),
        forms: q('SELECT label, element, weapon, rarity, release_date FROM character_forms WHERE character_id = ?', n),
      };
    }
    if (kind === 'book') {
      const r = one('SELECT * FROM books WHERE id = ? AND game_id = ?', n, GID);
      if (!r) return null;
      return {
        id: r.id, title: r.title, volumes: r.volume_count, chars: r.char_count,
        sections: q('SELECT ord, title, body FROM book_sections WHERE book_id = ? ORDER BY ord', n)
          .map((s) => ({ title: s.title, body: s.body })),
        url: `/#/book/${r.id}`,
      };
    }
    if (kind === 'obc') {
      const e = obcEntry(obc, n);
      if (!e) return null;
      return { id: e.id, name: e.name, kind: e.kind, label: e.label, menuLabel: e.menuLabel, text: e.text.replace(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi,''), url: `/obc.html#e${e.id}`, sourceUrl: obcSourceUrl(e.id) };
    }
    return null;
  }

  // ---------------------------------------------------------------- 资源

  const ASSETS = path.join(dataDir, 'assets');
  function resolveArt(kind, id, size) {
    // 观测枢条目（武器 / 圣遗物 / 敌人 / 书籍…）的图**不在原来的素材库里**。
    // obc_entries.icon 存的是米哈游 CDN 的 URL（act-upload.mihoyo.com、
    // uploadstatic.mihoyo.com —— 都是官方域名）。
    // tools/fetch-obc-icons.mjs 会把用得到的那些抓下来落到 data/assets/obc/<id>.<ext>，
    // 这里只负责找到已落盘的那一份；没落盘就返回 null（前端优雅降级成纯文字）。
    // 哪些 kind 抓了图，见 lib/obc-kinds.mjs 的 OBC_ICON_KINDS（别在这里再列一遍）。
    if (kind === 'obc' || OBC_ICON_KINDS.includes(kind) || kind === 'book') {
      const key = String(id);
      for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif']) {
        const f = path.join(ASSETS, 'obc', `${key}.${ext}`);
        const resolved = path.resolve(f);
        if (!resolved.startsWith(path.resolve(path.join(ASSETS, 'obc')))) return null;
        if (fs.existsSync(resolved)) return resolved;
      }
      return null;
    }
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    if (kind !== 'character') return null;
    const sub = size === 'display' ? 'display' : size === 'thumb' ? 'thumbs' : 'icons';
    const r = one('SELECT name, has_full_art, has_icon FROM characters WHERE id = ? AND game_id = ?', n, GID);
    if (!r) return null;
    if (size === 'display' || size === 'thumb') { if (!r.has_full_art) return null; }
    else if (!r.has_icon) return null;
    // 落盘文件名是 URL 编码过的（data/assets/icons/%E4%B8%83%E4%B8%83.webp），
    // 直接用中文名拼路径会 404。
    const file = path.join(ASSETS, sub, `${encodeURIComponent(r.name)}.webp`);
    // 目录穿越防护：解析后必须仍在 ASSETS 下
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(ASSETS))) return null;
    if (!fs.existsSync(resolved)) return null;
    return resolved;
  }

  // ---------------------------------------------------------------- 客户端 token（KV）

  const TK = 'client_token:';
  function listTokens() {
    return ws.listKv().filter((r) => r.key.startsWith(TK)).map((r) => ({ key: r.key.slice(TK.length), ...(r.value || {}) }));
  }
  function findToken(hash) {
    const r = ws.getKv(TK + hash);
    return r ? r.value : null;
  }

  // ---------------------------------------------------------------- 锚点识别

  // 实测（gen-suite/test 里那批问题）：问题里出现「知识库某个具名条目」
  // 这个信号**精确度很高、召回偏低** ——
  //   库外问题 10/10 全部无锚点；库内问题 9/13 有锚点。
  // 缺的 4 个是「往生堂是什么」「什么是命之座」这类：内容确实在库里
  // （写在角色故事的正文里），只是问题里没有具名条目。
  // 所以锚点只能用来标「依据较弱」，**不能**用来硬拒答。
  function buildAnchorIndex() {
    const list = [];
    for (const x of q('SELECT name FROM characters WHERE game_id = ?', GID)) list.push({ kind: 'character', domain: 'character', name: x.name });
    for (const x of q('SELECT title FROM books WHERE game_id = ?', GID)) list.push({ kind: 'book', domain: 'book', name: x.title });
    if (obc) for (const x of obc.prepare('SELECT id, name, kind FROM obc_entries').all()) list.push({ kind: 'obc', domain: 'obc:' + x.kind, id: x.id, name: x.name });
    // 长的优先：避免「钟」这种单字名乱撞。
    // 但**不能把单字名一律丢掉** —— 主库里有 2 个单字名角色（琴、魈），
    // 丢掉它们会让「琴是谁」被判成「依据较弱」（闸门认为问题里没有具名条目）。
    // 所以单字名保留，匹配时要求出现在句首或前面不是汉字（和 chat/retrieve.mjs 同一套规则）。
    return list
      .filter((x) => x.name && x.name.length >= 1)
      .sort((a, b) => b.name.length - a.name.length);
  }
  let anchorIndex = buildAnchorIndex(), anchorRevision = corpusRevision();

  /**
   * 单字条目名的边界判断。
   * 规则在 lib/names.mjs（chat/retrieve.mjs 用的是同一份）—— 两处判断不一致会出现
   * 「检索认出了这个角色、闸门却不认」的割裂（表现为回答是对的，但依据等级标成「较弱」）。
   *
   * 规则：句首且下一个字是助词/查询词，或者前面不是汉字 / 是列举连接词（和/与/跟…）。
   * 「琴声」「琴键」「琴谱」的「声/键/谱」不在白名单里，所以不会误命中。
   */
  function shortNameOk(s, name) {
    let at = s.indexOf(name);
    while (at >= 0) {
      if (shortNameAtOk(s, at, name.length)) return true;
      at = s.indexOf(name, at + 1);
    }
    return false;
  }

  /** 问题里出现了哪些知识库具名条目。 */
  function findAnchors(question, limit = 5) {
    if(anchorRevision!==corpusRevision()){anchorIndex=buildAnchorIndex();anchorRevision=corpusRevision();}
    const s = canonicalizeNames(question);
    const out = [];
    for (const a of anchorIndex) {
      if (out.length >= limit) break;
      if (a.name.length === 1) {
        if (!shortNameOk(s, a.name)) continue;
      } else if (!s.includes(a.name)) {
        continue;
      }
      out.push(a);
    }
    return out;
  }

  return {
    db, ws, obc,
    coverage, query, getRecord, resolveArt, resolveCharacterId, findAnchors,
    listTokens, findToken, tokensPrefix: TK,
    close() {
      try { db.close(); } catch { /* ignore */ }
      try { if (obc) obc.close(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}
