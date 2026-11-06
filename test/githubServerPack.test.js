/*
 * Unit tests for modules/githubServerPack.js and updateManager's githubServerPacks().
 * Run: npm test   (node --test test/*.test.js)
 *
 * Every GitHub and CurseForge call goes to a fake passed in as a parameter.
 * Nothing here may reach api.github.com.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gh = require('../modules/githubServerPack');
const { _internals } = require('../managers/updateManager');

const REPO = 'TerraFirmaGreg-Team/Modpack-Modern';
const SOURCE = { type: 'github', repo: REPO, asset: '-serverpack\\.zip$' };
const api = (tag) => `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`;

/** A release shaped like TFG's: one serverpack zip next to the client builds. */
function tfgRelease(tag, assetNames) {
    const names = assetNames || [
        `TerraFirmaGreg-Modern-${tag}-curseforge.zip`,
        `TerraFirmaGreg-Modern-${tag}-docker.yml`,
        `TerraFirmaGreg-Modern-${tag}-modrinth.mrpack`,
        `TerraFirmaGreg-Modern-${tag}-multimc.zip`,
        `TerraFirmaGreg-Modern-${tag}-serverpack.zip`
    ];
    return {
        tag_name: tag,
        draft: false,
        prerelease: false,
        assets: names.map((name, i) => ({
            name,
            size: 1000 + i,
            browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}`
        }))
    };
}

/** axios-like fake: known URLs answer, everything else is a 404 unless listed in `fail`. */
function http(routes = {}, fail = {}) {
    return {
        calls: [],
        async get(url) {
            this.calls.push(url);
            if (url in fail) {
                const error = new Error(`Request failed with status code ${fail[url]}`);
                error.response = { status: fail[url] };
                throw error;
            }
            if (url in routes) return { data: routes[url] };
            const error = new Error('Request failed with status code 404');
            error.response = { status: 404 };
            throw error;
        }
    };
}

/** CurseForge fake: file data by file id. */
function curseforge(files) {
    return {
        calls: [],
        async getFileData(modPackId, fileId) {
            this.calls.push([modPackId, fileId]);
            return files[fileId] || null;
        }
    };
}

const tfgmPack = {
    tag: 'tfgm',
    modpackID: 385053,
    fileID: 9273503,
    newestFileID: 9340476
};
const tfgmFiles = {
    9273503: { displayName: 'TerraFirmaGreg-Modern-0.13.15', fileName: 'TerraFirmaGreg-Modern-0.13.15-curseforge.zip' },
    9340476: { displayName: 'TerraFirmaGreg-Modern-0.13.17', fileName: 'TerraFirmaGreg-Modern-0.13.17-curseforge.zip' }
};

function collector() {
    const log = { text: '' };
    log.report = async (line) => { log.text += line; };
    return log;
}

test('versionFromName takes the last x.y.z with an optional letter suffix', () => {
    assert.strictEqual(gh.versionFromName('TerraFirmaGreg-Modern-0.13.15'), '0.13.15');
    assert.strictEqual(gh.versionFromName('Pack-1.20.1-0.13.15'), '0.13.15');
    assert.strictEqual(gh.versionFromName('Pack 1.20.1 - 2.4.0.zip'), '2.4.0');
    assert.strictEqual(gh.versionFromName('GregTech-Odyssey-0.5.6-beta.zip'), '0.5.6-beta');
    assert.strictEqual(gh.versionFromName('Pack 1.0.0-rc.2'), '1.0.0-rc.2');
    assert.strictEqual(gh.versionFromName('TerraFirmaGreg-Modern-0.13.15-curseforge.zip'), '0.13.15-curseforge');
});

test('versionFromName gives null when there is no plain x.y.z', () => {
    assert.strictEqual(gh.versionFromName('Pack v2'), null);
    assert.strictEqual(gh.versionFromName('Pack 1.2'), null);
    assert.strictEqual(gh.versionFromName('Pack 1.2.3.4'), null);
    assert.strictEqual(gh.versionFromName(undefined), null);
});

test('versionOfFile prefers the displayName and falls back to the fileName', () => {
    assert.strictEqual(gh.versionOfFile(tfgmFiles[9273503]), '0.13.15');
    assert.strictEqual(gh.versionOfFile({ displayName: 'Latest build', fileName: 'Pack-2.0.1.zip' }), '2.0.1');
    assert.strictEqual(gh.versionOfFile({ displayName: 'Latest build', fileName: 'pack.zip' }), null);
    assert.strictEqual(gh.versionOfFile(null), null);
});

test('sourceFor reads the server doc field first, then the config map by tag', () => {
    const config = { serverPackSources: { tfgm: SOURCE } };
    const docSource = { type: 'github', repo: 'a/b', asset: 'x' };
    assert.strictEqual(gh.sourceFor({ tag: 'tfgm', serverPackSource: docSource }, config), docSource);
    assert.strictEqual(gh.sourceFor({ tag: 'tfgm' }, config), SOURCE);
    assert.strictEqual(gh.sourceFor({ tag: 'atm10' }, config), null);
    assert.strictEqual(gh.sourceFor({ tag: 'tfgm' }, {}), null);
});

test('parseSource rejects a wrong type, a bad repo and a bad pattern', () => {
    assert.deepStrictEqual(gh.parseSource(SOURCE).repo, REPO);
    assert.throws(() => gh.parseSource({ ...SOURCE, type: 'gitlab' }), /type must be "github"/);
    assert.throws(() => gh.parseSource({ ...SOURCE, repo: 'no-slash' }), /owner\/name/);
    assert.throws(() => gh.parseSource({ ...SOURCE, repo: '../x/y' }), /owner\/name/);
    assert.throws(() => gh.parseSource({ ...SOURCE, asset: '' }), /no asset pattern/);
    assert.throws(() => gh.parseSource({ ...SOURCE, asset: '(' }), /not a valid regex/);
    assert.throws(() => gh.parseSource(null), /type must be "github"/);
});

test('pickAsset picks the single matching asset', () => {
    const asset = gh.pickAsset(tfgRelease('0.13.17'), /-serverpack\.zip$/);
    assert.strictEqual(asset.name, 'TerraFirmaGreg-Modern-0.13.17-serverpack.zip');
});

test('pickAsset throws on no match and on more than one match', () => {
    const noServer = tfgRelease('0.13.17', ['TerraFirmaGreg-Modern-0.13.17-curseforge.zip']);
    assert.throws(() => gh.pickAsset(noServer, /-serverpack\.zip$/), /has no asset matching/);
    const two = tfgRelease('0.13.17', ['a-serverpack.zip', 'b-serverpack.zip']);
    assert.throws(() => gh.pickAsset(two, /-serverpack\.zip$/), /has 2 assets matching/);
});

test('findRelease asks for the exact tag first', async () => {
    const client = http({ [api('0.13.17')]: tfgRelease('0.13.17') });
    const release = await gh.findRelease(REPO, '0.13.17', client);
    assert.strictEqual(release.tag_name, '0.13.17');
    assert.deepStrictEqual(client.calls, [api('0.13.17')]);
});

test('findRelease falls back to the v-prefixed tag', async () => {
    const client = http({ [api('v0.13.17')]: tfgRelease('v0.13.17') });
    const release = await gh.findRelease(REPO, '0.13.17', client);
    assert.strictEqual(release.tag_name, 'v0.13.17');
    assert.deepStrictEqual(client.calls, [api('0.13.17'), api('v0.13.17')]);
});

test('findRelease never takes a release with another tag', async () => {
    const client = http({ [api('0.13.17')]: tfgRelease('0.13.16') });
    await assert.rejects(gh.findRelease(REPO, '0.13.17', client), /no release tagged 0\.13\.17 or v0\.13\.17/);
});

test('findRelease throws when neither tag exists', async () => {
    const client = http({ [api('0.13.16')]: tfgRelease('0.13.16') });
    await assert.rejects(gh.findRelease(REPO, '0.13.17', client), /no release tagged 0\.13\.17 or v0\.13\.17/);
});

test('findRelease stops on a GitHub error other than 404', async () => {
    const client = http({ [api('v0.13.17')]: tfgRelease('v0.13.17') }, { [api('0.13.17')]: 403 });
    await assert.rejects(gh.findRelease(REPO, '0.13.17', client), /failed \(403\)/);
    assert.deepStrictEqual(client.calls, [api('0.13.17')]);
});

test('resolve returns the asset url for the exact version', async () => {
    const client = http({ [api('0.13.15')]: tfgRelease('0.13.15') });
    const found = await gh.resolve(SOURCE, '0.13.15', client);
    assert.strictEqual(found.tag, '0.13.15');
    assert.strictEqual(found.name, 'TerraFirmaGreg-Modern-0.13.15-serverpack.zip');
    assert.strictEqual(found.url, `https://github.com/${REPO}/releases/download/0.13.15/TerraFirmaGreg-Modern-0.13.15-serverpack.zip`);
});

test('githubServerPacks resolves both TFGM sides from the CurseForge display names', async () => {
    const client = http({
        [api('0.13.15')]: tfgRelease('0.13.15'),
        [api('0.13.17')]: tfgRelease('0.13.17')
    });
    const cf = curseforge(tfgmFiles);
    const log = collector();
    const found = await _internals.githubServerPacks(tfgmPack, SOURCE, log.report, { curseforge: cf, http: client });
    assert.strictEqual(found.newest.name, 'TerraFirmaGreg-Modern-0.13.17-serverpack.zip');
    assert.strictEqual(found.current.name, 'TerraFirmaGreg-Modern-0.13.15-serverpack.zip');
    assert.deepStrictEqual(cf.calls, [[385053, 9340476], [385053, 9273503]]);
    assert.doesNotMatch(log.text, /Aborting/);
});

test('githubServerPacks aborts when the current version has no release', async () => {
    const client = http({ [api('0.13.17')]: tfgRelease('0.13.17') });
    const log = collector();
    const found = await _internals.githubServerPacks(tfgmPack, SOURCE, log.report, { curseforge: curseforge(tfgmFiles), http: client });
    assert.strictEqual(found, null);
    assert.match(log.text, /no release tagged 0\.13\.15 or v0\.13\.15\. Aborting update, nothing was touched\./);
});

test('githubServerPacks aborts when the release has no matching asset', async () => {
    const client = http({ [api('0.13.17')]: tfgRelease('0.13.17', ['TerraFirmaGreg-Modern-0.13.17-curseforge.zip']) });
    const log = collector();
    const found = await _internals.githubServerPacks(tfgmPack, SOURCE, log.report, { curseforge: curseforge(tfgmFiles), http: client });
    assert.strictEqual(found, null);
    assert.match(log.text, /has no asset matching .*Aborting update/);
});

test('githubServerPacks aborts before GitHub when a version cannot be read', async () => {
    const client = http();
    const files = { ...tfgmFiles, 9340476: { displayName: 'Latest build', fileName: 'pack.zip' } };
    const log = collector();
    const found = await _internals.githubServerPacks(tfgmPack, SOURCE, log.report, { curseforge: curseforge(files), http: client });
    assert.strictEqual(found, null);
    assert.match(log.text, /Could not read a version from CurseForge file 9340476 \(`Latest build`\)\. Aborting update/);
    assert.deepStrictEqual(client.calls, []);
});

test('githubServerPacks aborts when CurseForge returns no file data', async () => {
    const log = collector();
    const found = await _internals.githubServerPacks(tfgmPack, SOURCE, log.report, { curseforge: curseforge({}), http: http() });
    assert.strictEqual(found, null);
    assert.match(log.text, /Could not read a version from CurseForge file 9340476\. Aborting update/);
});

test('githubServerPacks aborts on a bad source without calling anything', async () => {
    const cf = curseforge(tfgmFiles);
    const client = http();
    const log = collector();
    const found = await _internals.githubServerPacks(tfgmPack, { ...SOURCE, repo: 'nope' }, log.report, { curseforge: cf, http: client });
    assert.strictEqual(found, null);
    assert.match(log.text, /Bad server pack source for tfgm: .*Aborting update/);
    assert.deepStrictEqual(cf.calls, []);
    assert.deepStrictEqual(client.calls, []);
});

/*
 * The CF backup and wipe lists keep only the names each instance root has. The TFGM
 * GitHub server pack ships start scripts and jars live TFGM never had.
 */

/** Panel fake: listFiles answers from a queue of root listings per instance. */
function panel(listings) {
    return {
        calls: [],
        async listFiles(sid, directory) {
            this.calls.push([sid, directory]);
            const queue = listings[sid] || [];
            const next = queue.length > 1 ? queue.shift() : queue[0];
            return (next || []).map(name => ({ name }));
        }
    };
}

const TFGM_OLD_ROOT = [
    'DiscordIntegration-Data', 'README.md', 'config', 'defaultconfigs', 'forge-auto-install.txt',
    'kubejs', 'minecraft_server.jar', 'mods', 'server-icon.png', 'server.properties',
    'server_starter.conf', 'start_server.bat', 'start_server.sh', 'tacz'
];
const LIVE_ROOT = [
    'config', 'defaultconfigs', 'kubejs', 'mods', 'server.properties', 'tacz', 'world',
    'libraries', 'logs', 'DiscordIntegration-Data', 'server-icon.png', 'README.md'
];

test('presentRootNames drops the pack names the instance root does not have', async () => {
    const client = panel({ tfgm1: [LIVE_ROOT] });
    const { present, dropped } = await _internals.presentRootNames('tfgm1', TFGM_OLD_ROOT, client, 3, 0);
    assert.deepStrictEqual(present, [
        'DiscordIntegration-Data', 'README.md', 'config', 'defaultconfigs', 'kubejs', 'mods',
        'server-icon.png', 'server.properties', 'tacz'
    ]);
    assert.deepStrictEqual(dropped, [
        'forge-auto-install.txt', 'minecraft_server.jar', 'server_starter.conf', 'start_server.bat', 'start_server.sh'
    ]);
    assert.deepStrictEqual(client.calls, [['tfgm1', '/']]);
});

test('presentRootNames retries an empty listing', async () => {
    const client = panel({ tfgm1: [[], LIVE_ROOT] });
    const { present } = await _internals.presentRootNames('tfgm1', ['mods', 'config'], client, 3, 0);
    assert.deepStrictEqual(present, ['mods', 'config']);
    assert.strictEqual(client.calls.length, 2);
});

test('presentRootNames throws when the root never lists', async () => {
    const client = panel({});
    await assert.rejects(_internals.presentRootNames('tfgm1', ['mods'], client, 3, 0), /could not list the server root of tfgm1/);
    assert.strictEqual(client.calls.length, 3);
});

test('presentRootNames throws when none of the pack names are on the root', async () => {
    const client = panel({ tfgm1: [['world', 'logs']] });
    await assert.rejects(_internals.presentRootNames('tfgm1', ['Server-Files-1.0'], client, 3, 0), /none of the pack's top-level names are on tfgm1/);
});

test('rootListsPerInstance builds one list per instance and reports the dropped names', async () => {
    const client = panel({
        a: [LIVE_ROOT],
        b: [[...LIVE_ROOT, 'start_server.sh']]
    });
    const log = collector();
    const lists = await _internals.rootListsPerInstance(['a', 'b'], TFGM_OLD_ROOT, log.report, client);
    assert.ok(!lists.a.includes('start_server.sh'));
    assert.ok(lists.b.includes('start_server.sh'));
    assert.ok(!lists.a.includes('world') && !lists.b.includes('world'), 'names outside the pack never join the list');
    assert.match(log.text, /`a` has no forge-auto-install\.txt, minecraft_server\.jar, server_starter\.conf, start_server\.bat, start_server\.sh, left out/);
    assert.match(log.text, /`b` has no forge-auto-install\.txt, minecraft_server\.jar, server_starter\.conf, start_server\.bat, left out/);
});
