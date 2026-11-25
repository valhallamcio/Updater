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
    { tag: 'same', name: 'Hand Updated', platform: 'gregtechnewhorizons', modpackID: 5, fileID: 50, newestFileID: 50, modpackVersion: '2.9.1' },
    { tag: 'ahead', name: 'Ahead Of CF', platform: 'gregtechnewhorizons', modpackID: 6, fileID: 60, newestFileID: 60, modpackVersion: '2.9.2' },
    { tag: 'odd', name: 'Odd Name', platform: 'curseforge', modpackID: 7, fileID: 70, newestFileID: 70, modpackVersion: '2.0' },
];
const webhooks = [];

stub('modules/yggdrasil.js', {
    getServers: async () => servers,
    updateServer: async (tag, fields) => { patches.push({ tag, ...fields }); },
});
stub('modules/curseforge.js', {
    getLatestVersionId: async (id) => ({ 4: 41, 5: 51, 6: 61, 7: 71 }[id] || 10),
    getPackData: async () => ({ logo: { url: 'https://example.com/logo.png' }, slug: 's' }),
});
stub('modules/modpacksch.js', {
    getCFPackManifest: async (id) => ({ 4: { name: 'Has Update 1.1.zip' }, 5: { name: 'GT New Horizons 2.9.1' }, 6: { name: 'GT-New-Horizons-2.9.1.zip' }, 7: { name: 'Odd Name' } }[id] || {}),
    getLatestFTBVersionId: async () => { throw new Error('ftb api down'); },
    getFTBPackManifest: async () => ({}),
    getFTBPackData: async () => ({ art: [{ url: 'x' }] }),
});
stub('discord/webhook.js', { sendWebhook: async (channel, payload) => { webhooks.push(payload.embeds[0].data.description); } });
stub('config/config.json', { discord: { active: true, staffChannelId: '' } });
stub('modules/sessionLogger.js', { info() {}, warn() {}, error() {}, debug() {} });

const functions = require('../modules/functions');
const { updateCheck } = require('../schedulers/checkForUpdates');

test('getVersion tolerates non-string input', () => {
    assert.strictEqual(functions.getVersion(undefined), null);
    assert.strictEqual(functions.getVersion(null), null);
    assert.strictEqual(functions.getVersion(42), null);
    assert.strictEqual(functions.getVersion('Pack v1.2.3.zip'), '1.2.3');
});

test('getVersion takes a version followed by punctuation', () => {
    assert.strictEqual(functions.getVersion('Fantasy MC Fabric 1.9.0: Holy Affairs'), '1.9.0');
    assert.strictEqual(functions.getVersion('Pack 1.2.0, beta'), '1.2.0');
    assert.strictEqual(functions.getVersion('Pack [1.4.0]'), '1.4.0');
    assert.strictEqual(functions.getVersion('Pack 1.0.3 (hotfix)'), '1.0.3');
    assert.strictEqual(functions.getVersion('Contained_Opolis-6.6'), '6.6');
    assert.strictEqual(functions.getVersion('Arcadia Shadowfall-v1.2.0'), '1.2.0');
    assert.strictEqual(functions.getVersion('GT-New-Horizons-2.9.1.zip'), '2.9.1');
    assert.strictEqual(functions.getVersion('GT-New-Horizons-2.9.1'), '2.9.1');
});

test('updateCheck skips unsupported platforms and survives per-server failures', async () => {
    const n = await updateCheck();
    assert.strictEqual(n, 2, 'the real update and the unreadable version are counted');
    assert.deepStrictEqual(patches, [
        { tag: 'ok', newestFileID: 10, requiresUpdate: false },
        { tag: 'upd', newestFileID: 41, requiresUpdate: true },
        { tag: 'same', newestFileID: 51, requiresUpdate: false, fileID: 51 },
        { tag: 'ahead', newestFileID: 61, requiresUpdate: false },
        { tag: 'odd', newestFileID: 71, requiresUpdate: true },
    ], 'unsupported/failed servers are never PATCHed; same version syncs fileID; an older file keeps fileID');
    assert.deepStrictEqual(webhooks, [
        'An update was detected for Has Update! (v1.0 -> v1.1)\n\nLearn more here: [Changelog](https://www.curseforge.com/minecraft/modpacks/s/files/41)',
        'An update was detected for Odd Name! (v2.0 -> vunknown)\n\nLearn more here: [Changelog](https://www.curseforge.com/minecraft/modpacks/s/files/71)',
    ], 'no staff alert for the same or an older version');
});
