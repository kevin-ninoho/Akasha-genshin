import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { videoSources } from '../lib/media-jobs.mjs';
import { atomicJson } from '../lib/atomic-file.mjs';

const position = process.argv.indexOf('--output');
const output = position >= 0 ? process.argv[position + 1] : '';
if (!output || !process.env.KB_DATA_DIR) {
  console.error('Set KB_DATA_DIR and provide --output data/video-index.json. This index is private and must not be committed.');
  process.exit(2);
}
let db;
try {
  db = new DatabaseSync(path.join(process.env.KB_DATA_DIR, 'kb-workspace.sqlite'), { readOnly: true });
  const entries = [];
  for (const row of db.prepare("SELECT id,name,raw_json FROM obc_entries WHERE kind IN ('char-video','other-video','cutscene')").iterate()) {
    let page; try { page = JSON.parse(row.raw_json); } catch { continue; }
    videoSources(page).forEach((url, videoIndex) => entries.push({ entryId: Number(row.id), videoIndex, title: row.name, url }));
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  atomicJson(output, { version: 1, entries });
  console.log(JSON.stringify({ entries: entries.length, privateIndexWritten: true }));
} catch { console.error('无法生成视频索引，请检查 KB_DATA_DIR 是否包含已导入的观测枢侧车库。'); process.exitCode = 1; }
finally { db?.close(); }
