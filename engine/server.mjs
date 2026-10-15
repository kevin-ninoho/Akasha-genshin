#!/usr/bin/env node
// 原神可视化知识库本地服务（Node 24 零依赖：node:http + node:sqlite）。
//   node server.mjs            默认 127.0.0.1:5178
//   KB_PORT=5200 node server.mjs
//
// 只监听回环地址；不下载任何远程资源。
//
// 读写模型（v1.1 起放开权限）：
//   * kb.sqlite        —— 以 readOnly 打开。它是 build.mjs 的产物，重建会覆盖，
//                         所以这里只读：查询 / 检索 / FTS / 关系网全走它。
//   * kb-workspace.sqlite —— 侧车可写库（lib/workspace.mjs）。笔记、派单、素材、
//                         标签、KV 以及 /api/query?mode=write 的任意 SQL 都落这里。
//   * HTTP 层不再只放行 GET：开放 POST/PUT/PATCH/DELETE 与跨域（CORS / OPTIONS），
//                         方便 MCP、DSH、脚本与浏览器页面直接调用。
//   * KB_WRITE=0 可一键关掉所有写操作（只读模式），用于演示 / 只读镜像。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { queryExpr, snippet } from './lib/tokenize.mjs';
import { REGIONS, DEFAULT_REGION, ELEMENT_COLORS, ARCHONS } from './lib/domain.mjs';
import { openWorkspace, runReadQuery } from './lib/workspace.mjs';
import { openObc, obcStats, obcList, obcEntry, obcRecommends, OBC_KIND_LABEL } from './lib/obc.mjs';
import { runChat, resetSession, sessionCount } from './chat/agent.mjs';
import { loadConfig, resolveProvider, configPath } from './chat/llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.KB_DATA_DIR || path.join(DATA);
const DB_PATH = path.join(DATA, 'kb.sqlite');
if (!fs.existsSync(DB_PATH)) { console.error('未配置资料库，请设置 KB_DATA_DIR。客户端请运行 serve-client.mjs。'); process.exit(2); }
const WEB = path.join(HERE, 'web');
const ASSETS = path.join(DATA, 'assets');
const CHAT_DIR = path.join(HERE, 'chat');
const HOST = '127.0.0.1';
const PORT = Number(process.env.KB_PORT || 5178);
const GAME = 'genshin';
const WRITE_ENABLED = process.env.KB_WRITE !== '0';

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const ws = openWorkspace(path.join(DATA), { readonly: !WRITE_ENABLED });

// 观测枢官方数据（obc_entries / obc_fts）在侧车库，另开一个只读连接。
// 来源：米游社观测枢 baike.mihoyo.com（米哈游自营）的公开接口。
// 数据由 dsh-integrations/gen-suite/tools/obc-import.mjs 导入；没有就当作没有。
const obcDb = openObc(path.join(DATA));

const gameId = (slug) => {
  const r = one('SELECT id FROM games WHERE slug=?', slug);
  if (!r) throw new HttpError(404, 'game_not_found', `未知游戏 ${slug}`);
  return r.id;
};
const GID = gameId(GAME);

// ---------------------------------------------------------------- 小工具

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 服务端高亮：\u0001..\u0002 标记 -> <mark>，正文先转义（安全）。 */
function highlight(text, query, radius = 70) {
  const { snippet: s, hits } = snippet(text, query, radius, 2);
  const html = esc(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
  return { html, hits };
}

function themeOf(region) {
  return REGIONS[region] || DEFAULT_REGION;
}

function decodeJson(v, fallback) {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function slug(name) {
  return encodeURIComponent(name);
}

function multiParam(sp, key) {
  const out = [];
  for (const raw of sp.getAll(key)) {
    for (const piece of String(raw).split(',')) {
      const t = piece.trim();
      if (t) out.push(t);
    }
  }
  return [...new Set(out)];
}

function intParam(sp, key, def, min, max) {
  const raw = sp.get(key);
  if (raw == null || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new HttpError(400, 'bad_param', `参数 ${key} 必须是整数`);
  return Math.min(max, Math.max(min, n));
}

function artUrl(row, size) {
  if (!row) return null;
  if (size === 'icon') return row.has_icon ? `/api/art/${row.id}?size=icon` : null;
  if (size === 'thumb') return row.has_full_art ? `/api/art/${row.id}?size=thumb` : null;
  return row.has_full_art ? `/api/art/${row.id}?size=display` : null;
}

/** 卡片级字段（列表用，避免把长文本塞进列表响应）。 */
function cardOf(row) {
  const theme = themeOf(row.region);
  const counts = decodeJson(row.counts_json, {});
  return {
    id: row.id,
    name: row.name,
    enName: row.en_name || null,
    pinyin: row.pinyin || null,
    title: row.title,
    identity: row.identity,
    faction: row.faction,
    region: row.region,
    constellation: row.constellation,
    element: row.element,
    weapon: row.weapon,
    rarity: row.rarity,
    birthday: row.birthday,
    cv: row.cv_cn,
    releaseDate: row.release_date,
    regionColor: row.region_color || theme.color,
    regionDeep: theme.deep,
    regionArchon: row.region_archon || theme.archon,
    regionTone: theme.tone,
    elementColor: ELEMENT_COLORS[row.element] || theme.color,
    hasFullArt: !!row.has_full_art,
    hasIcon: !!row.has_icon,
    thumbUrl: artUrl(row, 'thumb'),
    iconUrl: artUrl(row, 'icon'),
    counts,
  };
}

// ---------------------------------------------------------------- 检索

const SEARCH_TYPES = new Set(['all', 'character', 'story', 'voice', 'dialogue', 'book']);

function ftsRows(expr, type, limit) {
  const params = [expr];
  let sql = `SELECT d.id, d.doc_type, d.owner_id, d.owner_name, d.heading, d.text, d.extra_json,
                    bm25(search_fts) AS score
             FROM search_fts f JOIN search_docs d ON d.id = f.rowid
             WHERE f.tokens MATCH ?`;
  if (type && type !== 'all') { sql += ' AND d.doc_type = ?'; params.push(type); }
  sql += ' ORDER BY score LIMIT ?';
  params.push(limit);
  return q(sql, ...params);
}

function doSearch(query, type, limitPerGroup) {
  const expr = queryExpr(query);
  const groups = { character: [], story: [], voice: [], dialogue: [], book: [] };
  if (!expr) return { query, groups, total: 0 };

  const rows = ftsRows(expr, type, Math.max(200, limitPerGroup * 12));
  const seenOwner = new Set();
  const ownerById = new Map();

  for (const row of rows) {
    if (row.doc_type === 'character') {
      if (seenOwner.has(row.owner_id)) continue;
      seenOwner.add(row.owner_id);
    }
    if (!groups[row.doc_type]) continue;
    if (groups[row.doc_type].length >= limitPerGroup) continue;

    const extra = decodeJson(row.extra_json, {});
    const hl = highlight(row.text, query);
    if (!hl.hits && row.doc_type !== 'character') continue;   // 二元组命中但原文定位不到 -> 丢弃

    if (row.doc_type === 'character') {
      const ch = one('SELECT * FROM characters WHERE id=?', row.owner_id);
      if (!ch) continue;
      const card = cardOf(ch);
      ownerById.set(row.owner_id, card);
      groups.character.push({
        ...card,
        score: round2(row.score),
        snippet: hl.html,
      });
      continue;
    }
    if (row.doc_type === 'book') {
      const bk = one('SELECT id, title, volume_count, char_count FROM books WHERE id=?', row.owner_id);
      if (!bk) continue;
      groups.book.push({
        bookId: bk.id,
        title: bk.title,
        volume: extra.volume || row.heading || null,
        volumeCount: bk.volume_count,
        charCount: bk.char_count,
        score: round2(row.score),
        snippet: hl.html,
      });
      continue;
    }
    groups[row.doc_type].push({
      characterId: row.owner_id,
      characterName: row.owner_name,
      heading: row.heading,
      group: extra.group || null,
      index: extra.index ?? null,
      score: round2(row.score),
      snippet: hl.html,
    });
  }

  const total = Object.values(groups).reduce((a, g) => a + g.length, 0);
  return { query, groups, total };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---------------------------------------------------------------- 角色列表

const SORTS = {
  release_desc: (a, b) => cmpStr(b.release_date, a.release_date) || cmpStr(a.name, b.name),
  release_asc: (a, b) => cmpStr(a.release_date || '9999', b.release_date || '9999') || cmpStr(a.name, b.name),
  name: (a, b) => cmpStr(a.pinyin || a.name, b.pinyin || b.name),
  name_desc: (a, b) => cmpStr(b.pinyin || b.name, a.pinyin || a.name),
  rarity_desc: (a, b) => (b.rarity || 0) - (a.rarity || 0) || cmpStr(a.name, b.name),
  rarity_asc: (a, b) => (a.rarity || 0) - (b.rarity || 0) || cmpStr(a.name, b.name),
};

function cmpStr(a, b) {
  const x = a == null ? '' : String(a);
  const y = b == null ? '' : String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function listCharacters(sp) {
  const facets = {
    region: multiParam(sp, 'region'),
    element: multiParam(sp, 'element'),
    weapon: multiParam(sp, 'weapon'),
    rarity: multiParam(sp, 'rarity'),
    faction: multiParam(sp, 'faction'),
  };
  const query = (sp.get('q') || '').trim();
  const sort = sp.get('sort') || 'release_desc';
  const page = intParam(sp, 'page', 1, 1, 10000);
  const pageSize = intParam(sp, 'pageSize', 48, 1, 200);

  let rows = q('SELECT * FROM characters WHERE game_id=?', GID);
  if (facets.region.length) rows = rows.filter((r) => facets.region.includes(r.region));
  if (facets.element.length) rows = rows.filter((r) => facets.element.includes(r.element));
  if (facets.weapon.length) rows = rows.filter((r) => facets.weapon.includes(r.weapon));
  if (facets.rarity.length) rows = rows.filter((r) => facets.rarity.includes(String(r.rarity)));
  if (facets.faction.length) rows = rows.filter((r) => facets.faction.includes(r.faction));

  let rank = null;
  if (query) {
    rank = new Map();
    const expr = queryExpr(query);
    if (expr) {
      for (const r of ftsRows(expr, 'character', 500)) {
        if (!rank.has(r.owner_id)) rank.set(r.owner_id, r.score);
      }
    }
    // 名字 / 英文名 / 拼音 直接前缀匹配兜底（保证输入完整角色名必定命中）
    const needle = query.toLowerCase();
    for (const r of rows) {
      const keys = [r.name, r.en_name || '', (r.pinyin || '').toLowerCase(), (r.pinyin_spaced || '').toLowerCase()];
      if (keys.some((k) => k && (k.toLowerCase() === needle || k.toLowerCase().startsWith(needle)))) {
        if (!rank.has(r.id)) rank.set(r.id, -1000);
      }
    }
    rows = rows.filter((r) => rank.has(r.id));
    rows.sort((a, b) => (rank.get(a.id) - rank.get(b.id)) || cmpStr(a.name, b.name));
  } else {
    rows.sort(SORTS[sort] || SORTS.release_desc);
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  return {
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    sort: query ? 'relevance' : sort,
    filters: facets,
    items: rows.slice(start, start + pageSize).map(cardOf),
  };
}

// ---------------------------------------------------------------- 角色详情

const VOICE_GROUPS = [
  [/^(闲聊|关于我们|关于[^·]*自己|有什么想要分享|感兴趣的见闻|想要了解)/, '闲聊与了解'],
  [/^(早上好|中午好|晚上好|晚安|下雨|打雷|下雪|起风|刮大风)/, '天气与问候'],
  [/^(初次见面|生日|收到赠礼|突破的感受)/, '印象与成长'],
  [/^(元素战技|元素爆发)/, '战斗技能'],
  [/^(冲刺开始|打开风之翼|打开宝箱|生命值低|同伴生命值低|倒下|重受击|加入队伍|普通攻击|重击|下落攻击)/, '战斗表现'],
  [/^(喜欢的食物|讨厌的食物|胡桃的爱好|爱好|烦恼|心愿)/, '喜好'],
];

function voiceGroupOf(name) {
  for (const [re, label] of VOICE_GROUPS) if (re.test(name)) return label;
  return '其他';
}

function characterDetail(id) {
  const row = one('SELECT * FROM characters WHERE id=? AND game_id=?', id, GID);
  if (!row) throw new HttpError(404, 'character_not_found', `没有 id=${id} 的角色`);
  const card = cardOf(row);

  const forms = q('SELECT label, element, weapon, rarity, release_date FROM character_forms WHERE character_id=? ORDER BY id', id);
  const stories = q('SELECT ord, title, body FROM story_chapters WHERE character_id=? ORDER BY ord', id);
  const voiceRows = q('SELECT grp, ord, name, text FROM voice_lines WHERE character_id=? ORDER BY ord', id);
  const voices = [];
  const voiceMap = new Map();
  for (const v of voiceRows) {
    const g = voiceGroupOf(v.name);
    if (!voiceMap.has(g)) { voiceMap.set(g, []); voices.push({ group: g, items: voiceMap.get(g) }); }
    voiceMap.get(g).push({ name: v.name, text: v.text });
  }
  const dialogue = q(
    'SELECT id, ord, quest_type, chapter, chapter_id, quest_title, quest_id, line_count FROM dialogue_groups WHERE character_id=? ORDER BY ord',
    id,
  ).map((g) => ({
    id: g.id,
    ord: g.ord,
    questType: g.quest_type,
    chapter: g.chapter,
    chapterId: g.chapter_id,
    questTitle: g.quest_title,
    questId: g.quest_id,
    lineCount: g.line_count,
  }));
  const preferences = q('SELECT kind, label, text FROM preferences WHERE character_id=? ORDER BY ord', id);
  const prefGroups = [];
  const prefMap = new Map();
  for (const p of preferences) {
    if (!prefMap.has(p.kind)) { prefMap.set(p.kind, []); prefGroups.push({ kind: p.kind, items: prefMap.get(p.kind) }); }
    prefMap.get(p.kind).push({ label: p.label, text: p.text });
  }

  const relations = q(
    `SELECT r.id, r.target_id, r.target_name, r.quote, c.name AS resolved_name
       FROM relations r LEFT JOIN characters c ON c.id = r.target_id
      WHERE r.src_id=? ORDER BY r.id`,
    id,
  ).map((r) => ({
    id: r.id,
    targetId: r.target_id,
    targetName: r.target_name,
    resolved: !!r.target_id,
    resolvedName: r.resolved_name,
    quote: r.quote,
  }));

  const artworks = q('SELECT kind, name, webp_path, width, height, bytes FROM artworks WHERE character_id=? ORDER BY kind', id)
    .map((a) => ({ kind: a.kind, width: a.width, height: a.height, bytes: a.bytes }));

  const archonRow = card.regionArchon ? one('SELECT id, name FROM characters WHERE name=?', card.regionArchon) : null;

  return {
    ...card,
    bio: row.bio,
    persona: row.persona,
    note: row.note,
    preamble: row.preamble,
    cv: row.cv_cn,
    constellation: row.constellation,
    displayUrl: artUrl(row, 'display'),
    archonName: card.regionArchon,
    archonArtUrl: archonRow ? artUrl(artworksRow(archonRow.id), 'display') : null,
    archonIconUrl: archonRow ? artUrl(artworksRow(archonRow.id), 'icon') : null,
    forms,
    stories,
    voices,
    dialogue,
    preferences: prefGroups,
    relations,
    artworks,
  };
}

function artworksRow(id) {
  return one('SELECT id, has_full_art, has_icon FROM characters WHERE id=?', id);
}

function relationEdgesFor(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return q(
    `SELECT r.src_id, r.target_id, r.target_name, r.quote, c.name AS resolved_name
       FROM relations r LEFT JOIN characters c ON c.id = r.target_id
      WHERE r.src_id IN (${placeholders}) AND r.target_id IS NOT NULL`,
    ...ids,
  );
}

function relationGraph(id, depth) {
  const root = one('SELECT id, name FROM characters WHERE id=? AND game_id=?', id, GID);
  if (!root) throw new HttpError(404, 'character_not_found', `没有 id=${id} 的角色`);

  const visited = new Set([root.id]);
  const frontier = [root.id];
  const edges = [];
  const edgeKey = new Set();
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const e of relationEdgesFor(frontier)) {
      const key = `${e.src_id}>${e.target_id}>${e.quote}`;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({
        source: e.src_id,
        target: e.target_id,
        sourceName: one('SELECT name FROM characters WHERE id=?', e.src_id)?.name || null,
        targetName: e.resolved_name || e.target_name,
        quote: e.quote,
      });
      if (!visited.has(e.target_id)) { visited.add(e.target_id); next.push(e.target_id); }
    }
    frontier.length = 0;
    frontier.push(...next);
    if (!frontier.length) break;
  }

  const nodes = q(
    `SELECT id, name, region, element, has_full_art, has_icon, region_color, rarity
       FROM characters WHERE id IN (${[...visited].map(() => '?').join(',')})`,
    ...visited,
  ).map((n) => {
    const theme = themeOf(n.region);
    return {
      id: n.id,
      name: n.name,
      region: n.region,
      element: n.element,
      rarity: n.rarity,
      color: n.region_color || theme.color,
      elementColor: ELEMENT_COLORS[n.element] || theme.color,
      root: n.id === root.id,
      degree: 0,
      thumbUrl: artUrl(n, 'thumb'),
      iconUrl: artUrl(n, 'icon'),
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (byId.has(e.source)) byId.get(e.source).degree++;
    if (byId.has(e.target)) byId.get(e.target).degree++;
  }
  return { root: root.id, depth, nodes, edges };
}

// ---------------------------------------------------------------- 书籍

function listBooks(sp) {
  const query = (sp.get('q') || '').trim();
  const page = intParam(sp, 'page', 1, 1, 10000);
  const pageSize = intParam(sp, 'pageSize', 60, 1, 200);
  const sort = sp.get('sort') || 'size_desc';

  let rows = q('SELECT id, title, volume_count, char_count, bytes, slug FROM books WHERE game_id=?', GID);
  let snippetsById = new Map();
  if (query) {
    const expr = queryExpr(query);
    const ids = new Set();
    if (expr) {
      for (const r of ftsRows(expr, 'book', 600)) {
        ids.add(r.owner_id);
        if (!snippetsById.has(r.owner_id)) snippetsById.set(r.owner_id, highlight(r.text, query).html);
      }
    }
    for (const r of rows) if (r.title.includes(query)) { ids.add(r.id); if (!snippetsById.has(r.id)) snippetsById.set(r.id, esc(r.title)); }
    rows = rows.filter((r) => ids.has(r.id));
    rows.sort((a, b) => (b.char_count || 0) - (a.char_count || 0));
  } else if (sort === 'title') {
    rows.sort((a, b) => cmpStr(a.title, b.title));
  } else {
    rows.sort((a, b) => (b.char_count || 0) - (a.char_count || 0));
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  return {
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    query,
    items: rows.slice(start, start + pageSize).map((r) => ({
      id: r.id,
      title: r.title,
      volumeCount: r.volume_count,
      charCount: r.char_count,
      bytes: r.bytes,
      snippet: snippetsById.get(r.id) || null,
    })),
  };
}

function bookDetail(id) {
  const row = one('SELECT id, title, volume_count, char_count, bytes FROM books WHERE id=? AND game_id=?', id, GID);
  if (!row) throw new HttpError(404, 'book_not_found', `没有 id=${id} 的书籍`);
  const sections = q('SELECT ord, title, body FROM book_sections WHERE book_id=? ORDER BY ord', id);
  return {
    id: row.id,
    title: row.title,
    volumeCount: row.volume_count,
    charCount: row.char_count,
    bytes: row.bytes,
    sections,
  };
}

// ---------------------------------------------------------------- 分面 / 元信息

function gamesPayload() {
  return q('SELECT slug, name, sort, enabled FROM games ORDER BY sort').map((g) => {
    const gid = one('SELECT id FROM games WHERE slug=?', g.slug)?.id;
    return {
      slug: g.slug,
      name: g.name,
      enabled: !!g.enabled,
      characters: gid ? one('SELECT COUNT(*) n FROM characters WHERE game_id=?', gid).n : 0,
      books: gid ? one('SELECT COUNT(*) n FROM books WHERE game_id=?', gid).n : 0,
    };
  });
}

function facetsPayload() {
  const rows = q('SELECT * FROM characters WHERE game_id=?', GID);
  const tally = (key, filter) => {
    const map = new Map();
    for (const r of rows) {
      const v = r[key];
      if (v == null || v === '' || v === '—' || v === '——') continue;
      if (filter && !filter(r)) continue;
      map.set(v, (map.get(v) || 0) + 1);
    }
    return map;
  };
  const pack = (map, extra) =>
    [...map.entries()].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])).map(([value, count]) => ({ value, count, ...(extra ? extra(value) : {}) }));

  return {
    region: pack(tally('region'), (v) => {
      const t = themeOf(v);
      return { color: t.color, archon: t.archon, tone: t.tone };
    }),
    element: pack(tally('element'), (v) => ({ color: ELEMENT_COLORS[v] || '#9AA7B8' })),
    weapon: pack(tally('weapon')),
    rarity: pack(tally('rarity')).map((r) => ({ ...r, value: String(r.value) })),
    faction: pack(tally('faction')),
  };
}

function archonsPayload() {
  return ARCHONS.map((name) => {
    const row = one('SELECT id, name, region, element, region_color, has_full_art FROM characters WHERE name=?', name);
    if (!row) return { name, missing: true };
    const theme = themeOf(row.region);
    return {
      name: row.name,
      id: row.id,
      region: row.region,
      element: row.element,
      color: row.region_color || theme.color,
      elementColor: ELEMENT_COLORS[row.element] || theme.color,
      tone: theme.tone,
      displayUrl: artUrl(row, 'display'),
      thumbUrl: artUrl(row, 'thumb'),
    };
  });
}

function healthPayload() {
  const meta = Object.fromEntries(q('SELECT key, value FROM meta').map((r) => [r.key, r.value]));
  return {
    ok: true,
    service: 'ambr-kb 可视化知识库',
    game: GAME,
    writable: WRITE_ENABLED,
    access: {
      read: '/api/*（SELECT / 检索 / 关系网 / 美术）',
      write: WRITE_ENABLED ? '/api/notes · /api/jobs · /api/assets · /api/tags · /api/kv · /api/query?mode=write' : null,
      introspect: '/api/schema · /api/query?mode=read',
    },
    db: {
      characters: one('SELECT COUNT(*) n FROM characters WHERE game_id=?', GID).n,
      books: one('SELECT COUNT(*) n FROM books WHERE game_id=?', GID).n,
      relations: one('SELECT COUNT(*) n FROM relations WHERE game_id=?', GID).n,
      searchDocs: one('SELECT COUNT(*) n FROM search_docs').n,
      artworks: one('SELECT COUNT(*) n FROM artworks WHERE character_id IS NOT NULL').n,
    },
    workspace: WRITE_ENABLED
      ? { file: ws.file, counts: ws.summary().counts }
      : { file: null, counts: null },
    builtAt: meta.built_at || null,
    buildMs: meta.build_ms || null,
    stats: decodeJson(meta.stats, null),
  };
}

// ---------------------------------------------------------------- 图片

function placeholderSvg(name, region, element) {
  const theme = themeOf(region);
  const color = theme.color;
  const deep = theme.deep;
  const label = esc(name || '?');
  const el = esc(element || theme.element || '');
  // 1:1 画布 + 居中的徽记：卡片（1:1，object-fit:cover）与详情页横条（background-size:cover）
  // 都会围绕中心裁切，名字与徽记都必须落在中心安全区内，否则会被裁掉半行。
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${deep}"/>
      <stop offset="100%" stop-color="${color}"/>
    </linearGradient>
  </defs>
  <rect width="400" height="400" fill="url(#g)"/>
  <circle cx="200" cy="200" r="104" fill="#ffffff" opacity="0.13"/>
  <circle cx="200" cy="200" r="80" fill="#ffffff" opacity="0.19"/>
  <text x="200" y="220" text-anchor="middle" font-family="system-ui,sans-serif" font-size="54" fill="#ffffff" opacity="0.94">${el}</text>
  <text x="200" y="330" text-anchor="middle" font-family="system-ui,sans-serif" font-size="30" fill="#ffffff" opacity="0.96">${label}</text>
  <text x="200" y="362" text-anchor="middle" font-family="system-ui,sans-serif" font-size="16" fill="#ffffff" opacity="0.7">暂无立绘</text>
</svg>`;
}

const ART_KINDS = {
  thumb: 'thumbs',
  display: 'display',
  icon: 'icons',
};

/** 单个「任务场景」下的逐句台词；前端 <details> 展开时才拉取。 */
function dialogueDetail(gid) {
  const group = one(
    `SELECT g.id, g.character_id, g.ord, g.quest_type, g.chapter, g.chapter_id,
            g.quest_title, g.quest_id, g.line_count, c.name AS character_name
       FROM dialogue_groups g JOIN characters c ON c.id = g.character_id
      WHERE g.id=?`,
    gid,
  );
  if (!group) throw new HttpError(404, 'dialogue_not_found', `没有 id=${gid} 的剧情台词组`);
  const lines = q(
    'SELECT ord, heading, speaker, text FROM dialogue_lines WHERE group_id=? ORDER BY ord, id',
    gid,
  ).map((l) => ({ ord: l.ord, heading: l.heading, speaker: l.speaker, text: l.text }));
  return {
    id: group.id,
    characterId: group.character_id,
    characterName: group.character_name,
    group: {
      id: group.id,
      ord: group.ord,
      questType: group.quest_type,
      chapter: group.chapter,
      chapterId: group.chapter_id,
      questTitle: group.quest_title,
      questId: group.quest_id,
      lineCount: group.line_count,
    },
    lines,
  };
}

function serveArt(res, id, size) {
  if (!ART_KINDS[size]) throw new HttpError(400, 'bad_size', 'size 必须是 thumb | display | icon');
  const row = one('SELECT id, name, region, element, has_full_art, has_icon FROM characters WHERE id=? AND game_id=?', id, GID);
  if (!row) throw new HttpError(404, 'character_not_found', `没有 id=${id} 的角色`);
  const file = path.join(ASSETS, ART_KINDS[size], `${slug(row.name)}.webp`);
  if ((size === 'icon' ? row.has_icon : row.has_full_art) && fs.existsSync(file)) {
    return sendBuffer(res, fs.readFileSync(file), 'image/webp', 200, 86400);
  }
  const svg = Buffer.from(placeholderSvg(row.name, row.region, row.element), 'utf8');
  res.setHeader('X-Placeholder', '1');
  // 占位图不缓存：补跑 build-assets.py 之后刷新即可看到真图，不会被 5 分钟缓存挡住。
  return sendBuffer(res, svg, 'image/svg+xml; charset=utf-8', 200, 0);
}

// ---------------------------------------------------------------- HTTP

/** 回环地址上的本地工具：放开跨域，方便本机其它前端 / webview 直连。 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept,Authorization,X-Requested-With,X-KB-Session');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Expose-Headers', 'X-KB-Write,X-KB-Workspace,Content-Length');
  res.setHeader('X-KB-Write', WRITE_ENABLED ? 'enabled' : 'readonly');
  res.setHeader('X-KB-Workspace', 'kb-workspace.sqlite');
}

function sendBuffer(res, buf, type, status = 200, maxAge = 0) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  });
  res.end(buf);
}

function sendJson(res, payload, status = 200) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  sendJson(res, {
    error: {
      code: err instanceof HttpError ? err.code : 'internal_error',
      message: err.message || '服务器内部错误',
      status,
    },
  }, status);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, baseDir, relPath, maxAge = 0) {
  const clean = path.normalize(relPath).replace(/^([/\\])+/, '');
  const abs = path.join(baseDir, clean);
  if (!abs.startsWith(baseDir)) throw new HttpError(403, 'forbidden', '路径越界');
  let target = abs;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target)) throw new HttpError(404, 'not_found', `找不到 ${relPath}`);
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  sendBuffer(res, fs.readFileSync(target), type, 200, maxAge);
}

// ---------------------------------------------------------------- 对话接口

function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', `请求体超过 ${Math.round(limit / 1024)} KB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'bad_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(new HttpError(400, 'bad_request', err.message)));
  });
}

async function chatStatusPayload() {
  const cfg = loadConfig(CHAT_DIR);
  const resolved = await resolveProvider(cfg);
  return {
    provider: resolved.provider,
    model: resolved.model || null,
    reason: resolved.reason,
    baseUrl: cfg.baseUrl,
    models: resolved.models || [],
    maxTokens: cfg.maxTokens,
    thinking: cfg.thinking || null,
    deepThinkDefault: !!(cfg.thinking && cfg.thinking.type === 'enabled'),
    configFile: configPath(CHAT_DIR),
    configExists: fs.existsSync(configPath(CHAT_DIR)),
    sessions: sessionCount(),
    ready: true,
  };
}

/** POST /api/chat —— SSE 流式对话 */
async function handleChat(req, res) {
  const body = await readJsonBody(req);
  const message = String(body.message == null ? '' : body.message).trim();
  if (!message) throw new HttpError(400, 'bad_message', 'message 不能为空');
  if (message.length > 4000) throw new HttpError(400, 'message_too_long', 'message 最长 4000 字');

  const sessionId = String(body.sessionId || 'default').slice(0, 64);
  const budget = Number.isFinite(Number(body.budget)) ? Math.max(800, Number(body.budget)) : undefined;
  // 深度思考开关：true 强制开、false 强制关、不传则用 llm.config.json 的 thinking
  const think = typeof body.think === 'boolean' ? body.think : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const send = (obj) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    for await (const ev of runChat(db, CHAT_DIR, { sessionId, message, budget, think, signal: ac.signal, obcDb })) {
      if (ac.signal.aborted) break;
      send(ev);
    }
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[chat]', err);
    send({ type: 'error', message: err.message || '对话失败' });
  }
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// ---------------------------------------------------------------- 工作区 / 元数据（v1.1 放开权限）

const qident = (n) => `"${String(n).replace(/"/g, '""')}"`;

/** 给智能体看的表说明。字段名不是自解释的地方都点一句，省得它去猜。 */
const SCHEMA_NOTES = {
  characters: '角色主表（131 行，只读）。name / en_name / pinyin 都可用来定位；counts_json 是各子表条数。',
  character_forms: '旅行者的形态拆解（7 元素 × 性别）。',
  story_chapters: '角色故事 1–7 与神之眼。body 是正文，blocks 是结构化段落 JSON。',
  voice_lines: '语音台词，按 grp 分组；name 是条目标题，text 是内容。',
  dialogue_groups: '剧情台词组索引（任务类型 / 章节 / 任务标题 / 行数）。',
  dialogue_lines: '逐句台词，group_id 指向 dialogue_groups.id；speaker 是说话人。',
  preferences: '喜好与习惯（kind / label / text）。',
  relations: '角色关系边。target_id 为空表示别名没解析出来，看 target_name；quote 是原文依据。',
  books: '书籍主表（605 本）。',
  book_sections: '书籍分节正文，book_id 指向 books.id。',
  artworks: '美术记录（png_path 原始 J:\ 路径已失效，webp_path 才是可用的衍生图）。',
  search_docs: '全文检索文档流。doc_type = character | story | voice | dialogue | book，text 是原文。',
  search_fts: 'FTS5 虚拟表（unicode61 + 中文二元组）。中文检索请走 /api/search，不要直接 MATCH tokens。',
  build_state: '增量构建用的文件指纹，写它没有意义。',
  meta: '构建元信息（built_at / build_ms / stats）。',
};

const SCHEMA_HINTS = [
  '两个库：主库 data/kb.sqlite 只读（角色/书籍/关系/检索/美术，重建时会被覆盖）；侧车库 data/kb-workspace.sqlite 可写（笔记/派单/素材/标签/KV 与你自己建的表）。',
  'POST /api/query 的 mode："read"（别名 main）跑只读主库，只放行 SELECT/WITH/PRAGMA/EXPLAIN；"write"（别名 workspace）跑侧车库、任何 SQL 都行（含 SELECT 回读）。要读你写进侧车库的数据，必须用 mode:"write"。',
  '常用写入直接用 REST 更省事：/api/notes · /api/jobs · /api/assets · /api/tags · /api/tags/link · /api/kv。派单带 external_id 时按 (provider, external_id) 幂等，重试不会重复建。',
  '中文全文检索优先 /api/search（二元组 FTS，命中后服务端回原文定位高亮）；需要自己组合条件时用 SQL LIKE 或 FTS 表。',
  'SQLite 的 json_extract 可用，例如 json_extract(counts_json, "$.voices")。',
  '关系边只有 1192 条且有 42 条未解析出 target_id，做关系推演时记得回退看 target_name 原文。',
];

function schemaTables() {
  return q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .filter((r) => !/^search_fts_/.test(r.name))
    .map((r) => {
      const cols = q(`PRAGMA table_info(${qident(r.name)})`);
      let rows = null;
      try { rows = one(`SELECT COUNT(*) n FROM ${qident(r.name)}`).n; } catch { /* 虚拟表可能不支持 */ }
      return {
        name: r.name,
        type: r.type,
        rows,
        note: SCHEMA_NOTES[r.name] || null,
        columns: cols.map((c) => ({ name: c.name, type: c.type || null, pk: !!c.pk, notnull: !!c.notnull })),
      };
    });
}

function schemaTable(name) {
  const row = one("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name = ?", name);
  if (!row) return null;
  const cols = q(`PRAGMA table_info(${qident(row.name)})`);
  const indexes = q(`PRAGMA index_list(${qident(row.name)})`).map((i) => ({
    name: i.name,
    unique: !!i.unique,
    columns: q(`PRAGMA index_info(${qident(i.name)})`).map((c) => c.name),
  }));
  let rows = null;
  let sample = [];
  try {
    rows = one(`SELECT COUNT(*) n FROM ${qident(row.name)}`).n;
    sample = q(`SELECT * FROM ${qident(row.name)} LIMIT 3`).map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        const s = v === null || v === undefined ? null : String(v);
        out[k] = s && s.length > 300 ? `${s.slice(0, 300)}…(${s.length} 字)` : s;
      }
      return out;
    });
  } catch { /* 虚拟表跳过采样 */ }
  return {
    name: row.name,
    type: row.type,
    rows,
    note: SCHEMA_NOTES[row.name] || null,
    columns: cols.map((c) => ({ name: c.name, type: c.type || null, pk: !!c.pk, notnull: !!c.notnull, dflt: c.dflt_value ?? null })),
    indexes,
    sample,
  };
}

/** 写操作统一的门禁：KB_WRITE=0 时全部拒绝。 */
function requireWrite(req) {
  if (!WRITE_ENABLED) {
    throw new HttpError(403, 'write_disabled', '写入已通过 KB_WRITE=0 关闭；去掉该环境变量重启服务即可恢复');
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', '该接口需要 POST / PUT / PATCH / DELETE');
  }
}

const noteId = (seg) => {
  const id = Number.parseInt(seg[1], 10);
  if (!Number.isFinite(id)) throw new HttpError(400, 'bad_id', 'id 必须是整数');
  return id;
};

/** 交给工作区处理器的 API 前缀（v1.1 读写放开）。 */
const WORKSPACE_HEADS = new Set(['schema', 'query', 'workspace', 'notes', 'jobs', 'assets', 'tags', 'kv']);

async function handleWorkspace(req, res, url, seg, sp) {
  const head = seg[0];
  const method = req.method;
  const isRead = method === 'GET' || method === 'HEAD';

  // ---- 元数据 / 结构 -------------------------------------------------
  if (head === 'schema') {
    if (seg.length === 1) return sendJson(res, { database: DB_PATH, tables: schemaTables(), hints: SCHEMA_HINTS });
    const t = schemaTable(seg[1]);
    if (!t) throw new HttpError(404, 'table_not_found', `没有表 ${seg[1]}`);
    return sendJson(res, t);
  }

  // ---- 任意 SQL ------------------------------------------------------
  if (head === 'query') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '查询请用 POST /api/query');
    const body = await readJsonBody(req, 1024 * 1024);
    // read / main → 主库 kb.sqlite（只读，图书馆数据）
    // write / workspace → 侧车库 kb-workspace.sqlite（任意 SQL，包括 SELECT 回读）
    let mode = String(body.mode || 'read').toLowerCase();
    if (mode === 'main' || mode === 'library') mode = 'read';
    if (mode === 'ws' || mode === 'sidecar') mode = 'write';
    if (mode !== 'read' && mode !== 'write') {
      throw new HttpError(400, 'bad_mode', 'mode 只能是 read|main（主库只读）或 write|workspace（侧车库可写）');
    }
    if (mode === 'write') requireWrite(req);
    const target = mode === 'write'
      ? { db: 'workspace', file: 'data/kb-workspace.sqlite', readonly: false }
      : { db: 'main', file: 'data/kb.sqlite', readonly: true };
    try {
      const out = mode === 'write'
        ? ws.exec(body.sql, { params: body.params, maxRows: body.maxRows })
        : runReadQuery(db, body.sql, { params: body.params, maxRows: body.maxRows });
      return sendJson(res, { ok: true, mode, target, sql: String(body.sql || '').trim(), ...out });
    } catch (err) {
      let msg = err.message || 'SQL 执行失败';
      if (mode === 'read') {
        msg += '（mode:"read" 跑的是只读主库 kb.sqlite，只有角色/书籍/关系等图书馆数据；'
          + '要读工作区里的 notes/jobs/assets/tags/kv 或你自己建的表，请改用 mode:"write" 或对应 REST 接口）';
      }
      throw new HttpError(400, 'bad_query', msg);
    }
  }

  // ---- 工作区概览 ----------------------------------------------------
  if (head === 'workspace' && seg.length === 1) {
    // 注意 spread 顺序：ws.summary() 里也有一个 writable 字段（恒为 true），
    // 必须放在前面，否则会把 KB_WRITE=0 的真实状态盖掉。
    return sendJson(res, { ...ws.summary(), ok: true, writable: WRITE_ENABLED, database: DB_PATH });
  }

  // ---- 笔记 ----------------------------------------------------------
  if (head === 'notes') {
    if (seg.length === 1) {
      if (isRead) {
        const out = ws.listNotes({
          q: (sp.get('q') || '').trim(),
          kind: sp.get('kind') || undefined,
          scope: sp.get('scope') || undefined,
          targetType: sp.get('targetType') || sp.get('target_type') || undefined,
          targetId: sp.get('targetId') || sp.get('target_id') || undefined,
          tag: sp.get('tag') || undefined,
          limit: intParam(sp, 'limit', 50, 1, 500),
          offset: intParam(sp, 'offset', 0, 0, 1e9),
        });
        return sendJson(res, { ...out, limit: intParam(sp, 'limit', 50, 1, 500) });
      }
      requireWrite(req);
      const note = ws.createNote(await readJsonBody(req));
      return sendJson(res, { ok: true, note }, 201);
    }
    const id = noteId(seg);
    if (isRead) {
      const note = ws.getNote(id);
      if (!note) throw new HttpError(404, 'note_not_found', `没有 id=${id} 的笔记`);
      return sendJson(res, { note });
    }
    if (method === 'DELETE') {
      requireWrite(req);
      return sendJson(res, { ok: true, deleted: ws.deleteNote(id) });
    }
    requireWrite(req);
    const note = ws.updateNote(id, await readJsonBody(req));
    if (!note) throw new HttpError(404, 'note_not_found', `没有 id=${id} 的笔记`);
    return sendJson(res, { ok: true, note });
  }

  // ---- 派单 ----------------------------------------------------------
  if (head === 'jobs') {
    if (seg.length === 1) {
      if (isRead) {
        const out = ws.listJobs({
          q: (sp.get('q') || '').trim(),
          status: sp.get('status') || undefined,
          kind: sp.get('kind') || undefined,
          provider: sp.get('provider') || undefined,
          characterId: sp.get('characterId') || sp.get('character_id') || undefined,
          limit: intParam(sp, 'limit', 50, 1, 500),
          offset: intParam(sp, 'offset', 0, 0, 1e9),
        });
        return sendJson(res, { ...out, limit: intParam(sp, 'limit', 50, 1, 500) });
      }
      requireWrite(req);
      const job = ws.createJob(await readJsonBody(req));
      return sendJson(res, { ok: true, job }, 201);
    }
    const id = noteId(seg);
    if (isRead) {
      const job = ws.getJob(id);
      if (!job) throw new HttpError(404, 'job_not_found', `没有 id=${id} 的派单`);
      return sendJson(res, { job });
    }
    if (method === 'DELETE') {
      requireWrite(req);
      return sendJson(res, { ok: true, deleted: ws.deleteJob(id) });
    }
    requireWrite(req);
    const job = ws.updateJob(id, await readJsonBody(req));
    if (!job) throw new HttpError(404, 'job_not_found', `没有 id=${id} 的派单`);
    return sendJson(res, { ok: true, job });
  }

  // ---- 素材 ----------------------------------------------------------
  if (head === 'assets') {
    if (seg.length === 1) {
      if (isRead) {
        return sendJson(res, ws.listAssets({
          jobId: sp.get('jobId') || sp.get('job_id') || undefined,
          characterId: sp.get('characterId') || sp.get('character_id') || undefined,
          kind: sp.get('kind') || undefined,
          limit: intParam(sp, 'limit', 100, 1, 500),
          offset: intParam(sp, 'offset', 0, 0, 1e9),
        }));
      }
      requireWrite(req);
      const asset = ws.addAsset(await readJsonBody(req));
      return sendJson(res, { ok: true, asset }, 201);
    }
    const id = noteId(seg);
    if (method === 'DELETE') {
      requireWrite(req);
      return sendJson(res, { ok: true, deleted: ws.deleteAsset(id) });
    }
    throw new HttpError(405, 'method_not_allowed', '素材接口：GET /api/assets · POST /api/assets · DELETE /api/assets/:id');
  }

  // ---- 标签 ----------------------------------------------------------
  if (head === 'tags') {
    if (seg.length === 1) {
      if (isRead) return sendJson(res, { tags: ws.listTags() });
      requireWrite(req);
      return sendJson(res, { ok: true, tag: ws.upsertTag(await readJsonBody(req)) }, 201);
    }
    if (seg[1] === 'link') {
      if (seg.length === 2) {
        requireWrite(req);
        return sendJson(res, { ok: true, ...ws.linkTag(await readJsonBody(req)) }, 201);
      }
      if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', '解绑请用 DELETE /api/tags/link/:id');
      requireWrite(req);
      const lid = Number.parseInt(seg[2], 10);
      if (!Number.isFinite(lid)) throw new HttpError(400, 'bad_id', '绑定的 link id 必须是整数（DELETE /api/tags/link/:id）');
      return sendJson(res, { ok: true, deleted: ws.unlinkTag(lid) });
    }
    if (isRead && seg.length === 3) return sendJson(res, { tags: ws.tagsFor(seg[1], seg[2]) });
  }

  // ---- KV ------------------------------------------------------------
  if (head === 'kv') {
    if (isRead) {
      if (seg.length === 1) return sendJson(res, { items: ws.listKv() });
      const item = ws.getKv(seg[1]);
      if (!item) throw new HttpError(404, 'kv_not_found', `没有 key=${seg[1]}`);
      return sendJson(res, { item });
    }
    requireWrite(req);
    if (seg.length < 2) throw new HttpError(400, 'bad_key', '请用 PUT /api/kv/:key');
    if (method === 'DELETE') return sendJson(res, { ok: true, deleted: ws.deleteKv(seg[1]) });
    const body = await readJsonBody(req);
    const value = body && typeof body === 'object' && 'value' in body ? body.value : body;
    return sendJson(res, { ok: true, item: ws.setKv(seg[1], value) }, 201);
  }

  throw new HttpError(404, 'unknown_endpoint', `没有这个接口：/api/${seg.join('/')}`);
}

async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const head = seg[0] || '';
  const sp = url.searchParams;

  // v1.1：放开只读。这些前缀走「工作区」处理器（主库只读查询 + 侧车可写库 CRUD）。
  if (WORKSPACE_HEADS.has(head)) return handleWorkspace(req, res, url, seg, sp);

  if (head === 'health' && seg.length === 1) return sendJson(res, healthPayload());
  if (head === 'games' && seg.length === 1) return sendJson(res, { games: gamesPayload() });
  if (head === 'facets' && seg.length === 1) {
    const g = sp.get('game') || GAME;
    if (g !== GAME) throw new HttpError(400, 'game_not_supported', `${g} 暂未收录（敬请期待）`);
    return sendJson(res, { game: GAME, facets: facetsPayload() });
  }
  if (head === 'archons' && seg.length === 1) return sendJson(res, { archons: archonsPayload() });

  if (head === 'characters' && seg.length === 1) return sendJson(res, listCharacters(sp));

  if (head === 'characters' && seg.length === 2) {
    const id = Number.parseInt(seg[1], 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'bad_id', '角色 id 必须是整数');
    return sendJson(res, characterDetail(id));
  }

  if (head === 'characters' && seg.length === 3 && seg[2] === 'relations') {
    const id = Number.parseInt(seg[1], 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'bad_id', '角色 id 必须是整数');
    const depth = intParam(sp, 'depth', 1, 1, 2);
    return sendJson(res, relationGraph(id, depth));
  }

  if (head === 'books' && seg.length === 1) return sendJson(res, listBooks(sp));
  if (head === 'books' && seg.length === 2) {
    const id = Number.parseInt(seg[1], 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'bad_id', '书籍 id 必须是整数');
    return sendJson(res, bookDetail(id));
  }

  if (head === 'dialogue' && seg.length === 2) {
    const gid = Number.parseInt(seg[1], 10);
    if (!Number.isFinite(gid)) throw new HttpError(400, 'bad_id', '剧情台词组 id 必须是整数');
    return sendJson(res, dialogueDetail(gid));
  }

  // ── 观测枢官方数据（米游社观测枢 baike.mihoyo.com，米哈游自营）──────────────
  // 数据在侧车库的 obc_entries / obc_fts，由 tools/obc-import.mjs 导入。
  // 与主库内容是分开的两套东西：主库是 ambr 文本，这里是观测枢官方图鉴。
  if (head === 'obc') {
    if (!obcDb) {
      throw new HttpError(503, 'obc_not_imported',
        '还没有导入观测枢官方数据。先跑 dsh-integrations/gen-suite 的 node tools/obc-import.mjs');
    }
    if (seg[1] === 'stats') return sendJson(res, { kinds: obcStats(obcDb), labels: OBC_KIND_LABEL });
    if (seg[1] === 'list') {
      return sendJson(res, obcList(obcDb, {
        kind: sp.get('kind') || '',
        q: sp.get('q') || '',
        page: intParam(sp, 'page', 1, 1, 10000),
        size: intParam(sp, 'size', 40, 1, 200),
      }));
    }
    if (seg[1] === 'entry') {
      const id = Number.parseInt(seg[2] || sp.get('id'), 10);
      if (!Number.isFinite(id)) throw new HttpError(400, 'bad_id', '条目 id 必须是整数');
      const e = obcEntry(obcDb, id);
      if (!e) throw new HttpError(404, 'entry_not_found', `没有 id=${id} 的观测枢条目`);
      return sendJson(res, e);
    }
    if (seg[1] === 'recommend') {
      const id = Number.parseInt(seg[2] || sp.get('id'), 10);
      if (!Number.isFinite(id)) throw new HttpError(400, 'bad_id', '条目 id 必须是整数');
      const rec = obcRecommends(obcDb, id);
      // 观测枢的 avatar_pc 其实是 1140×280 的**宽横幅**（带花纹和一个角色+随从），
      // 塞进方形框里 object-fit:cover 等于裁正中间 —— 对不准脸。
      // 角色行改用知识库自己的 256×256 方形图标（正脸，而且本来就在用，不是新增依赖）。
      const localIcon = (name, kind) => {
        if (!name || kind !== 'character') return null;
        const c = one('SELECT id FROM characters WHERE name = ?', name);
        return c ? `/api/art/${c.id}?size=icon` : null;
      };
      for (const r of rec.asSource) r.target_local = localIcon(r.target_name, r.target_kind);
      for (const r of rec.asTarget) r.src_local = localIcon(r.src_name, r.src_kind);
      return sendJson(res, { id, ...rec });
    }
    throw new HttpError(404, 'not_found', '未知的 obc 接口（stats / list / entry / recommend）');
  }

  if (head === 'search' && seg.length === 1) {
    const query = (sp.get('q') || '').trim();
    const type = sp.get('type') || 'all';
    if (!SEARCH_TYPES.has(type)) throw new HttpError(400, 'bad_type', `type 必须是 ${[...SEARCH_TYPES].join(' | ')}`);
    const limit = intParam(sp, 'limit', 20, 1, 100);
    if (!query) return sendJson(res, { query: '', groups: { character: [], story: [], voice: [], dialogue: [], book: [] }, total: 0 });
    return sendJson(res, doSearch(query, type, limit));
  }

  if (head === 'art' && seg.length === 2) {
    const id = Number.parseInt(seg[1], 10);
    if (!Number.isFinite(id)) throw new HttpError(400, 'bad_id', '角色 id 必须是整数');
    return serveArt(res, id, sp.get('size') || 'display');
  }

  if (head === 'chat' && seg.length === 2 && seg[1] === 'status') {
    return sendJson(res, await chatStatusPayload());
  }
  if (head === 'chat' && seg.length === 1 && req.method === 'POST') {
    return handleChat(req, res);
  }
  if (head === 'chat' && seg.length === 2 && seg[1] === 'reset') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '重置会话请用 POST');
    const body = await readJsonBody(req);
    resetSession(body.sessionId || 'default');
    return sendJson(res, { ok: true, sessions: sessionCount() });
  }

  throw new HttpError(404, 'unknown_endpoint', `没有这个接口：/api/${seg.join('/')}`);
}

// 角色语音音频已从知识库剥离（数据来源合规要求）：知识库不再依赖、
// 也不再知晓语音服务的存在。语音试听改由 gen-suite 的「注入式代理」在页面层提供，
// 本仓库保持纯文本知识库。详见 dsh-integrations/README.md 的语音章节。

const server = http.createServer(async (req, res) => {
  const configuredToken = process.env.KB_CLIENT_TOKEN || '';
  if (!configuredToken || req.headers.authorization !== 'Bearer ' + configuredToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'unauthorized', message: '请配置并提供 KB_CLIENT_TOKEN。' } }));
  }
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    return sendError(res, new HttpError(400, 'bad_url', '无法解析请求地址'));
  }

  // 本地工具不再把请求锁死在 GET 上：MCP / DSH / 脚本 / 浏览器页面都可以直接调。
  // 服务仍只监听回环地址，跨域头只是为了本机其它前端（5173、webview 等）能直连。
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
  if (!ALLOWED_METHODS.has(req.method)) {
    return sendError(res, new HttpError(405, 'method_not_allowed', `不支持 ${req.method}`));
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/assets/')) {
      return serveStatic(res, ASSETS, url.pathname.replace(/^\/assets\//, ''), 86400);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, new HttpError(405, 'method_not_allowed', '静态资源只支持 GET'));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveStatic(res, WEB, 'index.html');
    }
    // 前端静态资源不设强缓存：这是本地工具，改完 web/app.js 直接刷新即可生效，
    // 不会被浏览器 1 小时缓存挡住（回环地址上重新取一次 48 KB 的开销可以忽略）。
    return serveStatic(res, WEB, url.pathname, 0);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[error]', url.pathname, err);
    return sendError(res, err);
  }
});

process.on('SIGINT', () => {
  try { db.close(); } catch {}
  try { ws.close(); } catch {}
  console.log('\n已停止');
  process.exit(0);
});

server.listen(PORT, HOST, () => {
  const h = healthPayload();
  console.log(`原神可视化知识库  ->  http://${HOST}:${PORT}`);
  console.log(`  角色 ${h.db.characters} · 书籍 ${h.db.books} · 关系 ${h.db.relations} · 检索文档 ${h.db.searchDocs}`);
  console.log(`  构建时间 ${h.builtAt}  （Ctrl+C 停止）`);
  if (process.env.KB_OPEN === '1') {
    // 由 启动知识库.cmd 设置：服务起来后自动用默认浏览器打开首页
    try {
      spawn('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}`], {
        stdio: 'ignore', detached: true, windowsHide: true,
      }).unref();
    } catch { /* 打不开浏览器不影响服务 */ }
  }
});
