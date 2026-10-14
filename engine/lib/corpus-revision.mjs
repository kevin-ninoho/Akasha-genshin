import fs from 'node:fs';
import path from 'node:path';

export function corpusRevision(dataDir = process.env.KB_DATA_DIR || new URL('../data/', import.meta.url)) {
  try {
    const base = dataDir instanceof URL ? dataDir : path.resolve(dataDir);
    const file = base instanceof URL ? new URL('obc-sync-revision.json', base) : path.join(base, 'obc-sync-revision.json');
    return fs.statSync(file).mtimeMs;
  } catch { return 0; }
}
