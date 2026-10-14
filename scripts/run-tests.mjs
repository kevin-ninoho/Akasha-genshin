import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
const temp = path.join(root, 'temp'); fs.mkdirSync(results, { recursive: true }); fs.mkdirSync(temp, { recursive: true });
const tests = ['updates-regression', 'media-api-regression', 'capabilities-regression', 'obc-sync-regression'];
if (!process.argv.includes('--core')) tests.push('media-clips-regression');
const summary = [];
for (const name of tests) {
  const stream = fs.createWriteStream(path.join(results, `${name}.log`));
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'tests', `${name}.mjs`)], { cwd: root, windowsHide: true, env: { ...process.env, TEMP: temp, TMP: temp } });
    const timer = setTimeout(() => child.kill(), 180000);
    for (const output of [child.stdout, child.stderr]) output.on('data', chunk => { stream.write(chunk); process.stdout.write(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(1); });
    child.on('exit', result => { clearTimeout(timer); resolve(result ?? 1); });
  });
  await new Promise(resolve => stream.end(resolve)); summary.push({ name, code });
}
fs.writeFileSync(path.join(results, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('CORE REGRESSIONS ' + summary.filter(result => result.code === 0).length + '/' + summary.length);
process.exitCode = summary.every(result => result.code === 0) ? 0 : 1;
