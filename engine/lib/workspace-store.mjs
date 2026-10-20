import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const kinds = new Set(['conversations', 'research', 'growth', 'pv', 'preferences']);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
export class WorkspaceStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (
        owner TEXT NOT NULL, game TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        revision INTEGER NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner,game,kind,id));
      CREATE TABLE IF NOT EXISTS evidence (
        owner TEXT NOT NULL, game TEXT NOT NULL, answer TEXT NOT NULL, revision TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(owner,game,answer));
      PRAGMA user_version=1;`);
  }
  validate(kind, id) {
    if (!kinds.has(kind) || !/^[\w-]{1,100}$/.test(id)) throw fail(400, 'bad_document', '工作区记录无效');
  }
  list(owner, game, kind) {
    this.validate(kind, 'list');
    return this.db.prepare('SELECT id,revision,updated,body FROM documents WHERE owner=? AND game=? AND kind=? ORDER BY updated DESC')
      .all(owner, game, kind).map(r => ({ ...r, data: JSON.parse(r.body), body: undefined }));
  }
  get(owner, game, kind, id) {
    this.validate(kind, id);
    const r = this.db.prepare('SELECT id,revision,updated,body FROM documents WHERE owner=? AND game=? AND kind=? AND id=?').get(owner, game, kind, id);
    return r ? { id: r.id, revision: r.revision, updated: r.updated, data: JSON.parse(r.body) } : null;
  }
  put(owner, game, kind, id, data, expected = 0) {
    this.validate(kind, id);
    const body = JSON.stringify(data);
    if (!body || Buffer.byteLength(body) > 12 * 1024 ** 2) throw fail(413, 'document_too_large', '记录过大，请拆分专题');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.get(owner, game, kind, id);
      if ((old?.revision || 0) !== expected) throw fail(409, 'revision_conflict', '记录已被另一窗口修改，请重新加载后合并');
      const revision = expected + 1, updated = Date.now();
      this.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner,game,kind,id) DO UPDATE SET revision=excluded.revision,updated=excluded.updated,body=excluded.body')
        .run(owner, game, kind, id, revision, updated, body);
      this.db.exec('COMMIT');
      return { id, revision, updated, data };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  delete(owner, game, kind, id, revision) {
    this.validate(kind, id);
    const out = this.db.prepare('DELETE FROM documents WHERE owner=? AND game=? AND kind=? AND id=? AND revision=?').run(owner, game, kind, id, revision);
    if (!out.changes) throw fail(409, 'revision_conflict', '记录已变化，请重新加载');
  }
  capture(owner, game, sources, revision) {
    const id = crypto.randomUUID();
    const items = sources.slice(0, 24).map((s, i) => ({
      ref: s.ref ?? i + 1, sourceId: String(s.sourceId || s.id || i), title: String(s.title || '来源'),
      type: String(s.type || ''), authority: String(s.authority || '未标注'),
      text: String(s.text || '').slice(0, 1800),
    }));
    this.db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?)').run(owner, game, id, String(revision), JSON.stringify(items));
    return id;
  }
  evidence(owner, game, id, currentRevision) {
    const r = this.db.prepare('SELECT revision,body FROM evidence WHERE owner=? AND game=? AND answer=?').get(owner, game, id);
    if (!r) throw fail(404, 'evidence_not_found', '没有可读取的回答依据；旧会话可重新提问');
    return { answerId: id, revision: r.revision, stale: r.revision !== String(currentRevision), items: JSON.parse(r.body) };
  }
  close() { this.db.close(); }
}
