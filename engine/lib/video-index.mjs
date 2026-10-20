import fs from 'node:fs';

export function loadVideoIndex(file) {
  if (!file) return { configured: false, entries: new Map() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const entries = new Map();
    for (const row of parsed.entries || []) {
      if (!Number.isSafeInteger(row.entryId) || !Number.isSafeInteger(row.videoIndex) || (!row.url && !row.localPath) || !row.title) continue;
      entries.set(`${row.entryId}:${row.videoIndex}`, { title: String(row.title), url: String(row.url || ''), localPath: row.localPath ? String(row.localPath) : '' });
    }
    return { configured: true, entries };
  } catch {
    return { configured: false, entries: new Map() };
  }
}
