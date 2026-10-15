#!/usr/bin/env node
// 原神可视化知识库构建器。
//
// 输入（只读）：KB_SOURCE_DIR 下的 Markdown 与可选图像。版权数据不随代码分发。
// 输出：data\kb.sqlite、data\asset-jobs.json
//
// 用法：
//   node build.mjs               全量重建
//   node build.mjs --incremental 仅重解析 mtime/size 变化的 md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { indexTokens } from './lib/tokenize.mjs';
import {
  parseHeadings, sectionLines, findH2, childrenOf, toBlocks,
  blocksToPlain, tableFromLines, rarityOf, inlineToPlain,
} from './lib/mdparse.mjs';
import { GAMES, REGIONS, DEFAULT_REGION, ALIASES } from './lib/domain.mjs';
import { EN_NAMES, pinyinOf, pinyinSpaced, searchKeys, missingChars } from './lib/names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB = process.env.KB_SOURCE_DIR || path.resolve(process.env.AKASHA_ROOT || path.join(HERE, '..'), 'data-src');
const SRC_CHARS = path.join(KB, '原神');
const SRC_BOOKS = path.join(KB, '原神', '书籍');
const ART = path.join(KB, '立绘', '原神');
const DATA = process.env.KB_DATA_DIR || path.join(HERE, 'data');
if (!fs.existsSync(SRC_CHARS)) { console.error('未配置 Markdown 语料，请设置 KB_SOURCE_DIR。'); process.exit(2); }
const DB_PATH = path.join(DATA, 'kb.sqlite');
const JOBS_PATH = path.join(DATA, 'asset-jobs.json');

const INCREMENTAL = process.argv.includes('--incremental');
const GAME_SLUG = 'genshin';

// ---------------------------------------------------------------- 小工具

function normRegion(v) {
  if (!v) return null;
  const t = String(v).replace(/[（(].*?[）)]/g, '').replace(/[—\-–—]+/g, '').trim();
  if (!t) return null;
  return t;
}

function normDash(v) {
  if (v == null) return null;
  const t = String(v).replace(/[\u2014\u2015\u2013-]/g, '').trim();
  return t ? String(v).trim() : null;
}

function url(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function charNameFromFile(file) {
  return path.basename(file, '.md').replace(/^【原神】/, '');
}

function bookTitleFromFile(file) {
  // 文件名形如 《书名》.md，只剥掉最外层一对书名号
  return path.basename(file, '.md').replace(/^《/, '').replace(/》$/, '').trim();
}

// ---------------------------------------------------------------- 解析：角色

function parseCharacter(file) {
  const name = charNameFromFile(file);
  const stat = fs.statSync(file);
  const md = fs.readFileSync(file, 'utf8');
  const { lines, nodes } = parseHeadings(md);

  const out = {
    name, sourcePath: file, bytes: stat.size, mtimeMs: stat.mtimeMs,
    fields: {}, forms: [], bio: null, persona: null, note: null,
    stories: [], voices: [], relations: [], dialogueGroups: [], preferences: [],
    preamble: '',
    // 文档头里的观测枢词条 id —— 用来给每条资料回链官方原文。
    // 不解析它就只剩「来源：米游社观测枢」这行字，用户点不回去，
    // 形态上就成了只吸收不送回（见 lib/obc.mjs 顶部关于回链的说明）。
    obcId: null,
  };

  // 观测枢词条 id：文档头写的是「> **数据来源**：米游社观测枢（…）。观测枢词条 id 1627。」
  const obcMatch = /观测枢词条\s*id\s*(\d+)/.exec(md);
  if (obcMatch) out.obcId = Number(obcMatch[1]);

  const firstH2 = nodes.findIndex((n) => n.level === 2);
  if (firstH2 > 0) out.preamble = inlineToPlain(lines.slice(1, nodes[firstH2].line).join('\n'));

  // ---- 基础档案
  const iArch = findH2(nodes, '基础档案');
  if (iArch >= 0) {
    const sec = sectionLines(lines, nodes, iArch);
    const rows = tableFromLines(sec);
    // 「基础档案」小节里可能出现两张表：主档案表（首行 `| 字段 | 内容 |`）
    // 和「形态一览」表（首行 `| 形态 | 元素 | 武器 | 稀有度 | 实装日期 |`，仅旅行者）。
    // 表格行被 flatten 成一维数组，所以靠表头识别切换模式，切换后不再写入 fields。
    let inForms = false;
    for (const r of rows) {
      if (r.length < 2) continue;
      if (r[0] === '字段') continue;                    // 主表表头
      if (r[0] === '形态' && r[1] === '元素') { inForms = true; continue; } // 形态表表头
      if (inForms) {
        if (r.length < 5) continue;
        out.forms.push({ label: r[0], element: r[1], weapon: r[2], rarity: rarityOf(r[3]), release: r[4] });
        continue;
      }
      out.fields[r[0]] = r[1];
    }
    const personaLine = sec.find((l) => l.startsWith('**性格标签'));
    if (personaLine) {
      const v = personaLine.split('：').slice(1).join('：').trim();
      if (v && v !== '—') out.persona = v;
    }
    const bioIdx = sec.findIndex((l) => l.startsWith('**关键背景简述'));
    if (bioIdx >= 0) {
      const quoted = sec.slice(bioIdx + 1).filter((l) => l.trim().startsWith('>'));
      if (quoted.length) out.bio = inlineToPlain(quoted.map((l) => l.replace(/^>\s?/, '')).join('\n'));
    }
  }
  out.note = out.fields['备注'] || null;

  // ---- 角色故事
  const iStory = findH2(nodes, '角色故事');
  if (iStory >= 0) {
    for (const k of childrenOf(nodes, iStory, 4)) {
      const body = sectionLines(lines, nodes, k);
      const blocks = toBlocks(body.join('\n'));
      const plain = blocksToPlain(blocks);
      if (!plain) continue;
      out.stories.push({ title: nodes[k].title, blocks, plain });
    }
  }

  // ---- 角色语音 / 关于其他角色
  const iVoice = findH2(nodes, '角色语音');
  if (iVoice >= 0) {
    for (const h3 of childrenOf(nodes, iVoice, 3)) {
      const group = nodes[h3].title;
      for (const h4 of childrenOf(nodes, h3, 4)) {
        const body = sectionLines(lines, nodes, h4);
        const plain = blocksToPlain(toBlocks(body.join('\n')));
        const title = nodes[h4].title;
        if (group.startsWith('关于其他角色')) {
          out.relations.push({ raw: title, quote: plain });
        } else if (plain) {
          out.voices.push({ group, name: title, text: plain });
        }
      }
    }
  }

  // ---- 经典剧情台词
  const iDlg = findH2(nodes, '经典剧情台词');
  if (iDlg >= 0) {
    for (const h3 of childrenOf(nodes, iDlg, 3)) {
      const chapter = nodes[h3].title;
      const questType = chapter.split('·')[0].trim();
      const chapterBody = sectionLines(lines, nodes, h3);
      const chapterId = (chapterBody.find((l) => l.includes('章节ID')) || '').replace(/[^\d]/g, '') || null;
      for (const h4 of childrenOf(nodes, h3, 4)) {
        const title = nodes[h4].title;
        const qid = /任务ID[:：]\s*(\d+)/.exec(title);
        const questTitle = title.replace(/（任务ID[:：]\s*\d+）/, '').trim();
        const body = sectionLines(lines, nodes, h4);
        const items = [];
        let heading = null;
        let ord = 0;
        for (const raw of body) {
          const line = raw.trim();
          if (!line) continue;
          const h = /^\*\*(.+?)\*\*$/.exec(line);
          if (h) { heading = h[1]; continue; }
          const li = /^[-*]\s+(.*)$/.exec(line);
          const text = inlineToPlain(li ? li[1] : line);
          if (!text) continue;
          let speaker = null;
          const m = /^(.{1,12}?)[：:]\s*(.*)$/.exec(text);
          if (m && !/^https?$/.test(m[1])) { speaker = m[1]; items.push({ heading, ord: ord++, speaker, text: m[2].trim() }); }
          else items.push({ heading, ord: ord++, speaker: null, text });
        }
        if (!items.length) continue;
        out.dialogueGroups.push({
          questType, chapter, chapterId, questTitle, questId: qid ? qid[1] : null, items,
        });
      }
    }
  }

  // ---- 好恶与行为习惯
  const iPref = findH2(nodes, '好恶与行为习惯');
  if (iPref >= 0) {
    for (const h3 of childrenOf(nodes, iPref, 3)) {
      const kind = nodes[h3].title;
      for (const raw of sectionLines(lines, nodes, h3)) {
        const li = /^[-*]\s+\*\*(.+?)\*\*[：:]\s*(.*)$/.exec(raw.trim());
        if (li) out.preferences.push({ kind, label: inlineToPlain(li[1]), text: inlineToPlain(li[2]) });
        else {
          const li2 = /^[-*]\s+(.*)$/.exec(raw.trim());
          if (li2) out.preferences.push({ kind, label: null, text: inlineToPlain(li2[1]) });
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------- 解析：书籍

function parseBook(file) {
  const title = bookTitleFromFile(file);
  const stat = fs.statSync(file);
  const md = fs.readFileSync(file, 'utf8');
  const { lines, nodes } = parseHeadings(md);
  const sections = [];
  let whole = '';
  const h2s = nodes.map((n, i) => (n.level === 2 ? i : -1)).filter((i) => i >= 0);
  if (h2s.length) {
    for (const i of h2s) {
      const body = sectionLines(lines, nodes, i);
      const blocks = toBlocks(body.join('\n'));
      const plain = blocksToPlain(blocks);
      if (!plain) continue;
      sections.push({ title: nodes[i].title, blocks, plain });
    }
  } else {
    const blocks = toBlocks(lines.join('\n'));
    const plain = blocksToPlain(blocks);
    if (plain) sections.push({ title, blocks, plain });
  }
  whole = sections.map((s) => s.plain).join('\n');
  return { title, sourcePath: file, bytes: stat.size, mtimeMs: stat.mtimeMs, sections, charCount: whole.length };
}

// ---------------------------------------------------------------- 关系解析

function buildResolver(names) {
  const exact = new Set(names);
  const alias = new Map();
  for (const [k, v] of Object.entries(ALIASES)) {
    if (!exact.has(v)) continue;          // 别名指向的角色必须真的存在
    if (exact.has(k)) continue;           // 本身就是正式名的，不需要别名
    alias.set(k, v);
  }
  const byLen = [...exact].sort((a, b) => b.length - a.length);
  const SUFFIX = ['先生', '大人', '小姐', '姐姐', '哥哥', '团长', '老师', '殿下', '阁下'];
  return function resolve(raw) {
    let t = String(raw || '').replace(/^关于/, '').trim();
    t = t.replace(/[「」『』【】《》""'']/g, '').trim();
    t = t.replace(/[（(].*?[）)]/g, '').trim();
    t = t.split('·')[0].split(/…|\.\.\./)[0].trim();
    if (!t) return { id: null, raw: t };
    const direct = [t];
    for (const s of SUFFIX) if (t.endsWith(s) && t.length > s.length) direct.push(t.slice(0, -s.length));
    for (const c of direct) {
      if (exact.has(c)) return { id: c, raw: t };
      if (alias.has(c)) return { id: alias.get(c), raw: t };
    }
    for (const c of byLen) if (c.length >= 2 && t.includes(c)) return { id: c, raw: t };
    return { id: null, raw: t };
  };
}

// ---------------------------------------------------------------- 数据库

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  sort INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL, name TEXT NOT NULL,
  title TEXT, identity TEXT, faction TEXT, region TEXT, constellation TEXT,
  element TEXT, weapon TEXT, rarity INTEGER, birthday TEXT, cv_cn TEXT,
  release_date TEXT, note TEXT, persona TEXT, bio TEXT, preamble TEXT,
  role TEXT, obc_id INTEGER,
  region_color TEXT, region_archon TEXT, art_backdrop TEXT,
  source_path TEXT, bytes INTEGER, mtime_ms REAL,
  has_full_art INTEGER DEFAULT 0, has_icon INTEGER DEFAULT 0,
  thumb_url TEXT, display_url TEXT, icon_url TEXT,
  counts_json TEXT,
  UNIQUE (game_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ch_region ON characters(game_id, region);
CREATE INDEX IF NOT EXISTS idx_ch_element ON characters(element);
CREATE INDEX IF NOT EXISTS idx_ch_weapon ON characters(weapon);
CREATE INDEX IF NOT EXISTS idx_ch_rarity ON characters(rarity);
CREATE INDEX IF NOT EXISTS idx_ch_faction ON characters(faction);

CREATE TABLE IF NOT EXISTS character_forms (
  id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, label TEXT,
  element TEXT, weapon TEXT, rarity INTEGER, release_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_form_ch ON character_forms(character_id);

CREATE TABLE IF NOT EXISTS story_chapters (
  id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, ord INTEGER,
  title TEXT NOT NULL, blocks TEXT, body TEXT
);
CREATE INDEX IF NOT EXISTS idx_story_ch ON story_chapters(character_id);

CREATE TABLE IF NOT EXISTS voice_lines (
  id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, grp TEXT, ord INTEGER,
  name TEXT NOT NULL, text TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_ch ON voice_lines(character_id);

CREATE TABLE IF NOT EXISTS dialogue_groups (
  id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, ord INTEGER,
  quest_type TEXT, chapter TEXT, chapter_id TEXT, quest_title TEXT, quest_id TEXT,
  line_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dlg_ch ON dialogue_groups(character_id);

CREATE TABLE IF NOT EXISTS dialogue_lines (
  id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, ord INTEGER,
  heading TEXT, speaker TEXT, text TEXT
);
CREATE INDEX IF NOT EXISTS idx_dlgline_grp ON dialogue_lines(group_id);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, kind TEXT,
  label TEXT, text TEXT, ord INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pref_ch ON preferences(character_id);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY, game_id INTEGER, src_id INTEGER NOT NULL,
  target_id INTEGER, target_name TEXT, quote TEXT
);
CREATE INDEX IF NOT EXISTS idx_rel_src ON relations(src_id);
CREATE INDEX IF NOT EXISTS idx_rel_tgt ON relations(target_id);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL, title TEXT NOT NULL,
  slug TEXT, source_path TEXT, volume_count INTEGER, char_count INTEGER,
  bytes INTEGER, mtime_ms REAL,
  UNIQUE (game_id, title)
);

CREATE TABLE IF NOT EXISTS book_sections (
  id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, ord INTEGER,
  title TEXT, blocks TEXT, body TEXT
);
CREATE INDEX IF NOT EXISTS idx_bsec_book ON book_sections(book_id);

CREATE TABLE IF NOT EXISTS artworks (
  id INTEGER PRIMARY KEY, game_id INTEGER, character_id INTEGER,
  kind TEXT NOT NULL, name TEXT, png_path TEXT, webp_path TEXT,
  width INTEGER, height INTEGER, bytes INTEGER, source_url TEXT,
  path_fixed INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_art_ch ON artworks(character_id);

CREATE TABLE IF NOT EXISTS search_docs (
  id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, game_id INTEGER,
  owner_id INTEGER, owner_name TEXT, heading TEXT, ord INTEGER,
  text TEXT, extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sd_owner ON search_docs(doc_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_sd_type ON search_docs(doc_type);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(tokens, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS build_state (
  path TEXT PRIMARY KEY, kind TEXT, mtime_ms REAL, size INTEGER
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function openDb() {
  fs.mkdirSync(DATA, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SCHEMA);
  // 迁移：老库补列（保留既有数据，避免 --incremental 时炸掉）
  //   role   —— 观测枢角色页的「定位」，原先整列数据被丢弃
  //   obc_id —— 观测枢词条 id，用于把每条资料回链官方原文
  for (const [col, type] of [['en_name', 'TEXT'], ['pinyin', 'TEXT'], ['pinyin_spaced', 'TEXT'],
                             ['role', 'TEXT'], ['obc_id', 'INTEGER']]) {
    try { db.exec(`ALTER TABLE characters ADD COLUMN ${col} ${type}`); } catch { /* 已存在 */ }
  }
  return db;
}

function seedGames(db) {
  const st = db.prepare('INSERT INTO games(slug,name,sort,enabled) VALUES(?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name, sort=excluded.sort, enabled=excluded.enabled');
  for (const g of GAMES) st.run(g.slug, g.name, g.sort, g.enabled);
}

const gameId = (db, slug) => db.prepare('SELECT id FROM games WHERE slug=?').get(slug).id;

// ---------------------------------------------------------------- 落库

function insertSearchDoc(db, doc) {
  const info = db
    .prepare('INSERT INTO search_docs(doc_type,game_id,owner_id,owner_name,heading,ord,text,extra_json) VALUES(?,?,?,?,?,?,?,?)')
    .run(doc.type, doc.gameId, doc.ownerId, doc.ownerName, doc.heading ?? null, doc.ord ?? 0, doc.text, doc.extra ? JSON.stringify(doc.extra) : null);
  const id = info.lastInsertRowid;
  db.prepare('INSERT INTO search_fts(rowid,tokens) VALUES(?,?)').run(id, indexTokens(`${doc.heading || ''} ${doc.text}`));
  return id;
}

function deleteOwner(db, docType, ownerId) {
  const rows = db.prepare('SELECT id FROM search_docs WHERE doc_type=? AND owner_id=?').all(docType, ownerId);
  const del = db.prepare('DELETE FROM search_fts WHERE rowid=?');
  for (const r of rows) del.run(r.id);
  db.prepare('DELETE FROM search_docs WHERE doc_type=? AND owner_id=?').run(docType, ownerId);
}

function writeCharacter(db, gid, rec, resolve, nameToId) {
  const f = rec.fields;
  const region = normRegion(f['所属地区']);
  const theme = REGIONS[region] || DEFAULT_REGION;
  const rarity = rarityOf(f['稀有度']);
  const fullPng = path.join(ART, `${rec.name}.png`);
  const iconPng = path.join(ART, 'icon', `${rec.name}.png`);
  const hasFull = fs.existsSync(fullPng) ? 1 : 0;
  const hasIcon = fs.existsSync(iconPng) ? 1 : 0;
  const slugName = url(rec.name);
  const counts = {
    stories: rec.stories.length,
    voices: rec.voices.length,
    relations: rec.relations.length,
    dialogueGroups: rec.dialogueGroups.length,
    dialogueLines: rec.dialogueGroups.reduce((a, g) => a + g.items.length, 0),
    preferences: rec.preferences.length,
  };

  db.prepare(`INSERT INTO characters(game_id,name,title,identity,faction,region,constellation,element,weapon,rarity,
        birthday,cv_cn,release_date,note,persona,bio,preamble,role,obc_id,region_color,region_archon,art_backdrop,
        source_path,bytes,mtime_ms,has_full_art,has_icon,thumb_url,display_url,icon_url,counts_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(game_id,name) DO UPDATE SET
        title=excluded.title, identity=excluded.identity, faction=excluded.faction, region=excluded.region,
        constellation=excluded.constellation, element=excluded.element, weapon=excluded.weapon, rarity=excluded.rarity,
        birthday=excluded.birthday, cv_cn=excluded.cv_cn, release_date=excluded.release_date, note=excluded.note,
        persona=excluded.persona, bio=excluded.bio, preamble=excluded.preamble,
        role=excluded.role, obc_id=excluded.obc_id, region_color=excluded.region_color,
        region_archon=excluded.region_archon, art_backdrop=excluded.art_backdrop, source_path=excluded.source_path,
        bytes=excluded.bytes, mtime_ms=excluded.mtime_ms, has_full_art=excluded.has_full_art, has_icon=excluded.has_icon,
        thumb_url=excluded.thumb_url, display_url=excluded.display_url, icon_url=excluded.icon_url,
        counts_json=excluded.counts_json`)
    .run(
      gid, rec.name, normDash(f['称号']), normDash(f['身份']), normDash(f['所属势力']), region,
      normDash(f['命之座']), normDash(f['元素']), normDash(f['武器']), rarity,
      normDash(f['生日']), normDash(f['CV（汉语）']), normDash(f['实装日期']), rec.note,
      rec.persona, rec.bio, rec.preamble,
      normDash(f['定位']), rec.obcId ?? null,
      theme.color, theme.archon, theme.archon,
      rec.sourcePath, rec.bytes, rec.mtimeMs, hasFull, hasIcon,
      hasFull ? `/assets/thumbs/${slugName}.webp` : null,
      hasFull ? `/assets/display/${slugName}.webp` : null,
      hasIcon ? `/assets/icons/${slugName}.webp` : null,
      JSON.stringify(counts),
    );
  const id = db.prepare('SELECT id FROM characters WHERE game_id=? AND name=?').get(gid, rec.name).id;
  nameToId.set(rec.name, id);

  // 拉丁 / 拼音检索键（离线补全，语料里本身没有拉丁名）
  db.prepare('UPDATE characters SET en_name=?, pinyin=?, pinyin_spaced=? WHERE id=?')
    .run(EN_NAMES[rec.name] ?? null, pinyinOf(rec.name) || null, pinyinSpaced(rec.name) || null, id);

  // 子表：先清后写
  for (const t of ['character_forms', 'story_chapters', 'voice_lines', 'preferences']) {
    db.prepare(`DELETE FROM ${t} WHERE character_id=?`).run(id);
  }
  for (const g of db.prepare('SELECT id FROM dialogue_groups WHERE character_id=?').all(id)) {
    db.prepare('DELETE FROM dialogue_lines WHERE group_id=?').run(g.id);
  }
  db.prepare('DELETE FROM dialogue_groups WHERE character_id=?').run(id);

  const formSt = db.prepare('INSERT INTO character_forms(character_id,label,element,weapon,rarity,release_date) VALUES(?,?,?,?,?,?)');
  for (const fm of rec.forms) formSt.run(id, fm.label, fm.element, fm.weapon, fm.rarity, normDash(fm.release));

  const storySt = db.prepare('INSERT INTO story_chapters(character_id,ord,title,blocks,body) VALUES(?,?,?,?,?)');
  rec.stories.forEach((s, i) => storySt.run(id, i, s.title, JSON.stringify(s.blocks), s.plain));

  const voiceSt = db.prepare('INSERT INTO voice_lines(character_id,grp,ord,name,text) VALUES(?,?,?,?,?)');
  rec.voices.forEach((v, i) => voiceSt.run(id, v.group, i, v.name, v.text));

  const prefSt = db.prepare('INSERT INTO preferences(character_id,kind,label,text,ord) VALUES(?,?,?,?,?)');
  rec.preferences.forEach((p, i) => prefSt.run(id, p.kind, p.label, p.text, i));

  const grpSt = db.prepare('INSERT INTO dialogue_groups(character_id,ord,quest_type,chapter,chapter_id,quest_title,quest_id,line_count) VALUES(?,?,?,?,?,?,?,?)');
  const lineSt = db.prepare('INSERT INTO dialogue_lines(group_id,ord,heading,speaker,text) VALUES(?,?,?,?,?)');
  rec.dialogueGroups.forEach((g, i) => {
    const gi = grpSt.run(id, i, g.questType, g.chapter, g.chapterId, g.questTitle, g.questId, g.items.length);
    const gidRow = Number(gi.lastInsertRowid);
    for (const it of g.items) lineSt.run(gidRow, it.ord, it.heading, it.speaker, it.text);
  });

  // 关系
  db.prepare('DELETE FROM relations WHERE src_id=?').run(id);
  const relSt = db.prepare('INSERT INTO relations(game_id,src_id,target_id,target_name,quote) VALUES(?,?,?,?,?)');
  for (const r of rec.relations) {
    const t = resolve(r.raw);
    const tid = t.id && t.id !== rec.name ? nameToId.get(t.id) ?? null : null;
    relSt.run(gid, id, tid, t.raw || r.raw, r.quote || '');
  }

  // 检索文档
  deleteOwner(db, 'character', id);
  const profileText = [
    rec.name, f['称号'], f['身份'], f['所属势力'], region, f['命之座'], f['元素'], f['武器'],
    f['生日'], f['CV（汉语）'], f['实装日期'], rec.persona, rec.bio, rec.note,
    searchKeys(rec.name),   // 连写拼音 / 分词拼音 / 官方英文名：支持 Venti、hu tao、hutao
  ].filter(Boolean).join('\n');
  insertSearchDoc(db, { type: 'character', gameId: gid, ownerId: id, ownerName: rec.name, heading: rec.name, text: profileText });

  deleteOwner(db, 'story', id);
  rec.stories.forEach((s, i) => insertSearchDoc(db, {
    type: 'story', gameId: gid, ownerId: id, ownerName: rec.name, heading: s.title, ord: i, text: s.plain,
    extra: { kind: 'story', index: i },
  }));

  deleteOwner(db, 'voice', id);
  rec.voices.forEach((v, i) => insertSearchDoc(db, {
    type: 'voice', gameId: gid, ownerId: id, ownerName: rec.name, heading: v.name, ord: i, text: v.text,
    extra: { kind: 'voice', group: v.group },
  }));

  deleteOwner(db, 'dialogue', id);
  rec.dialogueGroups.forEach((g, i) => insertSearchDoc(db, {
    type: 'dialogue', gameId: gid, ownerId: id, ownerName: rec.name,
    heading: `${g.questTitle}${g.chapter ? ' · ' + g.chapter : ''}`, ord: i,
    text: g.items.map((it) => `${it.heading ? it.heading + '：' : ''}${it.speaker ? it.speaker + '：' : ''}${it.text}`).join('\n'),
    extra: { kind: 'dialogue', index: i },
  }));

  return id;
}

function writeBook(db, gid, rec) {
  db.prepare(`INSERT INTO books(game_id,title,slug,source_path,volume_count,char_count,bytes,mtime_ms)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(game_id,title) DO UPDATE SET slug=excluded.slug, source_path=excluded.source_path,
      volume_count=excluded.volume_count, char_count=excluded.char_count, bytes=excluded.bytes, mtime_ms=excluded.mtime_ms`)
    .run(gid, rec.title, encodeURIComponent(rec.title), rec.sourcePath, rec.sections.length, rec.charCount, rec.bytes, rec.mtimeMs);
  const id = db.prepare('SELECT id FROM books WHERE game_id=? AND title=?').get(gid, rec.title).id;
  db.prepare('DELETE FROM book_sections WHERE book_id=?').run(id);
  const st = db.prepare('INSERT INTO book_sections(book_id,ord,title,blocks,body) VALUES(?,?,?,?,?)');
  rec.sections.forEach((s, i) => st.run(id, i, s.title, JSON.stringify(s.blocks), s.plain));

  deleteOwner(db, 'book', id);
  rec.sections.forEach((s, i) => insertSearchDoc(db, {
    type: 'book', gameId: gid, ownerId: id, ownerName: rec.title, heading: s.title, ord: i, text: s.plain,
    extra: { kind: 'book', index: i, volume: s.title },
  }));
  return id;
}

// ---------------------------------------------------------------- 主流程

function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).filter(filter).map((n) => path.join(dir, n)).sort();
}

function main() {
  const t0 = Date.now();
  const db = openDb();
  seedGames(db);
  const gid = gameId(db, GAME_SLUG);

  const charFiles = listFiles(SRC_CHARS, () => true);
  const bookFiles = listFiles(SRC_BOOKS, () => true);
  const names = charFiles.map(charNameFromFile);
  const resolve = buildResolver(names);
  const missing = missingChars(names);
  if (missing.length) console.warn('[warn] names.mjs 拼音表缺字:', missing.join(''));

  const state = new Map(db.prepare('SELECT path,mtime_ms,size FROM build_state').all().map((r) => [r.path, r]));
  const nameToId = new Map(db.prepare('SELECT id,name FROM characters').all().map((r) => [r.name, r.id]));
  const bookIdByTitle = new Map(db.prepare('SELECT id,title FROM books').all().map((r) => [r.title, r.id]));

  const changedChars = [];
  const changedBooks = [];
  for (const f of charFiles) {
    const st = fs.statSync(f);
    const prev = state.get(f);
    if (!INCREMENTAL || !prev || prev.mtime_ms !== st.mtimeMs || prev.size !== st.size) changedChars.push(f);
  }
  for (const f of bookFiles) {
    const st = fs.statSync(f);
    const prev = state.get(f);
    if (!INCREMENTAL || !prev || prev.mtime_ms !== st.mtimeMs || prev.size !== st.size) changedBooks.push(f);
  }

  // 删除源文件已消失的条目
  const liveChars = new Set(charFiles);
  const liveBooks = new Set(bookFiles);
  for (const r of db.prepare('SELECT path,kind FROM build_state').all()) {
    if (r.kind === 'character' && !liveChars.has(r.path)) {
      db.prepare('DELETE FROM relations WHERE src_id IN (SELECT id FROM characters WHERE source_path=?)').run(r.path);
      db.prepare('DELETE FROM characters WHERE source_path=?').run(r.path);
      db.prepare('DELETE FROM build_state WHERE path=?').run(r.path);
    }
    if (r.kind === 'book' && !liveBooks.has(r.path)) {
      db.prepare('DELETE FROM books WHERE source_path=?').run(r.path);
      db.prepare('DELETE FROM build_state WHERE path=?').run(r.path);
    }
  }

  db.exec('BEGIN');
  const setState = db.prepare('INSERT INTO build_state(path,kind,mtime_ms,size) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, size=excluded.size, kind=excluded.kind');

  for (const f of changedChars) {
    const rec = parseCharacter(f);
    writeCharacter(db, gid, rec, resolve, nameToId);
    const st = fs.statSync(f);
    setState.run(f, 'character', st.mtimeMs, st.size);
  }
  for (const f of changedBooks) {
    const rec = parseBook(f);
    writeBook(db, gid, rec);
    const st = fs.statSync(f);
    setState.run(f, 'book', st.mtimeMs, st.size);
  }

  // 关系目标二次回填（角色 id 可能在增量过程中才出现）
  db.exec(`UPDATE relations SET target_id = (
      SELECT c2.id FROM characters c2 WHERE c2.name = relations.target_name AND relations.game_id = c2.game_id
    ) WHERE target_id IS NULL AND EXISTS (SELECT 1 FROM characters c2 WHERE c2.name = relations.target_name)`);

  // 美术资产工作清单
  const jobs = [];
  const arts = [];
  for (const row of db.prepare('SELECT id,name,game_id,has_full_art,has_icon FROM characters WHERE game_id=?').all(gid)) {
    const slugName = url(row.name);
    if (row.has_full_art) {
      jobs.push({ name: row.name, kind: 'full', src: path.join(ART, `${row.name}.png`), thumb: path.join(DATA, 'assets', 'thumbs', `${slugName}.webp`), display: path.join(DATA, 'assets', 'display', `${slugName}.webp`) });
    }
    if (row.has_icon) {
      jobs.push({ name: row.name, kind: 'icon', src: path.join(ART, 'icon', `${row.name}.png`), icon: path.join(DATA, 'assets', 'icons', `${slugName}.webp`) });
    }
  }
  const artSt = db.prepare('INSERT INTO artworks(game_id,character_id,kind,name,png_path,webp_path,source_url,path_fixed) VALUES(?,?,?,?,?,?,?,1)');
  for (const j of jobs) {
    const cid = nameToId.get(j.name) ?? null;
    const dest = j.kind === 'full' ? j.display : j.icon;
    const png = j.src;
    let bytes = null;
    try { bytes = fs.statSync(png).size; } catch { bytes = null; }
    arts.push({ cid, kind: j.kind, name: j.name, png, dest, bytes });
  }

  db.exec('COMMIT');

  // artworks 同步。
  // 全量模式：整表重建（随后由 build-assets.py 回填尺寸/体积并补 thumb 行）。
  // 增量模式：只增删差异行，保留 build-assets.py 已回填的 width/height/bytes/thumb，
  //          避免「只改 1 个 md」把 365 行衍生图元数据全部清空。
  db.exec('BEGIN');
  if (INCREMENTAL) {
    const existingArts = db.prepare('SELECT id, character_id, kind FROM artworks WHERE game_id=?').all(gid);
    const key = (cid, kind) => `${cid}|${kind}`;
    const wanted = new Set(arts.map((a) => key(a.cid, a.kind)));
    const delArt = db.prepare('DELETE FROM artworks WHERE id=?');
    const updArt = db.prepare('UPDATE artworks SET name=?, png_path=?, webp_path=? WHERE id=?');
    const idByKey = new Map();
    for (const e of existingArts) {
      const k = key(e.character_id, e.kind);
      if (wanted.has(k)) idByKey.set(k, e.id);
      // build.mjs 只管 full/icon 两类；thumb 由 build-assets.py 维护，增量时原样保留。
      else if (e.kind === 'full' || e.kind === 'icon') delArt.run(e.id);
    }
    // 已有行只更新路径类字段；缺失行按需插入。
    for (const a of arts) {
      const k = key(a.cid, a.kind);
      const id = idByKey.get(k);
      if (id != null) updArt.run(a.name, a.png, a.dest, id);
      else artSt.run(gid, a.cid, a.kind, a.name, a.png, a.dest, null);
    }
  } else {
    db.prepare('DELETE FROM artworks WHERE game_id=?').run(gid);
    for (const a of arts) artSt.run(gid, a.cid, a.kind, a.name, a.png, a.dest, null);
  }
  db.exec('COMMIT');

  fs.writeFileSync(JOBS_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), kb: KB, data: DATA, jobs }, null, 1), 'utf8');

  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  const stats = {
    characters: count('SELECT COUNT(*) n FROM characters WHERE game_id=?', gid),
    books: count('SELECT COUNT(*) n FROM books WHERE game_id=?', gid),
    relations: count('SELECT COUNT(*) n FROM relations WHERE game_id=?', gid),
    relationsResolved: count('SELECT COUNT(*) n FROM relations WHERE game_id=? AND target_id IS NOT NULL', gid),
    stories: count('SELECT COUNT(*) n FROM story_chapters'),
    voices: count('SELECT COUNT(*) n FROM voice_lines'),
    dialogueGroups: count('SELECT COUNT(*) n FROM dialogue_groups'),
    dialogueLines: count('SELECT COUNT(*) n FROM dialogue_lines'),
    preferences: count('SELECT COUNT(*) n FROM preferences'),
    searchDocs: count('SELECT COUNT(*) n FROM search_docs'),
    fullArt: count('SELECT COUNT(*) n FROM characters WHERE has_full_art=1'),
    iconArt: count('SELECT COUNT(*) n FROM characters WHERE has_icon=1'),
  };
  const metas = { built_at: new Date().toISOString(), build_ms: String(Date.now() - t0), stats: JSON.stringify(stats), incremental: String(INCREMENTAL) };
  const metaSt = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(metas)) metaSt.run(k, v);

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  console.log(JSON.stringify({ mode: INCREMENTAL ? 'incremental' : 'full', reparsed: { characters: changedChars.length, books: changedBooks.length }, ms: Date.now() - t0, stats }, null, 2));
}

main();
