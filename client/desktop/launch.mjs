/* 桌面版启动器 —— 从任何环境可靠地拉起 Electron。
 *
 *   node desktop/launch.mjs [--foreground] [--debug-port 9340]
 *
 * 为什么需要它：DSH 自己就是 Electron 应用，它给子进程注入了
 * ELECTRON_RUN_AS_NODE=1。带着这个变量启动 electron.exe 会退化成「纯 Node」，
 * 表现是 require('electron') 拿不到 API、窗口根本不出现（且因为是 GUI 子系统
 * 程序，stdout 也抓不到，排查起来很费劲）。
 * 这里显式删掉该变量，并补上 Electron 需要的其它开关。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.join(HERE, '..');

const argv = process.argv.slice(2);
const foreground = argv.includes('--foreground');
const iDebug = argv.indexOf('--debug-port');
const debugPort = iDebug >= 0 ? argv[iDebug + 1] : null;

const CANDIDATES = [
  path.join(SUITE, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.join(SUITE, 'node_modules', 'electron', 'dist', 'electron'),
];
const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('找不到 Electron 运行时。请先执行：  npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;          // ← 关键
if (debugPort) env.DESKTOP_DEBUG_PORT = String(debugPort);

const args = [SUITE];
if (debugPort) args.push(`--remote-debugging-port=${debugPort}`);

const child = spawn(exe, args, {
  cwd: SUITE,
  env,
  stdio: foreground ? 'inherit' : 'ignore',
  detached: !foreground,
});

if (!foreground) {
  child.unref();
  console.log('已启动「原神知识库 · 桌面版」');
  console.log(`  Electron: ${exe}`);
  if (debugPort) console.log(`  调试端口: ${debugPort}`);
} else {
  child.on('exit', (code) => process.exit(code === null ? 0 : code));
}
