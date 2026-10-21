import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function scanTree(root, { dependencyTree = false } = {}) {
  const findings = [], files = [];
  // Explicitly approved UI art for the local client package. Keep the allowlist
  // narrow: KB assets and every other binary remain blocked by the checks below.
  const approvedClientVisuals = new Map(['venti', 'zhongli', 'raiden', 'nahida', 'focalors', 'mavuika', 'tsaritsa'].map(name => [`client/web/chat/assets/archons/${name}.webp`, 'webp']));
  const excluded = new Set(['.git', 'node_modules', 'dist', 'out', 'outputs', 'release', 'temp', 'cache', 'logs', 'work', 'test-results', 'userData']);
  const patterns = [
    ['key', /\bsk-[A-Za-z0-9_-]{12,}/],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})/],
    ['personal-path', /[A-Za-z]:[\\/]+(?:Users[\\/]+(?!Public\b|Default\b)[^\\/\s'";]+|Akasha|ambr-kb|dsh-gen-suite|ComfyUI)/i],
    ['private-ip', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
    ['embedded-secret', /(?:apiKey|secret|password|kbToken)\s*["']?\s*[:=]\s*["'](?!["']|your-|process\.env)([^"'\r\n]{12,})["']/i],
  ];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), rel = path.relative(root, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) { findings.push({ file: rel, rule: 'symlink' }); continue; }
      if (entry.isDirectory()) { if (!excluded.has(entry.name)) visit(file); continue; }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(file); files.push({ file: rel, bytes: stat.size });
      const approvedFormat = approvedClientVisuals.get(rel);
      const approvedVisual = !!approvedFormat;
      if (approvedVisual) {
        const signature = Buffer.alloc(12);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, signature, 0, signature.length, 0); } finally { fs.closeSync(fd); }
        const valid = approvedFormat === 'webp' && signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP';
        if (stat.size > 2 * 1024 * 1024 || !valid) findings.push({ file: rel, rule: 'approved-visual-invalid' });
      }
      if (!approvedVisual && /\.(?:sqlite(?:3)?(?:-wal|-shm)?|db(?:-wal|-shm)?|mp4|mp3|wav|ogg|aac|webm|mov|mkv|png|jpe?g|webp|gif|ico|pfx|pem|p12|key|exe|zip)$/i.test(entry.name)) findings.push({ file: rel, rule: 'data-or-binary' });
      if (/^(?:data|data-src|assets|media-cache|videos|clips|thumbnails)\//.test(rel) && !/\.(?:gitkeep|md)$/.test(entry.name)) findings.push({ file: rel, rule: 'corpus-directory' });
      if (/^(?:llm\.config|config|resolved|build-defaults(?:\.client)?)\.json$/.test(entry.name)) findings.push({ file: rel, rule: 'private-config' });
      if (approvedVisual) continue;
      if (stat.size > 2 * 1024 * 1024) { findings.push({ file: rel, rule: 'large-file' }); continue; }
      const buffer = fs.readFileSync(file);
      if (buffer.subarray(0, 16).toString().startsWith('SQLite format 3')) findings.push({ file: rel, rule: 'sqlite-magic' });
      const content = buffer.toString('utf8');
      for (const [rule, pattern] of patterns) if (pattern.test(content)) findings.push({ file: rel, rule });
      const mediaUrls = content.match(/https?:\/\/[^\s"'<>`]+\.mp4(?:[?#][^\s"'<>`]*)?/gi) || [];
      if (mediaUrls.some(url => !url.startsWith('https://example.invalid/'))) findings.push({ file: rel, rule: 'source-video-url' });
    }
  }
  visit(root);
  return { scannedFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), findings, files };
}
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const result = scanTree(root);
  // Only file names and rule identifiers are printed. Never print matched values.
  console.log(JSON.stringify({ scannedFiles: result.scannedFiles, totalBytes: result.totalBytes, findings: result.findings }, null, 2));
  console.log(result.findings.length ? 'Pre-publish scan FAILED' : 'Pre-publish scan PASSED');
  process.exitCode = result.findings.length ? 1 : 0;
}
