import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdates, newer, releaseSource } = require('../client/desktop/updates.cjs');
const metadata = { akashaUpdateOwner: 'example', akashaUpdateRepo: 'akasha', akashaUpdateFormat: 'nsis' };
let passed = 0;
const ok = s => { passed++; console.log('PASS ' + s); };
class MockUpdater extends EventEmitter {
  installs = 0; checks = 0;
  setFeedURL(feed) { this.feed = feed; }
  async checkForUpdates() { this.checks++; }
  quitAndInstall() { this.installs++; }
}
for (const options of [{ packaged: false, metadata }, { packaged: true, metadata: {} }, { packaged: true, metadata: { ...metadata, akashaUpdateFormat: 'zip' } }]) {
  const updates = createUpdates({ ...options, version: '0.2.0', loadUpdater: () => { throw Error('must not load'); } });
  await updates.check(); assert.equal(updates.state.phase, 'disabled'); assert.equal(updates.install(), false);
}
ok('development, missing source and unsupported package never enable updater');
const updater = new MockUpdater();
const updates = createUpdates({ packaged: true, portable: false, metadata, version: '0.2.0', loadUpdater: () => updater });
assert.equal(updater.autoDownload, true); assert.equal(updater.autoInstallOnAppQuit, false);
assert.deepEqual(updater.feed, { provider: 'github', owner: 'example', repo: 'akasha' });
assert.equal(updates.install(), false);
await updates.check(); assert.equal(updater.checks, 1);
updater.emit('update-available', { version: '0.3.0' }); assert.equal(updates.state.phase, 'downloading');
updater.emit('download-progress', { percent: 42.4 }); assert.equal(updates.state.progress, 42);
updater.emit('update-downloaded', { version: '0.3.0' }); assert.equal(updates.state.phase, 'downloaded');
assert.equal(updater.installs, 0); assert.equal(updates.install(), true); assert.equal(updater.installs, 1);
ok('NSIS downloads in background and installs only after explicit restart action');
const failing = new MockUpdater();
const recover = createUpdates({ packaged: true, metadata, version: '0.2.0', loadUpdater: () => failing });
failing.emit('error', Error('private path or token must not propagate'));
assert.equal(recover.state.phase, 'error'); assert.doesNotMatch(recover.state.reason, /private|token/);
await recover.check(); failing.emit('update-not-available'); assert.equal(recover.state.phase, 'current');
ok('failed update can retry without leaking diagnostics');
let fetched = 0;
const portable = createUpdates({ packaged: true, portable: true, metadata, version: '0.2.0',
  loadUpdater: () => { throw Error('portable must not load downloader'); },
  fetchRelease: async () => { fetched++; return { ok: true, json: async () => ({ tag_name: 'v0.3.0' }) }; },
});
await portable.check(); assert.equal(fetched, 1); assert.equal(portable.state.phase, 'available');
assert.equal(portable.install(), false); assert.equal(portable.state.source.releases, 'https://github.com/example/akasha/releases');
ok('portable checks metadata only, exposes a copyable release page and cannot install');
assert.equal(newer('v0.3.0', '0.2.0'), true); assert.equal(newer('0.3.0-beta.1', '0.3.0'), false);
assert.equal(newer('0.3.0', '0.3.0-beta.1'), true); assert.equal(newer('0.3.0-beta.2', '0.3.0-beta.10'), false);
assert.equal(releaseSource({ akashaUpdateOwner: '../../private', akashaUpdateRepo: 'akasha' }), null);
ok('version and release-source parsing reject invalid values');
console.log(`Result: ${passed}/${passed} passed`);
