/* Akasha desktop: local authenticated /v1 + chat UI, optional user-configured cloud. */

const { app, BrowserWindow, Menu, shell, dialog, nativeImage, clipboard } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const IS_PACKAGED = app.isPackaged;
const PROJECT_ROOT = process.env.AKASHA_ROOT || (IS_PACKAGED ? app.getPath('userData') : path.resolve(__dirname, '..', '..'));
const userData = process.env.AKASHA_TEST_USER_DATA || process.env.AKASHA_USER_DATA || path.join(PROJECT_ROOT, 'userData');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
const temp = path.join(PROJECT_ROOT, 'temp');
fs.mkdirSync(temp, { recursive: true });
app.setPath('temp', temp);
process.env.TEMP = temp;
process.env.TMP = temp;
app.setAppLogsPath(path.join(PROJECT_ROOT, 'logs'));
const DESKTOP = __dirname;
function applicationVersion() {
  if (IS_PACKAGED) return app.getVersion();
  try { return JSON.parse(fs.readFileSync(path.resolve(DESKTOP, '..', '..', 'package.json'), 'utf8')).version; }
  catch { return 'development'; }
}
// 打包后：代码在 resources/app.asar，随包的 servers/web/data 被 extraResources
// 放到 resources/ 下（子进程没法从 asar 里跑，必须解出来当真实文件）。
// 开发时：就是 gen-suite 自己。
const RESOURCES = IS_PACKAGED ? process.resourcesPath : path.join(DESKTOP, '..');

// Runtime data and secrets are user-provided; no bundled service defaults.
let buildDefaultsFrom = '';
const BUILD_DEFAULTS = Object.freeze({});
let config = { kbDir: '', dataDir: process.env.KB_DATA_DIR || '', videoIndexPath: process.env.KB_VIDEO_INDEX_PATH || '', voiceAudioDir: '' };
let configFile = '';
let kbSource = '';          // '配置' | '包内' | '已释放到用户目录'
let kbProblem = '';         // 知识库不可用时的具体原因

/** 目录可写吗（知识库要写侧车库 kb-workspace.sqlite）。 */
function isWritable(dir) {
  try {
    const probe = path.join(dir, '.dsh-write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

/**
 * 决定知识库从哪跑。
 *
 * 打包后随包带了一份只读快照（resources/kb）。但知识库要写侧车库，所以：
 *   - 装到 Program Files / LocalAppData 的**安装版**：resources 目录可写，原地用
 *   - **便携版**：解压到临时目录，退出即删 —— 原地用会丢笔记，必须释放到用户目录
 * 换台电脑之所以"什么都用不了"，就是因为以前包里根本没有知识库。
 */
function resolveKbDir() {
  const candidate = config.kbDir || (IS_PACKAGED ? path.join(RESOURCES, 'engine') : path.join(PROJECT_ROOT, 'engine'));
  if (fs.existsSync(path.join(candidate, 'serve-client.mjs'))) { kbSource = config.kbDir ? '用户配置' : '默认引擎'; return candidate; }
  kbProblem = '未找到知识库引擎，请重新安装或配置 kbDir。';
  return '';
}

/**
 * 语音音频目录。和知识库同一套逻辑：
 * 用户配置有效就用它；否则用包内自带的；都没有则留空（语音不可用，界面优雅降级）。
 * —— 精简版不含音频，这条保证它不会因为 build-defaults 里写着构建机路径而报错。
 */
function resolveVoiceDir() {
  const cfgDir = config.voiceAudioDir;
  if (cfgDir && fs.existsSync(cfgDir)) return cfgDir;
  const bundled = path.join(RESOURCES, 'assets', 'voices-mp3');
  if (fs.existsSync(bundled)) return bundled;
  return cfgDir || '';
}

function resolvePaths() {
  if (!config.voiceAudioDir) {
    config.voiceAudioDir = process.env.VOICE_MP3_DIR || BUILD_DEFAULTS.voiceAudioDir || '';
  }
  config.kbDir = resolveKbDir();
  config.voiceAudioDir = resolveVoiceDir();

  // 客户端模式下 "本机没有知识库" 不是问题，是设计。
  // resolveKbDir() 会照常写一条 kbProblem（它只关心本机），
  // 不清掉的话界面会挂着「安装包内没有知识库，且没有配置外部知识库目录」——
  // 用户会以为软件坏了。
  if (String(process.env.AKASHA_TEST_V1 || config.kbRemoteV1 || '').trim()) kbProblem = '';

  // 把「这次到底连哪儿、用没用 token」落一份盘。
  // 排查「客户端连不上服务端」时，第一件事就是看这个文件 ——
  // 比翻日志快，而且用户也能自己打开看（帮助 → 打开配置文件夹）。
  // 注意：**不写 token 本身**，只写有没有。这个文件可能被贴到工单里。
  try {
    const rv1 = String(process.env.AKASHA_TEST_V1 || config.kbRemoteV1 || BUILD_DEFAULTS.kbRemoteV1 || '').trim();
    const tk = String(process.env.KB_CLIENT_TOKEN || config.kbToken || BUILD_DEFAULTS.kbToken || '');
    const dump = {
      模式: rv1 ? '客户端（连远端）' : '本地（自带知识库）',
      构建默认值来自: buildDefaultsFrom || '(没加载到任何一份)',
      '远端 /v1': rv1 || '(未配置)',
      已注入客户端token: !!tk,
      本机知识库目录: config.kbDir || '(无)',
      本机语音目录: config.voiceAudioDir || '(无)',
      页签: Object.keys(views()).join(', '),
      知识库不可用原因: kbProblem || '(无)',
      生成时间: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(app.getPath('userData'), 'resolved.json'),
      JSON.stringify(dump, null, 2), 'utf8');
  } catch { /* 写不了就算了，不影响启动 */ }
}

const PORTS = { v1: Number(process.env.AKASHA_V1_PORT || 5180), chat: Number(process.env.AKASHA_TEST_CHAT_PORT || 5190) };

/**
 * 界面上那几个页签指向哪。
 *
 * ⚠ 只有「对话」。
 *
 *   「知识库」和「故事线」指向的是知识库本体界面 —— 那是一条绕过 /v1 的路：
 *   不经过 token、不记配额、不做引用审计，点开就能把整个库翻一遍，
 *   和「知识库不落地、不整库暴露」直接冲突。
 *
 *   以前这两个只在客户端模式摘掉、本地模式保留（当内测入口用）。
 *   但那意味着**同一份客户端在不同模式下暴露面不同**，而客户拿到的是哪个模式
 *   取决于配置文件 —— 一个改配置就破的约束不叫约束。
 *   现在无论什么模式都只有「对话」。
 *
 * 自己要翻知识库，用浏览器打开 http://127.0.0.1:5178 —— 那是你的机器，
 * 不该是客户端界面里的入口。
 */
function views() {
  return {
    chat: { label: '对话', url: `http://127.0.0.1:${PORTS.chat}/` },
  };
}

/**
 * 「客户端模式」：本机不带知识库，连远端的 /v1 服务。
 * 和「本地模式」（resources/kb 里带一份完整知识库、由本程序自己拉起）互斥。
 *
 *   本机有知识库  → 本地模式：起 kb(5178) + voice(5188) + chat(5190)，全离线
 *   配了 kbRemote → 客户端模式：只起 chat(5190)，让它把请求转发到远端
 *
 * 商业发行走客户端模式（知识库不落地到用户机器上）；
 * 你自己演示/内测用本地模式。
 */
function remoteV1() {
  const u = String(process.env.AKASHA_TEST_V1 || config.kbRemoteV1 || BUILD_DEFAULTS.kbRemoteV1 || '').trim();
  return u ? u.replace(/\/+$/, '') : '';
}

/** 备选 /v1 地址（配置里可以是数组，也可以写单个字符串）。 */
function remoteV1Fallbacks() {
  if (process.env.AKASHA_TEST_V1) return [];
  const v = config.kbRemoteV1Fallbacks || [];
  return (Array.isArray(v) ? v : [v])
    .map((s) => String(s || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** 本次实际使用的 /v1 地址（由 pickRemote 决定）。 */
let remoteV1Picked = '';

/**
 * 启动时挑一个能连上的 /v1 地址。
 *
 * 为什么要有备选：知识库跑在**你的**机器上，客户端连的是局域网地址 ——
 * 路由器换租约、网卡重连、换个网络环境，地址都可能变。
 * 只写死一个的话，一变所有已经发出去的客户端就全废了（得重新发包）。
 *
 * 所以：主地址写**机器名**（IP 怎么变都不受影响），备选写当前 IP
 * （兜住"某些局域网名称解析不通"的情况）。谁先响应就用谁。
 * 都不通也照常返回第一个 —— 界面照开，左下角显示「未连接」，
 * 而不是把用户丢在一个"打不开"的页面上。
 */
async function pickRemote() {
  const list = [remoteV1(), ...remoteV1Fallbacks()].filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) { remoteV1Picked = list[0]; return list[0]; }
  for (const u of list) {
    try {
      const r = await fetch(`${u}/health`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) { log(`/v1 探到可用地址：${u}`); remoteV1Picked = u; return u; }
      log(`/v1 无响应（HTTP ${r.status}）：${u}`);
    } catch (err) {
      log(`/v1 连不上：${u}（${err.message}）`);
    }
  }
  log(`/v1 全部地址都不通，先用第一个：${list[0]}`);
  remoteV1Picked = list[0];
  return list[0];
}

/** 远端知识库本体（浏览器界面用的那个，5178）。没配就从 /v1 的地址猜。 */
function services() {
  const serversDir = path.join(RESOURCES, 'servers');
  // 用 boot() 探测出来的那个地址，不是配置里的原始值 —— 备选命中时两者不同
  const rV1 = remoteV1Picked || remoteV1();
  const list = [];

  // 客户端模式下不起知识库 —— 它不在本机，也**不该**在用户机器上
  if (!rV1) {
    list.push({
      key: 'v1', port: PORTS.v1, name: '知识库接口',
      script: path.join(config.kbDir, 'serve-client.mjs'), args: [], cwd: config.kbDir,
      env: {
        KB_CLIENT_PORT: String(PORTS.v1), KB_CLIENT_HOST: '127.0.0.1',
        KB_DATA_DIR: config.dataDir || path.join(PROJECT_ROOT, 'data'),
        KB_MEDIA_CACHE: path.join(PROJECT_ROOT, 'cache', 'media'),
        KB_LLM_CONFIG_PATH: path.join(app.getPath('userData'), 'llm.config.json'),
        ...(config.videoIndexPath ? { KB_VIDEO_INDEX_PATH: config.videoIndexPath } : {}),
        ...(String(process.env.KB_CLIENT_TOKEN || config.kbToken || '') ? { KB_CLIENT_TOKEN: String(process.env.KB_CLIENT_TOKEN || config.kbToken || '') } : {}),
      },
      hint: '找不到知识库引擎；请配置 kbDir，或重新安装完整客户端。',
    });
  }

  list.push({
    key: 'chat', port: PORTS.chat, name: '对话前端',
    script: path.join(serversDir, 'chat-app.mjs'), args: ['--port', String(PORTS.chat)],
    cwd: RESOURCES,
    // 客户端模式：让 chat-app 把 /v1 转发到远端。
    // chat-app.mjs 认 KB_V1_UPSTREAM；token 由这里注入 ——
    // 用户不该为了用桌面端去手抄一串客户端 token。
    //
    // ⚠ 以前这里还传 KB_MODE / KB_WEB_URL，用来决定「引用 chip 能不能点」。
    //   那条通道已整个删掉：引用**恒不可点**（见 servers/chat-app.mjs 的 /config.json）。
    //   所以这里不再有任何能开启知识库界面的开关 —— 少一个开关就少一条绕过路径。
    // token **两种模式都注入**（有就注入）。
    //
    // ⚠ 以前只在客户端模式注入，本地模式下 chat-app 拿不到 token ——
    //   而 /v1 默认是**要求鉴权**的（serve-client 的 AUTH_OFF 默认不成立），
    //   于是本地模式表现为「界面能开、一问就 401 缺少 Authorization」。
    //
    // ⚠ 也**不要**图省事给 /v1 加 KB_CLIENT_AUTH=off：5180 同时是反向隧道的
    //   落点，关掉鉴权等于把公网入口敞开。这里是注入 token，不是取消鉴权。
    env: {
      KB_V1_UPSTREAM: rV1 || `http://127.0.0.1:${PORTS.v1}`,
      ...(String(process.env.KB_CLIENT_TOKEN || config.kbToken || BUILD_DEFAULTS.kbToken || '')
        ? { KB_CLIENT_TOKEN: String(process.env.KB_CLIENT_TOKEN || config.kbToken || BUILD_DEFAULTS.kbToken || '') }
        : {}),
    },
    hint: '未找到对话前端，请重新安装完整客户端。',
  });

  return list;
}

/** 本次由桌面版拉起来的服务，退出时负责收掉 */
const startedByUs = new Map();
let win = null;
let stateFile = null;

// 自动化测试用：DESKTOP_DEBUG_PORT=9340 时开 Chromium 调试端口。
// 走 appendSwitch 而不是命令行传参 —— 后者在 Electron 里不一定被转发给 Chromium。
if (process.env.DESKTOP_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.DESKTOP_DEBUG_PORT));
}

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function waitPort(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await sleep(250);
  }
  return false;
}

function startService(svc) {
  if (!fs.existsSync(svc.script)) {
    return { ok: false, error: svc.hint || `找不到 ${svc.script}` };
  }
  const child = spawn(process.execPath, [svc.script, ...svc.args], {
    cwd: svc.cwd,
    // 让 electron.exe 当纯 Node 跑，不依赖用户另装 node
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(svc.env || {}) },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => log(`${svc.name} 启动失败: ${err.message}`));
  child.on('exit', (code) => {
    if (startedByUs.has(svc.key)) log(`${svc.name} 退出了（code ${code}）`);
  });
  startedByUs.set(svc.key, child);
  return { ok: true };
}

function log(msg) {
  process.stdout.write(`[desktop] ${msg}\n`);
}

const { createUpdates } = require('./updates.cjs');
let updateState = null;
async function showUpdateStatus() {
  if (!updateState) scheduleUpdateCheck();
  await updateState.check();
  const status = updateState.state;
  if (status.phase === 'downloaded') {
    const result = await dialog.showMessageBox(win, { type: 'info', title: '更新',
      message: '新版 ' + status.version + ' 已下载', buttons: ['重启并更新', '稍后'], defaultId: 1, cancelId: 1 });
    if (result.response === 0) updateState.install();
  } else {
    const canCopy = status.portable && status.source;
    const result = await dialog.showMessageBox(win, { type: 'info', title: '更新',
      message: status.reason, detail: status.phase === 'available' ? '新版 ' + status.version + '\n' + status.source.releases : '',
      buttons: canCopy ? ['复制发布页地址', '关闭'] : ['关闭'] });
    if (canCopy && result.response === 0) clipboard.writeText(status.source.releases);
  }
}
function scheduleUpdateCheck() {
  if (updateState) return;
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')); } catch {}
  updateState = createUpdates({ packaged: IS_PACKAGED, portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
    metadata, version: applicationVersion(), loadUpdater: () => require('electron-updater').autoUpdater,
    changed: (status) => {
      if (status.phase === 'downloaded') dialog.showMessageBox(win, { type: 'info', title: '更新已下载',
        message: '新版 ' + status.version + ' 已下载，可通过帮助菜单重启并更新。', buttons: ['好'] });
      if (status.portable && status.phase === 'available') dialog.showMessageBox(win, { type: 'info', title: '发现新版',
        message: '新版 ' + status.version + ' 可用。便携版不支持原地更新。',
        detail: status.source.releases, buttons: ['复制发布页地址', '稍后'], cancelId: 1
      }).then(({ response }) => { if (response === 0) clipboard.writeText(status.source.releases); });
    },
  });
  if (updateState.state.phase !== 'disabled') setTimeout(() => updateState.check(), 8000);
}

// ---------------------------------------------------------------- 窗口状态

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { return {}; }
}
function saveState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized(),
    }));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 主窗口

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    x: st.x, y: st.y,
    width: st.width || 1200,
    height: st.height || 840,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Akasha',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(DESKTOP, 'preload.cjs'),
    },
  });

  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.env.AKASHA_TEST_HIDDEN) win.show(); });

  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', saveState);

  // 启动页点击跳过
  const { ipcMain } = require('electron');
  ipcMain.removeAllListeners('boot:skip');
  ipcMain.on('boot:skip', () => { skipRequested = true; });

  // 外链与导航一律封死。
  //
  // ⚠ 这里以前是「回环地址允许开新窗，其它交给系统浏览器」——
  //   而知识库本体（5178）**恰好就在回环里**，所以那条规则等于给它留了后门：
  //   只要界面上出现一个指向 5178 的链接，就能开出一个完整的知识库浏览器窗口。
  //
  //   现在：不新开窗、不跳转、不交给系统浏览器。界面只能停在对话前端。
  //   将来确有需要放外链（比如官网），在下面加**显式白名单**，
  //   不要图省事放开整个回环段。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, url) => {
    // 只允许停在对话前端的同源地址（hash 变化不走这个事件，不受影响）
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === new URL(`http://127.0.0.1:${PORTS.chat}`).origin;
    } catch { /* URL 非法 => 一律拦掉 */ }
    if (!sameOrigin) ev.preventDefault();
  });

  return win;
}

function goto(viewKey) {
  const V = views();
  const v = V[viewKey];
  if (!v || !win || win.isDestroyed()) return;
  win.loadURL(v.url);
  win.setTitle(`Akasha · ${v.label}`);
}

// ---------------------------------------------------------------- 菜单

function buildMenu() {
  const V = views();
  const nav = Object.keys(V).map((k, i) => ({
    label: `${V[k].label}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => goto(k),
  }));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => { goto('chat'); win.webContents.executeJavaScript('document.getElementById("new")?.click()').catch(() => {}); } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    { label: '导航', submenu: nav },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开配置文件夹', click: () => shell.showItemInFolder(configFile) },
        {
          label: '检查更新 / 重启并更新', click: () => showUpdateStatus(),
        },
        // ⚠ 这里原有两个入口已删除：
        //   「打开知识库仓库」—— 在资源管理器里直接打开知识库目录，
        //     等于把整个库（含 sqlite、立绘、整理成果）摆到用户面前，
        //     比一个 URL 更彻底地绕过了「客户端不得直接访问知识库全部内容」。
        //   「打开语音音频目录」—— 语音包已按米哈游同人指引隔离，不随客户端分发。
        { type: 'separator' },
        {
          label: '关于',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: 'Akasha',
            detail: [
              `版本 ${applicationVersion()} · Electron ${process.versions.electron}`,
              '',
              // 运维视角的信息（知识库地址/目录、语音服务）不上「关于」页：
              // 客户不关心后面接着什么，这些路径也不该出现在客户界面上。
              `更新：${updateState?.state.reason || '初始化中'}`,
              IS_PACKAGED ? '（打包版）' : '（开发模式）',
            ].join('\n'),
            buttons: ['好'],
          }),
        },
      ],
    },
  ]));
}

// ---------------------------------------------------------------- 配置

function loadConfig() {
  configFile = path.join(app.getPath('userData'), 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (raw && typeof raw === 'object') config = { ...config, ...raw };
  } catch { /* 首次运行或文件损坏：用默认值 */ }
  resolvePaths();
  // 首次运行把解析结果落盘，方便用户直接改
  if (!fs.existsSync(configFile)) saveConfig();
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({
      _说明: '知识库与语音音频不随安装包分发，这里指定它们在本机的位置。改完重启应用生效。',
      kbDir: '',
      kbRemoteV1: config.kbRemoteV1 || '',
      kbRemoteV1Fallbacks: config.kbRemoteV1Fallbacks || [],
      dataDir: config.dataDir,
      videoIndexPath: config.videoIndexPath,
      voiceAudioDir: config.voiceAudioDir,
    }, null, 2));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 启动流程

async function boot() {
  stateFile = path.join(app.getPath('userData'), 'window-state.json');
  loadConfig();
  createWindow();
  buildMenu();

  // 先把 /v1 的目标地址定下来（主地址不通就试备选），再起服务 ——
  // services() 要拿这个结果注入 KB_V1_UPSTREAM。
  await pickRemote();

  // ── 统一启动：**不要启动页**，直接进聊天界面 ──────────────────────────
  //
  // 以前分两条路：
  //   客户端模式 → 直接进聊天
  //   本地模式   → 先走启动页（起服务逐项推进 → 拉七神立绘 → 最短停留 6.5 秒 → 才进聊天）
  //
  // 后果是同一个客户端"看起来像两个产品"，而且本地模式下任何一项没就绪就停在
  // 失败页（「知识库没有响应」）。对客户来说那就是"这软件装坏了"—— 可实际上
  // 界面完全能用，只是那一项暂时没起来。
  //
  // 现在只有一条路：起服务 → 等对话前端 → **立刻进聊天**。
  // 知识库/远端连不上的事交给聊天界面自己表达（左下角状态灯 + 可读的错误提示），
  // 不再用一整页拦人。
  //
  // ⚠ startServices 不能省：早先这里直接去 waitPort(5190) 而没启动它，
  //    结果永远等不到 —— 表现是"程序开着但界面不动"。
  const problems = await startServices(null);
  const chatReady = await waitPort(PORTS.chat, 30000);

  if (!chatReady) {
    // ⚠ 只有「本地对话前端起不来」才用失败页 —— 那是真的坏了（安装包不完整）。
    //    知识库/远端不通**不走这里**，它们不该拦人。
    await win.loadFile(path.join(DESKTOP, 'launcher.html'));
    await showBootFailure([
      `• 本地对话前端（端口 ${PORTS.chat}）没起来 —— 安装包可能不完整，重新安装试试`,
      ...problems.map((p) => '• ' + String(p).replace(/\n/g, '<br>&nbsp;&nbsp;')),
    ]);
    return;
  }

  // 有服务没起来也照样进界面：日志里留一份，界面上由状态灯表达
  if (problems.length) log(`部分服务未启动（不影响界面打开）：${problems.join(' | ')}`);
  goto('chat');
}

/**
 * 起本机需要的那几个服务，返回失败原因列表。
 *
 * onStage 传 stage 时就推进启动页；客户端模式没有启动页，传 null。
 * 两种模式共用这段 —— 早先在客户端分支里漏了调用，
 * 表现是"程序开着、界面不动、5190 根本没起来"。
 */
async function startServices(onStage) {
  const problems = [];
  let step = 0;
  for (const svc of services()) {
    const wasUp = await portOpen(svc.port);
    if (onStage) onStage(svc.key, 'doing', `正在${wasUp ? '连接' : '启动'}${svc.name}…`, 10 + step * 20);
    if (wasUp) {
      log(`${svc.name} 已在 ${svc.port} 运行，复用`);
    } else {
      log(`启动 ${svc.name}（${svc.script}）`);
      const r = startService(svc);
      if (!r.ok) problems.push(`${svc.name}：${r.error}`);
    }
    if (await waitPort(svc.port, 12000)) {
      if (onStage) onStage(svc.key, 'done', `${svc.name}已就绪`, 10 + step * 20 + 18);
    } else {
      if (onStage) onStage(svc.key, 'doing', `${svc.name}未响应`, 10 + step * 20 + 18);
      problems.push(`${svc.name}：端口 ${svc.port} 未在 12 秒内就绪`);
    }
    step++;
  }
  return problems;
}

/**
 * 真的起不来时才显示这个。**客户端模式不该走到这里** ——
 * 那边连不上服务端是「暂时用不了」，不是「软件坏了」，
 * 由聊天界面自己表达（左下角有「未连接」指示灯）。
 */
async function showBootFailure(lines) {
  if (!win || win.isDestroyed()) return;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <html><body style="background:#0e1620;color:#ece5d8;font:14px/1.8 'Microsoft YaHei',system-ui;padding:44px;max-width:780px">
    <h2 style="margin:0 0 14px">启动失败</h2>
    <p style="margin:0 0 20px;line-height:2">${lines.join('<br>')}</p>
    <p>请检查配置或重新安装完整客户端。</p>
    <p style="color:#93a4b3">改配置：菜单「帮助 → 打开配置文件夹」，编辑 config.json 后重启应用。<br>
    如果是安装包不完整，请重新下载安装。</p>
    <p><button onclick="location.reload()" style="padding:7px 16px;border-radius:9px;border:1px solid rgba(211,188,142,.45);background:rgba(211,188,142,.14);color:#ffe6b0;cursor:pointer">重试</button></p>
    </body></html>`));
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => { await boot(); scheduleUpdateCheck(); });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    // 只收掉本次拉起来的，不动用户自己开的
    for (const [key, child] of startedByUs) {
      try { child.kill(); log(`已停止 ${key}`); } catch { /* ignore */ }
    }
    startedByUs.clear();
  });
}
