const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Preload stubs so checkForUpdates binds them at require time (it destructures nothing,
// but holds module refs). Must run before the scheduler is required.
function stub(rel, exportsObj) {
    const p = require.resolve(path.join(__dirname, '..', rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

const patches = [];
const servers = [
    { tag: 'ok', name: 'OK Pack', platform: 'curseforge', modpackID: 1, fileID: 10, newestFileID: 10, modpackVersion: '1.0' },
    { tag: 'mecm', name: 'No Platform', platform: '', modpackID: 2, fileID: 20, newestFileID: 20, modpackVersion: '1.0' },
    { tag: 'boom', name: 'API Down', platform: 'feedthebeast', modpackID: 3, fileID: 30, newestFileID: 30, modpackVersion: '1.0' },
    { tag: 'upd', name: 'Has Update', platform: 'curseforge', modpackID: 4, fileID: 40, newestFileID: 40, modpackVersion: '1.0' },
];

stub('modules/yggdrasil.js', {
    getServers: async () => servers,
    updateServer: async (tag, fields) => { patches.push({ tag, ...fields }); },
});
stub('modules/curseforge.js', {
    getLatestVersionId: async (id) => (id === 4 ? 41 : 10),
    getPackData: async () => ({ logo: { url: 'x' }, slug: 's' }),
});
stub('modules/modpacksch.js', {
    getCFPackManifest: async (id, ver) => (id === 4 ? { name: 'Has Update 1.1.zip' } : {}),
    getLatestFTBVersionId: async () => { throw new Error('ftb api down'); },
    getFTBPackManifest: async () => ({}),
    getFTBPackData: async () => ({ art: [{ url: 'x' }] }),
});
stub('discord/webhook.js', { sendWebhook: async () => {} });
stub('config/config.json', { discord: { active: false, staffChannelId: '' } });
stub('modules/sessionLogger.js', { info() {}, warn() {}, error() {}, debug() {} });

const functions = require('../modules/functions');
const { updateCheck } = require('../schedulers/checkForUpdates');

test('getVersion tolerates non-string input', () => {
    assert.strictEqual(functions.getVersion(undefined), null);
    assert.strictEqual(functions.getVersion(null), null);
    assert.strictEqual(functions.getVersion(42), null);
    assert.strictEqual(functions.getVersion('Pack v1.2.3.zip'), '1.2.3');
});

test('updateCheck skips unsupported platforms and survives per-server failures', async () => {
    const n = await updateCheck();
    assert.strictEqual(n, 1, 'only the real update is counted');
    assert.deepStrictEqual(patches, [
        { tag: 'ok', newestFileID: 10, requiresUpdate: false },
        { tag: 'upd', newestFileID: 41, requiresUpdate: true },
    ], 'unsupported/failed servers are never PATCHed');
});
