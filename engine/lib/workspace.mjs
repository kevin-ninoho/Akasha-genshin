// 工作区（可写）侧车库 —— 笔记 / 派单 / 素材 / 标签 / KV。
//
// 为什么是侧车而不是直接写 kb.sqlite：
//   kb.sqlite 是 build.mjs 的产物，全量或增量重建时会对 characters / books /
//   relations 等表做 UPSERT 与 DELETE。若把用户与智能体写入的数据混在里面，
//   一次重建就可能把三天前的派单记录连带冲掉。
//   因此：主库继续以 readOnly 打开（查询、检索、FTS 全走它），
//         所有写入落在 data/kb-workspace.sqlite，两者靠 character_id / book_id 关联。
//
// 这个文件只依赖 node:sqlite，不引入任何第三方包。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const nowIso = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'note',
  scope       TEXT NOT NULL DEFAULT 'general',
  target_type TEXT,
  target_id   TEXT,
  target_name TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  meta_json   TEXT,
  source      TEXT,
  session_id  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_target ON notes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind, scope);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id     TEXT,
  provider        TEXT NOT NULL DEFAULT 'comfyui',
  kind            TEXT NOT NULL DEFAULT 'text2image',
  character_id    TEXT,
  character_name  TEXT,
  title           TEXT,
  prompt          TEXT,
  negative_prompt TEXT,
  params_json     TEXT,
  workflow        TEXT,
  status          TEXT NOT NULL DEFAULT 'planned',
  result_json     TEXT,
  notes           TEXT,
  session_id      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_char ON jobs(character_id);
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_ext ON jobs(provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS assets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER,
  character_id   TEXT,
  character_name TEXT,
  kind           TEXT NOT NULL DEFAULT 'image',
  role           TEXT,
  path           TEXT,
  url            TEXT,
  bytes          INTEGER,
  width          INTEGER,
  height         INTEGER,
  sha256         TEXT,
  meta_json      TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);
CREATE INDEX IF NOT EXISTS idx_assets_char ON assets(character_id);

CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id      INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(tag_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_etags_entity ON entity_tags(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);
`;

const NOTE_COLS = ['kind', 'scope', 'target_type', 'target_id', 'target_name', 'title', 'body', 'tags', 'meta_json', 'source', 'session_id'];
const JOB_COLS = ['external_id', 'provider', 'kind', 'character_id', 'character_name', 'title', 'prompt', 'negative_prompt', 'params_json', 'workflow', 'status', 'result_json', 'notes', 'session_id'];
const ASSET_COLS = ['job_id', 'character_id', 'character_name', 'kind', 'role', 'path', 'url', 'bytes', 'width', 'height', 'sha256', 'meta_json'];

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
};

/** 允许调用方直接塞对象；对象一律序列化成 JSON 文本存 meta/params/result。 */
const jsonOrNull = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return null; }
};

const tagList = (v) => {
  if (v === undefined || v === null) return '';
  const arr = Array.isArray(v) ? v : String(v).split(/[,，\s]+/);
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))].join(',');
};

function decode(row, jsonCols) {
  if (!row) return null;
  const out = { ...row };
  for (const c of jsonCols) {
    const raw = out[c];
    if (typeof raw !== 'string' || !raw) continue;
    try { out[c.replace(/_json$/, '')] = JSON.parse(raw); } catch { /* 保留原文 */ }
  }
  return out;
}

const shapeNote = (r) => {
  if (!r) return null;
  const out = decode(r, ['meta_json']);
  out.tags = r.tags ? String(r.tags).split(',').filter(Boolean) : [];
  return out;
};
const shapeJob = (r) => decode(r, ['params_json', 'result_json']);
const shapeAsset = (r) => decode(r, ['meta_json']);

// ---------------------------------------------------------------- SQL 安全

const READ_OK = /^\s*(select|with|pragma|explain)\b/i;
const READ_DENY = /\b(attach|detach|insert|update|delete|drop|create|alter|replace|vacuum|reindex)\b/i;
const WRITE_DENY = /\b(attach|detach)\b/i;

function stripSql(sql) {
  let s = String(sql ?? '').trim();
  s = s.replace(/;\s*$/, '');
  if (!s) throw new Error('sql 不能为空');
  if (s.includes(';')) throw new Error('只允许单条语句（不能包含分号）');
  return s;
}

function sanitizeParams(params) {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) throw new Error('params 必须是数组');
  return params.map((p) => {
    if (p === null || p === undefined) return null;
    const t = typeof p;
    if (t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean') return p;
    throw new Error(`params 只支持 string/number/boolean/null（收到 ${t}）`);
  });
}

/**
 * 只读查询（跑在主库 kb.sqlite 上）。
 * 因为连接本身是 readOnly，即便有人绕过关键字校验也写不进去。
 */
export function runReadQuery(roDb, sql, { params, maxRows = 200 } = {}) {
  const text = stripSql(sql);
  if (!READ_OK.test(text)) throw new Error('读查询必须以 SELECT / WITH / PRAGMA / EXPLAIN 开头');
  if (READ_DENY.test(text)) throw new Error('读查询不能包含写关键字（insert/update/delete/drop/attach 等）');
  const p = sanitizeParams(params);
  const cap = Math.min(Math.max(Number(maxRows) || 200, 1), 2000);
  const started = Date.now();
  const stmt = roDb.prepare(text);
  const rows = stmt.all(...p);
  let columns = rows.length ? Object.keys(rows[0]) : [];
  if (!columns.length && typeof stmt.columns === 'function') {
    try { columns = stmt.columns().map((c) => c.name); } catch { /* 忽略 */ }
  }
  return {
    mode: 'read',
    columns,
    rows: rows.slice(0, cap),
    rowCount: rows.length,
    truncated: rows.length > cap,
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------- 工作区

class Workspace {
  constructor(db, file, writable = true) {
    this.db = db;
    this.file = file;
    this.writable = writable;
  }

  /**
   * 任意 SQL 跑在工作区库上（可写）。这是「放开权限」的兜底通道：
   * 智能体可以自己建表、批量改状态、做复杂聚合，不必等新接口。
   * 唯一禁止的是 ATTACH / DETACH —— 防止脚本把主库挂进来改写。
   */
  exec(sql, { params, maxRows = 2000 } = {}) {
    const text = stripSql(sql);
    if (WRITE_DENY.test(text)) throw new Error('工作区查询禁止 ATTACH / DETACH');
    const p = sanitizeParams(params);
    const started = Date.now();
    const stmt = this.db.prepare(text);
    const isSelect = /^\s*(select|with|pragma|explain)\b/i.test(text);
    if (isSelect) {
      const rows = stmt.all(...p);
      const cap = Math.min(Math.max(Number(maxRows) || 2000, 1), 10000);
      return {
        mode: 'write',
        statement: 'select',
        columns: rows.length ? Object.keys(rows[0]) : [],
        rows: rows.slice(0, cap),
        rowCount: rows.length,
        truncated: rows.length > cap,
        elapsedMs: Date.now() - started,
      };
    }
    const info = stmt.run(...p);
    return {
      mode: 'write',
      statement: 'exec',
      changes: Number(info.changes || 0),
      lastInsertRowid: Number(info.lastInsertRowid || 0),
      elapsedMs: Date.now() - started,
    };
  }

  summary() {
    const count = (t) => this.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    return {
      writable: this.writable,
      file: this.file,
      bytes: size,
      counts: {
        notes: count('notes'),
        jobs: count('jobs'),
        assets: count('assets'),
        tags: count('tags'),
        entityTags: count('entity_tags'),
        kv: count('kv'),
      },
      recentNotes: this.db.prepare(
        'SELECT id,kind,scope,target_type,target_id,target_name,title,updated_at FROM notes ORDER BY updated_at DESC, id DESC LIMIT 5',
      ).all(),
      recentJobs: this.db.prepare(
        'SELECT id,kind,status,character_id,character_name,title,updated_at FROM jobs ORDER BY updated_at DESC, id DESC LIMIT 5',
      ).all(),
    };
  }

  // -------------------------------------------------------------- notes

  listNotes({ q = '', kind, scope, targetType, targetId, tag, limit = 50, offset = 0 } = {}) {
    const where = [];
    const p = [];
    if (kind) { where.push('kind = ?'); p.push(kind); }
    if (scope) { where.push('scope = ?'); p.push(scope); }
    if (targetType) { where.push('target_type = ?'); p.push(targetType); }
    if (targetId !== undefined && targetId !== null && targetId !== '') {
      where.push('target_id = ?');
      p.push(String(targetId));
    }
    if (tag) { where.push("instr(',' || tags || ',', ?) > 0"); p.push(`,${tag},`); }
    if (q) {
      where.push('(title LIKE ? OR body LIKE ? OR tags LIKE ? OR target_name LIKE ?)');
      const like = `%${q}%`;
      p.push(like, like, like, like);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM notes${clause}`).get(...p).n;
    const rows = this.db.prepare(
      `SELECT * FROM notes${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...p, Math.min(Math.max(Number(limit) || 50, 1), 500), Math.max(Number(offset) || 0, 0));
    return { items: rows.map(shapeNote), total };
  }

  getNote(id) {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id));
    return row ? shapeNote(row) : null;
  }

  createNote(input = {}) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('笔记 title 不能为空');
    const ts = nowIso();
    const vals = {
      kind: strOrNull(input.kind) ?? 'note',
      scope: strOrNull(input.scope) ?? (input.target_type ? String(input.target_type) : 'general'),
      target_type: strOrNull(input.target_type),
      target_id: strOrNull(input.target_id),
      target_name: strOrNull(input.target_name),
      title,
      body: String(input.body ?? ''),
      tags: tagList(input.tags),
      meta_json: jsonOrNull(input.meta),
      source: strOrNull(input.source),
      session_id: strOrNull(input.session_id),
    };
    const info = this.db.prepare(
      `INSERT INTO notes (${NOTE_COLS.join(',')}, created_at, updated_at)
       VALUES (${NOTE_COLS.map(() => '?').join(',')}, ?, ?)`,
    ).run(...NOTE_COLS.map((c) => vals[c]), ts, ts);
    return this.getNote(info.lastInsertRowid);
  }

  updateNote(id, patch = {}) {
    if (!this.getNote(id)) return null;
    const src = { ...patch };
    if ('meta' in src && !('meta_json' in src)) src.meta_json = src.meta;
    const sets = [];
    const p = [];
    for (const c of NOTE_COLS) {
      if (!(c in src)) continue;
      const v = src[c];
      let val;
      if (c === 'title') {
        val = String(v ?? '').trim();
        if (!val) throw new Error('title 不能改成空');
      } else if (c === 'body') {
        val = String(v ?? '');
      } else if (c === 'tags') {
        val = tagList(v);
      } else if (c === 'meta_json') {
        val = jsonOrNull(v);
      } else {
        val = strOrNull(v);
      }
      sets.push(`${c} = ?`);
      p.push(val);
    }
    if (!sets.length) return this.getNote(id);
    sets.push('updated_at = ?');
    p.push(nowIso(), Number(id));
    this.db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...p);
    return this.getNote(id);
  }

  deleteNote(id) {
    const info = this.db.prepare('DELETE FROM notes WHERE id = ?').run(Number(id));
    return Number(info.changes || 0);
  }

  // -------------------------------------------------------------- jobs

  listJobs({ q = '', status, kind, characterId, provider, limit = 50, offset = 0 } = {}) {
    const where = [];
    const p = [];
    if (status) { where.push('status = ?'); p.push(status); }
    if (kind) { where.push('kind = ?'); p.push(kind); }
    if (provider) { where.push('provider = ?'); p.push(provider); }
    if (characterId !== undefined && characterId !== null && characterId !== '') {
      where.push('character_id = ?');
      p.push(String(characterId));
    }
    if (q) {
      where.push('(title LIKE ? OR prompt LIKE ? OR character_name LIKE ? OR notes LIKE ?)');
      const like = `%${q}%`;
      p.push(like, like, like, like);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM jobs${clause}`).get(...p).n;
    const rows = this.db.prepare(
      `SELECT * FROM jobs${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...p, Math.min(Math.max(Number(limit) || 50, 1), 500), Math.max(Number(offset) || 0, 0));
    return { items: rows.map(shapeJob), total };
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
    if (!row) return null;
    const job = shapeJob(row);
    job.assetList = this.db.prepare('SELECT * FROM assets WHERE job_id = ? ORDER BY id').all(job.id).map(shapeAsset);
    return job;
  }

  createJob(input = {}) {
    const ts = nowIso();
    const vals = {
      external_id: strOrNull(input.external_id),
      provider: strOrNull(input.provider) ?? 'comfyui',
      kind: strOrNull(input.kind) ?? 'text2image',
      character_id: strOrNull(input.character_id),
      character_name: strOrNull(input.character_name),
      title: strOrNull(input.title),
      prompt: strOrNull(input.prompt),
      negative_prompt: strOrNull(input.negative_prompt),
      params_json: jsonOrNull(input.params),
      workflow: strOrNull(input.workflow),
      status: strOrNull(input.status) ?? 'planned',
      result_json: jsonOrNull(input.result),
      notes: strOrNull(input.notes),
      session_id: strOrNull(input.session_id),
    };
    // external_id 重复时复用旧记录（幂等），避免 agent 重试把库刷满副本。
    if (vals.external_id) {
      const dup = this.db.prepare('SELECT id FROM jobs WHERE provider = ? AND external_id = ?')
        .get(vals.provider, vals.external_id);
      if (dup) return this.getJob(dup.id);
    }
    const info = this.db.prepare(
      `INSERT INTO jobs (${JOB_COLS.join(',')}, created_at, updated_at)
       VALUES (${JOB_COLS.map(() => '?').join(',')}, ?, ?)`,
    ).run(...JOB_COLS.map((c) => vals[c]), ts, ts);
    return this.getJob(info.lastInsertRowid);
  }

  updateJob(id, patch = {}) {
    if (!this.getJob(id)) return null;
    const src = { ...patch };
    if ('params' in src && !('params_json' in src)) src.params_json = src.params;
    if ('result' in src && !('result_json' in src)) src.result_json = src.result;
    const sets = [];
    const p = [];
    for (const c of JOB_COLS) {
      if (!(c in src)) continue;
      const val = (c === 'params_json' || c === 'result_json') ? jsonOrNull(src[c]) : strOrNull(src[c]);
      sets.push(`${c} = ?`);
      p.push(val);
    }
    if (!sets.length) return this.getJob(id);
    sets.push('updated_at = ?');
    p.push(nowIso(), Number(id));
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...p);
    return this.getJob(id);
  }

  deleteJob(id) {
    this.db.prepare('DELETE FROM assets WHERE job_id = ?').run(Number(id));
    const info = this.db.prepare('DELETE FROM jobs WHERE id = ?').run(Number(id));
    return Number(info.changes || 0);
  }

  // -------------------------------------------------------------- assets

  listAssets({ jobId, characterId, kind, limit = 100, offset = 0 } = {}) {
    const where = [];
    const p = [];
    if (jobId !== undefined && jobId !== null && jobId !== '') { where.push('job_id = ?'); p.push(Number(jobId)); }
    if (characterId !== undefined && characterId !== null && characterId !== '') {
      where.push('character_id = ?');
      p.push(String(characterId));
    }
    if (kind) { where.push('kind = ?'); p.push(kind); }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM assets${clause}`).get(...p).n;
    const rows = this.db.prepare(
      `SELECT * FROM assets${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...p, Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0));
    return { items: rows.map(shapeAsset), total };
  }

  addAsset(input = {}) {
    const vals = {
      job_id: numOrNull(input.job_id),
      character_id: strOrNull(input.character_id),
      character_name: strOrNull(input.character_name),
      kind: strOrNull(input.kind) ?? 'image',
      role: strOrNull(input.role),
      path: strOrNull(input.path),
      url: strOrNull(input.url),
      bytes: numOrNull(input.bytes),
      width: numOrNull(input.width),
      height: numOrNull(input.height),
      sha256: strOrNull(input.sha256),
      meta_json: jsonOrNull(input.meta),
    };
    if (vals.path && !vals.bytes && fs.existsSync(vals.path)) {
      try { vals.bytes = fs.statSync(vals.path).size; } catch { /* 忽略 */ }
    }
    const info = this.db.prepare(
      `INSERT INTO assets (${ASSET_COLS.join(',')}, created_at)
       VALUES (${ASSET_COLS.map(() => '?').join(',')}, ?)`,
    ).run(...ASSET_COLS.map((c) => vals[c]), nowIso());
    return shapeAsset(this.db.prepare('SELECT * FROM assets WHERE id = ?').get(info.lastInsertRowid));
  }

  deleteAsset(id) {
    const info = this.db.prepare('DELETE FROM assets WHERE id = ?').run(Number(id));
    return Number(info.changes || 0);
  }

  // -------------------------------------------------------------- tags

  listTags() {
    return this.db.prepare(
      'SELECT t.*, (SELECT COUNT(*) FROM entity_tags e WHERE e.tag_id = t.id) AS uses FROM tags t ORDER BY t.name',
    ).all();
  }

  upsertTag({ name, color, note } = {}) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('标签 name 不能为空');
    this.db.prepare(
      `INSERT INTO tags (name, color, note, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET color = COALESCE(excluded.color, tags.color),
                                       note  = COALESCE(excluded.note, tags.note)`,
    ).run(n, strOrNull(color), strOrNull(note), nowIso());
    return this.db.prepare('SELECT * FROM tags WHERE name = ?').get(n);
  }

  linkTag({ tag, tag_id, entity_type, entity_id } = {}) {
    // 既支持传标签名（不存在会自动建），也支持传 tag_id。
    const t = tag_id !== undefined && tag_id !== null && tag_id !== ''
      ? this.db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(tag_id))
      : this.upsertTag({ name: tag });
    if (!t) throw new Error(`标签不存在：tag_id=${tag_id}`);
    const et = String(entity_type ?? '').trim();
    const eid = String(entity_id ?? '').trim();
    if (!et || !eid) throw new Error('entity_type 与 entity_id 都不能为空');
    this.db.prepare(
      `INSERT INTO entity_tags (tag_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tag_id, entity_type, entity_id) DO NOTHING`,
    ).run(t.id, et, eid, nowIso());
    const link = this.db.prepare(
      'SELECT * FROM entity_tags WHERE tag_id = ? AND entity_type = ? AND entity_id = ?',
    ).get(t.id, et, eid);
    return { tag: t, entity_type: et, entity_id: eid, link };
  }

  unlinkTag(id) {
    const info = this.db.prepare('DELETE FROM entity_tags WHERE id = ?').run(Number(id));
    return Number(info.changes || 0);
  }

  tagsFor(entityType, entityId) {
    return this.db.prepare(
      `SELECT t.id, t.name, t.color, e.id AS link_id
         FROM entity_tags e JOIN tags t ON t.id = e.tag_id
        WHERE e.entity_type = ? AND e.entity_id = ? ORDER BY t.name`,
    ).all(String(entityType), String(entityId));
  }

  // -------------------------------------------------------------- kv

  getKv(key) {
    const row = this.db.prepare('SELECT * FROM kv WHERE key = ?').get(String(key));
    if (!row) return null;
    let value = row.value;
    try { value = JSON.parse(row.value); } catch { /* 保留字符串 */ }
    return { key: row.key, value, updated_at: row.updated_at };
  }

  listKv() {
    return this.db.prepare('SELECT key, value, updated_at FROM kv ORDER BY key').all().map((r) => {
      let v = r.value;
      try { v = JSON.parse(r.value); } catch { /* 保留字符串 */ }
      return { key: r.key, value: v, updated_at: r.updated_at };
    });
  }

  setKv(key, value) {
    const k = String(key ?? '').trim();
    if (!k) throw new Error('key 不能为空');
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(k, text, nowIso());
    return this.getKv(k);
  }

  deleteKv(key) {
    const info = this.db.prepare('DELETE FROM kv WHERE key = ?').run(String(key));
    return Number(info.changes || 0);
  }

  /**
   * 某个角色名下的全部工作区内容（笔记 + 派单 + 素材 + 标签）。
   * 二创链路里最常用的一次调用：拿到角色 → 看历史派单与素材 → 决定这次怎么拍。
   */
  characterBundle(id) {
    const sid = String(id);
    const noteSql = "SELECT * FROM notes WHERE (target_type = 'character' AND target_id = ?) OR scope = ? ORDER BY updated_at DESC, id DESC LIMIT 100";
    const notes = this.db.prepare(noteSql).all(sid, `character:${sid}`).map(shapeNote);
    const jobs = this.db.prepare('SELECT * FROM jobs WHERE character_id = ? ORDER BY updated_at DESC, id DESC LIMIT 100')
      .all(sid).map(shapeJob);
    const assetList = this.db.prepare('SELECT * FROM assets WHERE character_id = ? ORDER BY id DESC LIMIT 200')
      .all(sid).map(shapeAsset);
    for (const j of jobs) j.assetList = assetList.filter((a) => a.job_id === j.id);
    return { notes, jobs, assets: assetList, tags: this.tagsFor('character', sid) };
  }

  close() {
    try { this.db.close(); } catch { /* 忽略 */ }
  }
}

/**
 * 打开（必要时创建）工作区库。dir 不存在会自动建。
 *
 * `readonly: true`（演示版 / KB_WRITE=0）时：
 *   - 落盘文件已存在 → 照常打开（读接口可用）；
 *   - 文件不存在 → 用**内存库**兜底，返回空数据、**不在磁盘上落任何文件**，
 *     这样「只读演示包」解压后双击启动不会凭空多出 `kb-workspace.sqlite`。
 *   写接口在这一模式下已由 server 的 requireWrite() 统一 403。
 */
export function openWorkspace(dir, { readonly = false } = {}) {
  const file = path.join(dir, 'kb-workspace.sqlite');
  if (readonly && !fs.existsSync(file)) {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    return new Workspace(db, ':memory:', false);
  }
  fs.mkdirSync(dir, { recursive: true });
  if(readonly) return new Workspace(new DatabaseSync(file,{readOnly:true}),file,false);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return new Workspace(db, file, !readonly);
}

export { Workspace };
