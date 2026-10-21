import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanTree } from './prepublish-check.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = path.join(root, 'client');
const vi = process.argv.indexOf('--version');
const version = vi >= 0 ? process.argv[vi + 1] : process.env.AKASHA_VERSION;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Provide a release version: node scripts/build-client.mjs --version 0.3.0');
const owner = String(process.env.AKASHA_GITHUB_OWNER || '').trim();
const repo = String(process.env.AKASHA_GITHUB_REPO || '').trim();
if ((owner || repo) && (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo))) throw Error('Set valid AKASHA_GITHUB_OWNER and AKASHA_GITHUB_REPO together.');
const scan = scanTree(root);
if (scan.findings.length) { console.error(JSON.stringify(scan.findings)); process.exit(1); }
const privateDefaultsSource = String(process.env.AKASHA_BUILD_DEFAULTS_FILE || '').trim();
const privateDefaultsTarget = path.join(client, 'desktop', 'build-defaults.client.json');
if (fs.existsSync(privateDefaultsTarget)) throw Error('Refusing to build while a stale local service profile exists. Remove client/desktop/build-defaults.client.json first.');
let generatedDefaults = false;
if (privateDefaultsSource) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(privateDefaultsSource), 'utf8'));
  const defaults = {};
  if (typeof raw.kbRemoteV1 === 'string' && raw.kbRemoteV1.trim()) defaults.kbRemoteV1 = raw.kbRemoteV1.trim();
  const fallbacks = Array.isArray(raw.kbRemoteV1Fallbacks) ? raw.kbRemoteV1Fallbacks : [];
  // Public builds must not inherit machine-only hostnames from the owner's
  // local profile. Keep only distinct HTTPS failovers; the primary may remain
  // HTTP for compatibility with the already-deployed endpoint.
  const primaryHost = new URL(defaults.kbRemoteV1).hostname;
  defaults.kbRemoteV1Fallbacks = fallbacks.filter(value => {
    if (typeof value !== 'string' || !value.trim()) return false;
    try { const url = new URL(value.trim()); return url.protocol === 'https:' && url.hostname !== primaryHost; }
    catch { return false; }
  }).map(value => value.trim());
  if (typeof raw.kbToken === 'string' && raw.kbToken.trim()) defaults.kbToken = raw.kbToken.trim();
  if (!defaults.kbRemoteV1 || !defaults.kbToken) throw Error('The local service profile must provide kbRemoteV1 and kbToken.');
  for (const value of [defaults.kbRemoteV1, ...defaults.kbRemoteV1Fallbacks]) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid cloud service URL in local profile.');
  }
  fs.writeFileSync(privateDefaultsTarget, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx' });
  generatedDefaults = true;
}
const metadataPath = path.join(root, 'package.json');
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); metadata.version = version;
fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
// Root package.json is the sole editable version source. Client package metadata is derived at build time.
const output = path.resolve(process.env.AKASHA_BUILD_DIR || path.join(root, 'client', 'dist', `release-${version}-${Date.now()}`));
fs.mkdirSync(output, { recursive: true });
const args = [path.join(client, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', '--publish', 'never',
  '--config', 'electron-builder.client.yml', `--config.directories.output=${output}`,
  `--config.extraMetadata.version=${version}`, `--config.extraMetadata.akashaUpdateOwner=${owner}`,
  `--config.extraMetadata.akashaUpdateRepo=${repo}`, '--config.extraMetadata.akashaUpdateFormat=nsis'];
if (owner && repo) args.push('--config.publish.provider=github', `--config.publish.owner=${owner}`, `--config.publish.repo=${repo}`);
if (process.env.AKASHA_ELECTRON_DIST) args.push(`--config.electronDist=${path.resolve(process.env.AKASHA_ELECTRON_DIST)}`);
if (process.env.AKASHA_BUILD_COMPRESSION) {
  if (!['store', 'normal', 'maximum'].includes(process.env.AKASHA_BUILD_COMPRESSION)) throw Error('Invalid AKASHA_BUILD_COMPRESSION.');
  args.push(`--config.compression=${process.env.AKASHA_BUILD_COMPRESSION}`);
}
const env = { ...process.env };
// Building must never contact a release API, even if publishing credentials exist in the caller's shell.
delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
let code;
try {
  code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: client, stdio: 'inherit', env, windowsHide: true });
    child.on('error', reject); child.on('exit', result => resolve(result ?? 1));
  });
} finally {
  if (generatedDefaults) fs.rmSync(privateDefaultsTarget, { force: true });
}
if (code) throw Error(`electron-builder exited with status ${code}`);
const installer = `Akasha-${version}-x64-setup.exe`;
const bytes = fs.readFileSync(path.join(output, installer));
if (!fs.existsSync(path.join(output, installer + '.blockmap'))) throw Error('The NSIS blockmap was not generated.');
if (!owner || !repo) {
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  // JSON is valid YAML and accepted by electron-updater. This is local metadata only.
  fs.writeFileSync(path.join(output, 'latest.yml'), JSON.stringify({ version, files: [{ url: installer, sha512, size: bytes.length }], path: installer, sha512, releaseDate: new Date().toISOString() }, null, 2) + '\n');
}
const artifacts = fs.readdirSync(output).filter(file => /\.(?:exe|blockmap)$|^latest\.yml$/.test(file));
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), artifacts.map(file => crypto.createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex') + '  ' + file).join('\n') + '\n');
console.log(JSON.stringify({ version, updateConfigured: !!(owner && repo), artifacts, output }));
