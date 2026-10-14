'use strict';

function releaseSource(metadata = {}) {
  const owner = String(metadata.akashaUpdateOwner || '');
  const repo = String(metadata.akashaUpdateRepo || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo)) return null;
  return Object.freeze({ owner, repo, releases: `https://github.com/${owner}/${repo}/releases` });
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || [] } : null;
}
function newer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !!b.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined) return false;
    if (b.pre[i] === undefined) return true;
    const na = /^\d+$/.test(a.pre[i]), nb = /^\d+$/.test(b.pre[i]);
    if (na && nb) return Number(a.pre[i]) > Number(b.pre[i]);
    if (na !== nb) return !na;
    return a.pre[i] > b.pre[i];
  }
  return false;
}

function createUpdates({ packaged, portable, metadata, version, loadUpdater, fetchRelease = fetch, changed = () => {} }) {
  const source = releaseSource(metadata);
  let state = { phase: 'disabled', reason: '此构建未配置 GitHub Releases', source, portable: !!portable };
  let updater = null, checking = null;
  const set = (patch) => { state = { ...state, ...patch }; changed({ ...state }); return state; };
  if (!packaged) state.reason = '开发模式不检查更新';
  else if (source && portable) state = { ...state, phase: 'idle', reason: '便携版仅提示版本，不支持原地更新' };
  else if (source && metadata.akashaUpdateFormat === 'nsis') {
    try {
      updater = loadUpdater();
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = false;
      updater.setFeedURL({ provider: 'github', owner: source.owner, repo: source.repo });
      updater.on('update-available', (info) => set({ phase: 'downloading', version: info.version, reason: '发现新版，正在后台下载' }));
      updater.on('download-progress', (info) => set({ progress: Math.round(info.percent), reason: '正在后台下载更新' }));
      updater.on('update-not-available', () => set({ phase: 'current', reason: '当前已是最新版本' }));
      updater.on('update-downloaded', (info) => set({ phase: 'downloaded', version: info.version, progress: 100, reason: '新版已下载，可重启并更新' }));
      updater.on('error', () => set({ phase: 'error', reason: '更新检查或下载失败，请稍后重试' }));
      state = { ...state, phase: 'idle', reason: '安装版已启用 GitHub Releases 更新' };
    } catch { state.reason = '更新组件不可用，请重新安装完整客户端'; }
  } else if (source) state.reason = '此包型不支持安装版自动更新';

  async function performCheck() {
    if (state.phase === 'disabled' || state.phase === 'downloaded' || state.phase === 'downloading') return state;
    set({ phase: 'checking', reason: '正在检查更新' });
    try {
      if (portable) {
        const response = await fetchRelease(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error('release unavailable');
        const release = await response.json();
        const available = !release.draft && !release.prerelease && newer(release.tag_name, version);
        return set({ phase: available ? 'available' : 'current', version: available ? release.tag_name : version,
          reason: available ? '发现新版；便携版不支持原地更新' : '当前已是最新版本；便携版不支持原地更新' });
      }
      await updater.checkForUpdates();
      return state;
    } catch { return set({ phase: 'error', reason: '更新检查或下载失败，请稍后重试' }); }
  }
  return {
    get state() { return { ...state }; },
    check() { if (!checking) checking = performCheck().finally(() => { checking = null; }); return checking; },
    install() { if (state.phase !== 'downloaded' || portable || !updater) return false; updater.quitAndInstall(false, true); return true; },
  };
}
module.exports = { createUpdates, newer, releaseSource };
