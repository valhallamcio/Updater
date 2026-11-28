/*
 * Unit tests for modules/cfClientServerPack.js and the cf-client and announcement
 * helpers in managers/updateManager.js.
 * Run: npm test   (node --test test/*.test.js)
 *
 * Every CurseForge and CDN call goes to a fake passed in as a parameter, and every
 * Discord and mongo call in announceUpdate too. Nothing here may reach the network.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const archiver = require('archiver');
const yauzl = require('yauzl');

const builder = require('../modules/cfClientServerPack');
const githubServerPack = require('../modules/githubServerPack');
const modloader = require('../modules/modloader');
const { _internals } = require('../managers/updateManager');

let tmpRoot = null;
const scratch = () => {
    if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-cf-client-'));
    return fs.mkdtempSync(path.join(tmpRoot, 'case-'));
};
after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const PACK_ID = 1684694;
const PACK_FILE = 9083204;
const PACK_URL = 'https://edge.forgecdn.net/files/9083/204/Pack-1.6.0.zip';

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const jarBytes = (name) => Buffer.from(`PK fake jar ${name} `.repeat(20));

/*
 * The client pack: one mod a server needs, one with no direct download, one CurseForge
 * tags client only, two the exclude list names, a resource pack and a shader pack.
 */
const MODS = [
    { id: 100, name: 'Lib A', classId: 6 },
    { id: 101, name: 'Sodium', classId: 6 },
    { id: 102, name: 'Mouse Tweaks', classId: 6 },
    { id: 103, name: 'Controlling', classId: 6 },
    { id: 104, name: 'Fancy Textures', classId: 12 },
    { id: 105, name: 'Shiny Shaders', classId: 6552 },
    { id: 106, name: 'No Direct', classId: 6 },
    { id: 107, name: 'Zeta', classId: 6 }
];
const FILES = [
    { id: 1001, modId: 100, fileName: 'lib-a-1.0.jar', gameVersions: ['1.21.1', 'NeoForge', 'Client', 'Server'], direct: true },
    { id: 1002, modId: 101, fileName: 'sodium-neoforge-0.6.jar', gameVersions: ['1.21.1', 'NeoForge', 'Client'], direct: true },
    { id: 1003, modId: 102, fileName: 'MouseTweaks-neoforge-2.26.jar', gameVersions: ['1.21.1', 'NeoForge', 'Client', 'Server'], direct: true },
    { id: 1004, modId: 103, fileName: 'Controlling-neoforge-1.21.1-19.0.5.jar', gameVersions: ['1.21.1', 'NeoForge'], direct: true },
    { id: 1005, modId: 104, fileName: 'FancyTextures.zip', gameVersions: ['1.21.1'], direct: true },
    { id: 1006, modId: 105, fileName: 'ShinyShaders.zip', gameVersions: ['1.21.1'], direct: true },
    { id: 1007, modId: 106, fileName: 'no direct 1.0.jar', gameVersions: ['1.21.1', 'NeoForge'], direct: false },
    { id: 1008, modId: 107, fileName: 'Zeta-1.0.jar', gameVersions: ['1.21.1', 'NeoForge'], direct: true }
];
const EXCLUDE = [102, '^controlling-'];

const MANIFEST = {
    minecraft: { version: '1.21.1', modLoaders: [{ id: 'neoforge-21.1.248', primary: true }] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'Data Center in the Sky',
    version: '1.6.0',
    overrides: 'overrides',
    files: FILES.map(f => ({ projectID: f.modId, fileID: f.id, required: true }))
};

const OVERRIDES = {
    'config/a.toml': 'a = 1\n',
    'config/jei/jei-client.ini': 'x\n',
    'config/jei/world/local/abc/bookmarks.ini': 'b\n',
    'kubejs/server_scripts/main.js': 'console.log(1)\n',
    'mods/local-extra.jar': 'local jar',
    'mods/controlling-addon.jar': 'addon jar',
    'resourcepacks/rp.zip': 'rp',
    'shaderpacks/sp.zip': 'sp',
    'options.txt': 'fov:1\n',
    'servers.dat': 'dat'
};

/** Writes a zip from {name: content}, in the given order. */
function makeZip(entries, out) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(out);
        const archive = archiver('zip');
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
        archive.finalize();
    });
}

async function clientZipBytes(manifest = MANIFEST) {
    const file = path.join(scratch(), 'client.zip');
    const entries = { 'manifest.json': JSON.stringify(manifest, null, 2), 'modlist.html': '<ul></ul>' };
    for (const [rel, content] of Object.entries(OVERRIDES)) entries[`overrides/${rel}`] = content;
    await makeZip(entries, file);
    return fs.readFileSync(file);
}

/** CurseForge file data, with an optional lie about one file's size. */
function fileData({ wrongSize = null } = {}) {
    return FILES.map(f => {
        const bytes = jarBytes(f.fileName);
        return {
            id: f.id,
            modId: f.modId,
            fileName: f.fileName,
            fileLength: f.id === wrongSize ? bytes.length + 1 : bytes.length,
            downloadUrl: f.direct ? `https://edge.forgecdn.net/files/${Math.floor(f.id / 1000)}/${f.id % 1000}/${f.fileName}` : null,
            gameVersions: f.gameVersions,
            hashes: [{ value: sha1(bytes), algo: 1 }, { value: 'ffff', algo: 2 }]
        };
    });
}

/** CurseForge fake. reverse answers in another order, as the API may. */
function curseforge({ files = fileData(), mods = MODS, reverse = false } = {}) {
    return {
        calls: [],
        async getFileLink(modPackId, fileId) {
            this.calls.push(['getFileLink', modPackId, fileId]);
            return PACK_URL;
        },
        async getFiles(fileIds) {
            this.calls.push(['getFiles', fileIds]);
            const found = files.filter(f => fileIds.includes(f.id));
            return reverse ? found.reverse() : found;
        },
        async getMods(modIds) {
            this.calls.push(['getMods', modIds]);
            const found = mods.filter(m => modIds.includes(m.id));
            return reverse ? found.reverse() : found;
        }
    };
}

/** axios-like CDN fake: the client zip and every jar, by URL. Unknown URLs are a 404. */
function cdn(zip) {
    const routes = new Map([[PACK_URL, zip]]);
    for (const f of FILES) {
        const url = f.direct ? `https://edge.forgecdn.net/files/${Math.floor(f.id / 1000)}/${f.id % 1000}/${f.fileName}` : builder.cdnUrl(f.id, f.fileName);
        routes.set(url, jarBytes(f.fileName));
    }
    return {
        calls: [],
        async get(url, options) {
            this.calls.push(url);
            assert.strictEqual(options.responseType, 'stream');
            if (!routes.has(url)) {
                const error = new Error('Request failed with status code 404');
                error.response = { status: 404 };
                throw error;
            }
            const body = routes.get(url);
            return { data: Readable.from([body]), headers: { 'content-length': String(body.length) } };
        }
    };
}

/** The entries of a zip, in order: {name, data, date}. */
function readZip(file) {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true }, (error, zip) => {
            if (error) return reject(error);
            const entries = [];
            zip.on('error', reject);
            zip.on('end', () => resolve(entries));
            zip.on('entry', (entry) => {
                zip.openReadStream(entry, (err, stream) => {
                    if (err) return reject(err);
                    const chunks = [];
                    stream.on('data', c => chunks.push(c));
                    stream.on('end', () => {
                        entries.push({ name: entry.fileName, data: Buffer.concat(chunks), date: entry.getLastModDate().getTime() });
                        zip.readEntry();
                    });
                });
            });
            zip.readEntry();
        });
    });
}

test('parseExclude reads modIds, digit strings and file name regexes', () => {
    const exclude = builder.parseExclude([394468, '455508', '^sodium-', 'toastcontrol']);
    assert.deepStrictEqual([...exclude.modIds], [394468, 455508]);
    assert.deepStrictEqual(exclude.patterns.map(p => p.source), ['^sodium-', 'toastcontrol']);
    assert.ok(exclude.patterns[0].test('Sodium-neoforge.jar'), 'regexes ignore case');
    assert.deepStrictEqual([...builder.parseExclude(undefined).modIds], []);
});

test('parseExclude and parseSource reject bad input', () => {
    assert.throws(() => builder.parseExclude('sodium'), /must be a list/);
    assert.throws(() => builder.parseExclude(['(']), /not a valid regex/);
    assert.throws(() => builder.parseExclude([0]), /neither a modId nor a file name regex/);
    assert.throws(() => builder.parseExclude([{}]), /neither a modId nor a file name regex/);
    assert.throws(() => builder.parseSource({ type: 'github', repo: 'a/b' }), /must be "cf-client"/);
    assert.throws(() => builder.parseSource(null), /must be "cf-client"/);
    assert.deepStrictEqual(builder.parseSource({ type: 'cf-client' }), { exclude: [] });
    assert.deepStrictEqual(builder.parseSource({ type: 'cf-client', exclude: [1] }), { exclude: [1] });
});

test('planFiles skips client-only files, excluded mods and non-mod classes, with every reason', () => {
    const plan = builder.planFiles(MANIFEST.files, fileData(), MODS, builder.parseExclude(EXCLUDE));
    assert.deepStrictEqual(plan.keep.map(k => k.fileName), ['Zeta-1.0.jar', 'lib-a-1.0.jar', 'no direct 1.0.jar']);
    const reasons = Object.fromEntries(plan.skipped.map(s => [s.name, s.reasons]));
    assert.deepStrictEqual(reasons, {
        'Controlling': ['excluded by /^controlling-/'],
        'Fancy Textures': ['not a mod (classId 12)'],
        'Mouse Tweaks': ['excluded by modId 102'],
        'Shiny Shaders': ['not a mod (classId 6552)'],
        'Sodium': ['client only (CurseForge lists Client, not Server)']
    });
});

test('planFiles reports every reason when a file has more than one', () => {
    const plan = builder.planFiles(MANIFEST.files, fileData(), MODS, builder.parseExclude([101, 'sodium']));
    const sodium = plan.skipped.find(s => s.modId === 101);
    assert.deepStrictEqual(sodium.reasons, ['client only (CurseForge lists Client, not Server)', 'excluded by modId 101', 'excluded by /sodium/']);
});

test('planFiles uses the CDN address when a file has no downloadUrl', () => {
    const plan = builder.planFiles(MANIFEST.files, fileData(), MODS, builder.parseExclude([]));
    const noDirect = plan.keep.find(k => k.fileId === 1007);
    assert.strictEqual(noDirect.url, 'https://edge.forgecdn.net/files/1/7/no%20direct%201.0.jar');
    assert.strictEqual(builder.cdnUrl(9083204, 'Pack.zip'), 'https://edge.forgecdn.net/files/9083/204/Pack.zip');
});

test('planFiles fails on missing data, a foreign file, an unsafe name or a missing size', () => {
    const exclude = builder.parseExclude([]);
    assert.throws(() => builder.planFiles(MANIFEST.files, fileData().slice(1), MODS, exclude), /no data for file 1001/);
    assert.throws(() => builder.planFiles(MANIFEST.files, fileData(), MODS.slice(1), exclude), /no data for mod 100/);
    const foreign = fileData().map(f => f.id === 1001 ? { ...f, modId: 999 } : f);
    assert.throws(() => builder.planFiles(MANIFEST.files, foreign, MODS, exclude), /belongs to mod 999/);
    const unsafe = fileData().map(f => f.id === 1001 ? { ...f, fileName: '../evil.jar' } : f);
    assert.throws(() => builder.planFiles(MANIFEST.files, unsafe, MODS, exclude), /unsafe file name/);
    const sizeless = fileData().map(f => f.id === 1001 ? { ...f, fileLength: 0 } : f);
    assert.throws(() => builder.planFiles(MANIFEST.files, sizeless, MODS, exclude), /no size/);
    assert.throws(() => builder.planFiles([{ projectID: 'x', fileID: 1 }], [], [], exclude), /numeric projectID and fileID/);
});

test('isClientOnlyPath keeps the client folders and files out, and only those', () => {
    for (const rel of ['resourcepacks/a.zip', 'shaderpacks/b.zip', 'options.txt', 'servers.dat', 'config/jei/world/x/y.ini']) {
        assert.ok(builder.isClientOnlyPath(rel), rel);
    }
    for (const rel of ['config/jei/jei-client.ini', 'config/options.txt', 'kubejs/resourcepacks/a.png', 'config/a.toml']) {
        assert.ok(!builder.isClientOnlyPath(rel), rel);
    }
});

test('build writes mods, the server overrides and manifest.json, in name order', async () => {
    const dir = scratch();
    const out = path.join(dir, 'nested', 'dcs.zip');
    const zip = await clientZipBytes();
    const cf = curseforge();
    const http = cdn(zip);
    const result = await builder.build(PACK_ID, PACK_FILE, out, { exclude: EXCLUDE }, { curseforge: cf, http });

    const entries = await readZip(out);
    const names = entries.map(e => e.name);
    assert.deepStrictEqual(names, [
        'config/a.toml',
        'config/jei/jei-client.ini',
        'kubejs/server_scripts/main.js',
        'manifest.json',
        'mods/Zeta-1.0.jar',
        'mods/lib-a-1.0.jar',
        'mods/local-extra.jar',
        'mods/no direct 1.0.jar'
    ]);
    const byName = Object.fromEntries(entries.map(e => [e.name, e.data]));
    assert.deepStrictEqual(byName['mods/lib-a-1.0.jar'], jarBytes('lib-a-1.0.jar'));
    assert.strictEqual(byName['config/a.toml'].toString(), OVERRIDES['config/a.toml']);
    assert.strictEqual(byName['mods/local-extra.jar'].toString(), 'local jar');
    assert.ok(entries.every(e => e.date === entries[0].date), 'every entry has the same time');

    // planLoader reads the root manifest.json when the pack has no variables.txt
    assert.deepStrictEqual(modloader.loaderFromManifest(JSON.parse(byName['manifest.json'])), { loader: 'neoforge', version: '21.1.248' });

    assert.deepStrictEqual(result.overrides.skipped.map(s => [s.path, s.reasons]), [
        ['config/jei/world/local/abc/bookmarks.ini', ['client-only path']],
        ['mods/controlling-addon.jar', ['excluded by /^controlling-/']],
        ['options.txt', ['client-only path']],
        ['resourcepacks/rp.zip', ['client-only path']],
        ['servers.dat', ['client-only path']],
        ['shaderpacks/sp.zip', ['client-only path']]
    ]);
    assert.deepStrictEqual(result.unusedExclude, []);
    assert.strictEqual(result.minecraft.version, '1.21.1');

    // One request for all file data, one for all mod data
    assert.deepStrictEqual(cf.calls.map(c => c[0]), ['getFileLink', 'getFiles', 'getMods']);
    assert.deepStrictEqual(cf.calls[1][1], FILES.map(f => f.id));
    assert.ok(http.calls.includes(builder.cdnUrl(1007, 'no direct 1.0.jar')), 'the file without a downloadUrl came from the CDN address');
    assert.ok(!http.calls.some(u => /sodium|MouseTweaks|Controlling|Fancy|Shiny/.test(u)), 'skipped files are never fetched');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(out)), ['dcs.zip'], 'no scratch is left next to the zip');
});

test('build reports exclude entries that match nothing', async () => {
    const out = path.join(scratch(), 'dcs.zip');
    const result = await builder.build(PACK_ID, PACK_FILE, out, { exclude: [...EXCLUDE, 424242, '^nothing-'] }, { curseforge: curseforge(), http: cdn(await clientZipBytes()) });
    assert.deepStrictEqual(result.unusedExclude, ['424242', '^nothing-']);
});

test('build is deterministic: the same inputs give the same zip, byte for byte', async () => {
    const zip = await clientZipBytes();
    const a = path.join(scratch(), 'a.zip');
    const b = path.join(scratch(), 'b.zip');
    await builder.build(PACK_ID, PACK_FILE, a, { exclude: EXCLUDE }, { curseforge: curseforge(), http: cdn(zip) });
    await builder.build(PACK_ID, PACK_FILE, b, { exclude: EXCLUDE }, { curseforge: curseforge({ reverse: true }), http: cdn(zip) });
    const entriesA = await readZip(a);
    const entriesB = await readZip(b);
    assert.deepStrictEqual(entriesA.map(e => e.name), entriesB.map(e => e.name));
    for (let i = 0; i < entriesA.length; i++) assert.deepStrictEqual(entriesA[i].data, entriesB[i].data, entriesA[i].name);
    assert.strictEqual(sha1(fs.readFileSync(a)), sha1(fs.readFileSync(b)));
});

test('build fails on a jar whose size is not the CurseForge fileLength, and leaves no pack', async () => {
    const dir = scratch();
    const out = path.join(dir, 'dcs.zip');
    fs.writeFileSync(out, 'the zip from before');
    const cf = curseforge({ files: fileData({ wrongSize: 1008 }) });
    await assert.rejects(
        builder.build(PACK_ID, PACK_FILE, out, { exclude: EXCLUDE }, { curseforge: cf, http: cdn(await clientZipBytes()) }),
        /could not fetch Zeta-1\.0\.jar \(Zeta, file 1008\): Zeta-1\.0\.jar is \d+ bytes, expected \d+/
    );
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'the zip from before');
    assert.deepStrictEqual(fs.readdirSync(dir), ['dcs.zip']);
});

test('build fails on a jar whose sha1 does not match', async () => {
    const files = fileData().map(f => f.id === 1001 ? { ...f, hashes: [{ value: '0'.repeat(40), algo: 1 }] } : f);
    const out = path.join(scratch(), 'dcs.zip');
    await assert.rejects(
        builder.build(PACK_ID, PACK_FILE, out, { exclude: EXCLUDE }, { curseforge: curseforge({ files }), http: cdn(await clientZipBytes()) }),
        /lib-a-1\.0\.jar does not match its sha1/
    );
    assert.ok(!fs.existsSync(out));
});

test('build fails when a jar is missing on the CDN', async () => {
    const http = cdn(await clientZipBytes());
    const get = http.get.bind(http);
    http.get = async (url, options) => {
        if (url.includes('Zeta')) {
            const error = new Error('Request failed with status code 404');
            error.response = { status: 404 };
            throw error;
        }
        return get(url, options);
    };
    const out = path.join(scratch(), 'dcs.zip');
    await assert.rejects(builder.build(PACK_ID, PACK_FILE, out, { exclude: EXCLUDE }, { curseforge: curseforge(), http }), /could not fetch Zeta-1\.0\.jar/);
    assert.ok(!fs.existsSync(out));
});

test('build fails on a client pack without a manifest', async () => {
    const file = path.join(scratch(), 'client.zip');
    await makeZip({ 'overrides/config/a.toml': 'a' }, file);
    const out = path.join(scratch(), 'dcs.zip');
    await assert.rejects(builder.build(PACK_ID, PACK_FILE, out, {}, { curseforge: curseforge(), http: cdn(fs.readFileSync(file)) }), /no readable manifest\.json/);
    assert.ok(!fs.existsSync(out));
});

/* ---------- updateManager: where updateCF takes its server packs from ---------- */

const CF_CLIENT = { type: 'cf-client', exclude: EXCLUDE };

test('serverPackOrigin keeps CurseForge server packs whenever both versions have one', () => {
    assert.strictEqual(_internals.serverPackOrigin(null, 11, 12), 'curseforge');
    assert.strictEqual(_internals.serverPackOrigin(CF_CLIENT, 11, 12), 'curseforge');
    assert.strictEqual(_internals.serverPackOrigin({ type: 'github', repo: 'a/b', asset: 'x' }, 11, 12), 'curseforge');
});

test('serverPackOrigin builds both sides from the client packs only when cf-client is set and a side is missing', () => {
    assert.strictEqual(_internals.serverPackOrigin(CF_CLIENT, null, null), 'cf-client');
    assert.strictEqual(_internals.serverPackOrigin(CF_CLIENT, null, 12), 'cf-client');
    assert.strictEqual(_internals.serverPackOrigin(CF_CLIENT, 11, null), 'cf-client');
    assert.strictEqual(_internals.serverPackOrigin({ type: 'github', repo: 'a/b', asset: 'x' }, null, 12), 'github');
    assert.strictEqual(_internals.serverPackOrigin({ type: 'nope' }, null, 12), 'github', 'an unknown type is reported as a bad source by the GitHub path');
    assert.strictEqual(_internals.serverPackOrigin(null, null, null), 'missing');
    assert.strictEqual(_internals.serverPackOrigin(null, 11, null), 'missing');
});

test('the config map gives the cf-client source by tag', () => {
    const config = { serverPackSources: { dcs: CF_CLIENT } };
    const source = githubServerPack.sourceFor({ tag: 'dcs' }, config);
    assert.strictEqual(_internals.serverPackOrigin(source, null, null), 'cf-client');
    assert.strictEqual(_internals.serverPackOrigin(githubServerPack.sourceFor({ tag: 'atm10' }, config), null, null), 'missing');
});

const dcsPack = { tag: 'dcs', name: 'Data Center in the Sky', modpackID: PACK_ID, fileID: 9000001, newestFileID: PACK_FILE };

function collector() {
    const log = { text: '' };
    log.report = async (line) => { log.text += line; };
    return log;
}

function fakeBuilder(failOn = null) {
    return {
        calls: [],
        async build(modPackId, fileId, zip, opts) {
            this.calls.push([modPackId, fileId, zip, opts]);
            if (fileId === failOn) throw new Error('Zeta-1.0.jar is 10 bytes, expected 11');
            return { kept: [{}, {}], skipped: [{ fileName: 'sodium.jar', reasons: ['client only'] }], unusedExclude: [] };
        }
    };
}

test('buildClientServerPacks builds the new side, then the reference side, with the exclude list', async () => {
    const fake = fakeBuilder();
    const log = collector();
    const ok = await _internals.buildClientServerPacks(dcsPack, EXCLUDE, { newest: 'new.zip', current: 'old.zip' }, log.report, { builder: fake });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(fake.calls, [
        [PACK_ID, PACK_FILE, 'new.zip', { exclude: EXCLUDE }],
        [PACK_ID, 9000001, 'old.zip', { exclude: EXCLUDE }]
    ]);
    assert.match(log.text, /Building the new server pack from client pack file 9083204\.\.\. Done! 2 mod file\(s\), 1 skipped\./);
    assert.match(log.text, /Building the reference server pack from client pack file 9000001\.\.\. Done!/);
});

test('buildClientServerPacks aborts before the stop when one side fails', async () => {
    const log = collector();
    const ok = await _internals.buildClientServerPacks(dcsPack, EXCLUDE, { newest: 'new.zip', current: 'old.zip' }, log.report, { builder: fakeBuilder(9000001) });
    assert.strictEqual(ok, false);
    assert.match(log.text, /\*\*FAILED: Zeta-1\.0\.jar is 10 bytes, expected 11\.\*\* Aborting update, nothing was touched\./);
});

/* ---------- updateManager: announcements of hidden packs ---------- */

test('isHiddenPack needs every instance unreleased', () => {
    assert.strictEqual(_internals.isHiddenPack(['a', 'b'], ['a', 'b', 'c']), true);
    assert.strictEqual(_internals.isHiddenPack(['a', 'b'], ['a']), false);
    assert.strictEqual(_internals.isHiddenPack(['a'], []), false);
    assert.strictEqual(_internals.isHiddenPack([], ['a']), false);
});

function discord(unreleased) {
    return {
        sent: [],
        sendWebhook: async function (channelId, message) { this.sent.push([channelId, message]); },
        findUnreleasedServerIds: async () => {
            if (unreleased instanceof Error) throw unreleased;
            return unreleased;
        },
        announcementChannelId: 'public-channel',
        staffChannelId: 'staff-channel'
    };
}

const announcement = {
    content: '<@&555> Data Center in the Sky updated to 1.6.0!',
    allowedMentions: { parse: [], roles: ['555'] },
    username: 'Data Center in the Sky',
    avatarURL: 'https://example.invalid/logo.png'
};
const versions = { oldVersion: '1.5.0', newVersion: '1.6.0' };

test('announceUpdate posts the public announcement when one instance is released', async () => {
    const deps = discord(['sid-a']);
    deps.sendWebhook = deps.sendWebhook.bind(deps);
    const where = await _internals.announceUpdate(dcsPack, ['sid-a', 'sid-b'], announcement, versions, deps);
    assert.strictEqual(where, 'public');
    assert.deepStrictEqual(deps.sent, [['public-channel', announcement]]);
});

test('announceUpdate sends a hidden pack to the staff channel, with no role ping', async () => {
    const deps = discord(['sid-a', 'sid-b']);
    deps.sendWebhook = deps.sendWebhook.bind(deps);
    const where = await _internals.announceUpdate(dcsPack, ['sid-a', 'sid-b'], announcement, versions, deps);
    assert.strictEqual(where, 'staff');
    assert.strictEqual(deps.sent.length, 1);
    const [channel, message] = deps.sent[0];
    assert.strictEqual(channel, 'staff-channel');
    assert.match(message.content, /\*\*Data Center in the Sky\*\* \(`dcs`\) updated 1\.5\.0 -> 1\.6\.0\. Every instance is unreleased/);
    assert.ok(!message.content.includes('<@&'), 'no role mention');
    assert.deepStrictEqual(message.allowedMentions, { parse: [] });
});

test('announceUpdate holds the public post when the unreleased read fails', async () => {
    const deps = discord(new Error('mongo down'));
    deps.sendWebhook = deps.sendWebhook.bind(deps);
    const where = await _internals.announceUpdate(dcsPack, ['sid-a'], announcement, versions, deps);
    assert.strictEqual(where, 'staff');
    assert.strictEqual(deps.sent[0][0], 'staff-channel');
    assert.match(deps.sent[0][1].content, /could not be read \(mongo down\), so the public announcement was held/);
});
