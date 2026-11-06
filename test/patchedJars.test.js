/*
 * Unit tests for modules/patchedJars.js - the guard that stops a pack bump from silently
 * replacing a jar we patched under the stock file name.
 * Run: npm test   (node --test test/*.test.js)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const patchedJars = require('../modules/patchedJars');

// Old pack: the stock jars and their sizes
const OLD = new Map([
    ['mowziesmobs-1.8.2.jar', 1000],
    ['ftb-ultimine-neoforge-2101.1.15.jar', 2000],
    ['jei-19.21.jar', 3000]
]);

// Live mods/: two patched builds under stock names, one stock jar, one jar of our own
const LIVE = [
    { name: 'mowziesmobs-1.8.2.jar', size: 1012, is_file: true },
    { name: 'ftb-ultimine-neoforge-2101.1.15.jar', size: 2040, is_file: true },
    { name: 'jei-19.21.jar', size: 3000, is_file: true },
    { name: 'biforesting-1.0.jar', size: 500, is_file: true },
    { name: 'notes.txt', size: 5, is_file: true }
];

const noPause = async () => {};
const client = (listings) => ({
    calls: 0,
    async listFiles(sid, dir) {
        this.calls++;
        assert.strictEqual(dir, '/mods');
        return listings[sid] || [];
    }
});

test('a live jar is patched when the old pack has its name at another size', () => {
    assert.deepStrictEqual(patchedJars.findPatched(LIVE, OLD).map(jar => jar.name), [
        'mowziesmobs-1.8.2.jar',
        'ftb-ultimine-neoforge-2101.1.15.jar'
    ]);
});

test('the pack removing or changing the old name hits the patch, whatever the path form', () => {
    const patched = patchedJars.findPatched(LIVE, OLD);
    assert.deepStrictEqual(patchedJars.decide(patched, ['/mods/mowziesmobs-1.8.2.jar']), {
        hit: ['mowziesmobs-1.8.2.jar'],
        kept: ['ftb-ultimine-neoforge-2101.1.15.jar']
    });
    assert.deepStrictEqual(patchedJars.decide(patched, ['./mods/ftb-ultimine-neoforge-2101.1.15.jar']).hit, ['ftb-ultimine-neoforge-2101.1.15.jar']);
    assert.deepStrictEqual(patchedJars.decide(patched, ['/config/mowziesmobs-1.8.2.jar']).hit, [], 'only mods/ counts');
});

test('sizes come from an unpacked pack or an FTB manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-patched-'));
    fs.writeFileSync(path.join(dir, 'a.jar'), 'abc');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'abc');
    assert.deepStrictEqual([...patchedJars.sizesFromDir(dir)], [['a.jar', 3]]);
    assert.deepStrictEqual([...patchedJars.sizesFromDir(path.join(dir, 'missing'))], []);
    assert.deepStrictEqual([...patchedJars.sizesFromManifest([
        { path: './mods/', name: 'a.jar', size: 10 },
        { path: './mods/sub/', name: 'b.jar', size: 10 },
        { path: './config/', name: 'c.jar', size: 10 }
    ])], [['a.jar', 10]]);
});

test('an update that leaves the patches alone goes on and says how many it kept', async () => {
    const result = await patchedJars.checkInstances({
        client: client({ s1: LIVE }),
        serverIds: ['s1'],
        oldSizes: OLD,
        deletions: ['/mods/jei-19.21.jar', '/config/x.toml'],
        pause: noPause
    });
    assert.strictEqual(result.abort, null);
    assert.match(result.note, /Patched jars kept: 2 \(ftb-ultimine-neoforge-2101\.1\.15\.jar, mowziesmobs-1\.8\.2\.jar\)\./);
});

test('a bumped patched jar refuses the update and names it', async () => {
    const result = await patchedJars.checkInstances({
        client: client({ s1: LIVE }),
        serverIds: ['s1'],
        oldSizes: OLD,
        deletions: ['/mods/mowziesmobs-1.8.2.jar'],
        pause: noPause
    });
    assert.match(result.abort, /`mowziesmobs-1\.8\.2\.jar`/);
    assert.match(result.abort, /force:true/);
});

test('force lets the pack replace the patch and says so', async () => {
    const result = await patchedJars.checkInstances({
        client: client({ s1: LIVE }),
        serverIds: ['s1'],
        oldSizes: OLD,
        deletions: ['/mods/mowziesmobs-1.8.2.jar'],
        force: true,
        pause: noPause
    });
    assert.strictEqual(result.abort, null);
    assert.match(result.note, /Patched jars kept: 1 /);
    assert.match(result.note, /\*\*force: .*mowziesmobs-1\.8\.2\.jar/);
});

test('multi-instance: a hit on one instance refuses the update and names the instance', async () => {
    const stock = LIVE.map(entry => ({ ...entry, size: OLD.get(entry.name) ?? entry.size }));
    const result = await patchedJars.checkInstances({
        client: client({ a: stock, b: LIVE }),
        serverIds: ['a', 'b'],
        oldSizes: OLD,
        deletions: ['/mods/mowziesmobs-1.8.2.jar'],
        pause: noPause
    });
    assert.match(result.abort, /`mowziesmobs-1\.8\.2\.jar` \(b\)/);
    assert.deepStrictEqual(result.hit, { 'mowziesmobs-1.8.2.jar': ['b'] });
});

test('an empty mods/ listing is retried, then refuses the update', async () => {
    const fake = client({});
    const result = await patchedJars.checkInstances({
        client: fake,
        serverIds: ['s1'],
        oldSizes: OLD,
        deletions: [],
        pause: noPause
    });
    assert.strictEqual(fake.calls, 3);
    assert.match(result.abort, /listed no mods\/ on s1/);
});

test('custom jars the old pack never had are not patched jars', () => {
    assert.deepStrictEqual(patchedJars.findPatched([{ name: 'biforesting-1.0.jar', size: 1 }], OLD), []);
});
