// 客户端边界冒烟测试：**客户端不得以任何形式直接访问知识库全部内容**。
//
// 这条是硬约束，所以用测试钉住，而不是靠"记得别那么写"。
// 覆盖四层：
//   ① 服务端 /config.json 不再下发任何知识库地址
//   ② chat-app 的 /kb/* 只放行状态查询，其余一律 404
//   ③ 前端产物里不存在任何能跳出客户端的代码/元素（window.open、target=_blank、
//      指向 /kb/ 的链接、硬编码的 5178）
//   ④ 桌面端源码里不存在 shell.openExternal，且窗口打开策略是一律 deny
//
// 运行：node test/client-boundary-smoke.mjs
// 前置：chat-app 在 5190 运行（npm run chat）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'client');
const CHAT = process.env.CHAT_URL || 'http://127.0.0.1:5190';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 去掉注释再扫，避免把"解释为什么删掉"的注释本身当成违规代码。
// ⚠ HTML 与 JS 的注释语法不同，必须分开处理 ——
//   一开始只剥了 JS 注释，结果被删元素的**说明注释**触发了误报。
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

// ---------------------------------------------------------------- ① /config.json
console.log('\n── ① 服务端 /config.json ──');
try {
  const res = await fetch(`${CHAT}/config.json`, { signal: AbortSignal.timeout(8000) });
  const cfg = await res.json();
  check('/config.json 可取', res.ok, `HTTP ${res.status}`);
  check('kbLink 为空', cfg.kbLink === '', JSON.stringify(cfg.kbLink));
  check('kbBase 为空', cfg.kbBase === '', JSON.stringify(cfg.kbBase));
  check('不再下发知识库界面地址', !/5178/.test(JSON.stringify(cfg)), JSON.stringify(cfg).slice(0, 120));
} catch (err) {
  check('/config.json 可取', false, err.message);
}

// ---------------------------------------------------------------- ② /kb/* 代理面
console.log('\n── ② /kb/* 只放行状态查询 ──');
for (const p of ['/kb/', '/kb/api/query', '/kb/api/schema', '/kb/api/characters', '/kb/#/character/91']) {
  try {
    const r = await fetch(`${CHAT}${p}`, { signal: AbortSignal.timeout(8000) });
    // 知识库浏览界面与本体的数据接口都不该通
    check(`${p} 被挡住`, r.status === 404 || r.status === 403, `HTTP ${r.status}`);
  } catch (err) {
    check(`${p} 被挡住`, false, err.message);
  }
}

// ---------------------------------------------------------------- ③ 前端产物
console.log('\n── ③ 前端产物 ──');
{
  const html = stripHtmlComments(read('web/chat/index.html'));
  check('index.html 没有指向 /kb/ 的链接', !/href\s*=\s*["']\/kb/.test(html));
  check('index.html 没有 kb-link 元素', !/id\s*=\s*["']kb-link["']/.test(html));

  const app = stripJsComments(read('web/chat/app.js'));
  check('app.js 没有 window.open', !/window\.open/.test(app));
  check('app.js 没有 target="_blank"', !/target\s*=\s*["']_blank["']/.test(app));
  check('app.js 没有硬编码 5178', !/5178/.test(app));
  check('app.js 不再有 kbLink 概念', !/kbLink/.test(app));
  check('app.js 不再有 kbUrl()', !/function\s+kbUrl/.test(app));
  // 引用 chip 必须是无条件渲染成不可点的 span
  check('引用 chip 渲染为不可点 span', /src-plain/.test(app));
}

// ---------------------------------------------------------------- ④ 桌面端
console.log('\n── ④ 桌面端 ──');
{
  const main = stripJsComments(read('desktop/main.cjs'));
  check('main.cjs 没有 shell.openExternal', !/shell\.openExternal/.test(main));
  check('窗口打开策略为一律 deny', /setWindowOpenHandler\(\s*\(\s*\)\s*=>\s*\(\{\s*action:\s*'deny'/.test(main));
  check('views() 只有对话一个页签', /function views\(\)\s*\{\s*return\s*\{\s*chat:/.test(main));
  check('main.cjs 不再传 KB_WEB_URL', !/KB_WEB_URL/.test(main));
  check('main.cjs 不再传 KB_MODE', !/KB_MODE/.test(main));
  check('帮助菜单没有「打开知识库仓库」', !/打开知识库仓库/.test(main));
  // 启动页只能出现在「对话前端起不来」这一种故障里
  const launcherRefs = (main.match(/launcher\.html/g) || []).length;
  check('launcher.html 只用于真正的启动失败', launcherRefs <= 1, `${launcherRefs} 处引用`);
}

// ---------------------------------------------------------------- 结果
const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
if (failed) console.log('失败项：\n  - ' + results.filter((r) => !r.ok).map((r) => r.name).join('\n  - '));
process.exit(failed ? 1 : 0);
