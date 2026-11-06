/*
 * Unit tests for modules/textMerge.js and the three-way merge in modules/merger.js.
 * Run: npm test   (node --test test/*.test.js)
 *
 * The fixture is the real Shadowfall 1.1.1 -> 1.1.4 update (2026-11-06):
 * - ftbchunks-world.snbt: we set max_claimed_chunks 2000, force_load_mode "never" and
 *   max_idle_days_before_unforce 2.0d; the pack added a nether_portal_creation block. The old
 *   and new files are CRLF, ours is LF. expected/ is the file staff built by hand that day.
 * - tiered_tags.js: we and the pack rewrote the same handler (the pack adopted our fix).
 * - hyrule_terrors.json5: ours differs from the old pack file only by CRLF.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const textMerge = require('../modules/textMerge');
const merger = require('../modules/merger');
const comparator = require('../modules/comparator');

const FIXTURE = path.join(__dirname, 'fixtures', 'shadowfall-114');
const fixture = (side, name) => fs.readFileSync(path.join(FIXTURE, side, name));
const sides = (name) => ['live', 'old', 'new'].map(side => fixture(side, name));
const lf = (text) => String(text).replace(/\r\n/g, '\n');

let tmpRoot = null;
const scratch = () => {
    if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-text-merge-'));
    return fs.mkdtempSync(path.join(tmpRoot, 'tree-'));
};
const write = (dir, rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
};
const sha1 = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex');

test('fixture line endings survived the checkout', () => {
    assert.strictEqual(textMerge.lineEnding(fixture('old', 'ftbchunks-world.snbt').toString()), '\r\n');
    assert.strictEqual(textMerge.lineEnding(fixture('live', 'ftbchunks-world.snbt').toString()), '\n');
});

test('ftbchunks-world.snbt: our three values and the pack block merge cleanly', () => {
    const result = textMerge.mergeBuffers(...sides('ftbchunks-world.snbt'), 'config/ftbchunks-world.snbt');
    assert.strictEqual(result.status, 'merged');
    const merged = result.content.toString('utf8');

    assert.strictEqual(lf(merged), lf(fixture('expected', 'ftbchunks-world.snbt')), 'equals the hand-built file');
    assert.match(merged, /max_claimed_chunks: 2000/);
    assert.match(merged, /force_load_mode: "never"/);
    assert.match(merged, /max_idle_days_before_unforce: 2\.0d/);
    assert.match(merged, /nether_portal_creation: "no_portal"/);
    assert.strictEqual(textMerge.lineEnding(merged), '\r\n', "keeps the new file's CRLF");
    assert.ok(!/[^\r]\n/.test(merged), 'no bare LF left');
});

test('tiered_tags.js: both sides rewrote the same region, so it is a conflict', () => {
    const result = textMerge.mergeBuffers(...sides('tiered_tags.js'), 'kubejs/server_scripts/tiered_tags.js');
    assert.strictEqual(result.status, 'conflict');
    assert.strictEqual(result.content, undefined);
});

test('hyrule_terrors.json5: a CRLF-only difference is no edit, the new file wins', () => {
    const [live, old] = sides('hyrule_terrors.json5');
    assert.ok(!live.equals(old), 'the bytes do differ');
    assert.strictEqual(textMerge.mergeBuffers(...sides('hyrule_terrors.json5'), 'config/hyrule_terrors.json5').status, 'unedited');
});

test('live already equal to the new file is kept', () => {
    const next = fixture('new', 'hyrule_terrors.json5');
    const old = fixture('old', 'tiered_tags.js');
    assert.strictEqual(textMerge.mergeBuffers(next, old, next, 'a.json5').status, 'same');
    const crlf = Buffer.from(next.toString().replace(/\n/g, '\r\n'));
    assert.strictEqual(textMerge.mergeBuffers(crlf, old, next, 'a.json5').status, 'same');
});

test('trailing whitespace alone does not make a conflict', () => {
    const old = 'one\ntwo\nthree\nfour\nfive\nsix\n';
    const live = 'ONE\ntwo\nthree\nfour\nfive   \nsix\n';
    const next = 'one\ntwo\nthree\nfour\nFIVE\nsix\n';
    const result = textMerge.mergeText(live, old, next);
    assert.strictEqual(result.status, 'merged');
    assert.strictEqual(result.text, 'ONE\ntwo\nthree\nfour\nFIVE\nsix\n');
});

test('both sides making the same change is no conflict', () => {
    const result = textMerge.mergeText('a\nX\nc\nd\ne\nf\n', 'a\nb\nc\nd\ne\nf\n', 'a\nX\nc\nd\ne\nF\n');
    assert.deepStrictEqual(result, { status: 'merged', text: 'a\nX\nc\nd\ne\nF\n' });
});

test('binary, unknown and broken-UTF-8 files are never text-merged', () => {
    const a = Buffer.from('a\nb\n');
    const b = Buffer.from('a\nc\n');
    const c = Buffer.from('a\nd\n');
    assert.strictEqual(textMerge.mergeBuffers(a, b, c, 'mods/thing.jar').status, 'binary');
    assert.strictEqual(textMerge.mergeBuffers(Buffer.from('a\0b'), b, c, 'x.toml').status, 'binary');
    assert.strictEqual(textMerge.mergeBuffers(Buffer.from([0x61, 0xff, 0x0a]), b, c, 'x.lang').status, 'binary');
    const big = Buffer.alloc(textMerge.MAX_TEXT_BYTES + 1, 'a');
    assert.strictEqual(textMerge.mergeBuffers(big, b, c, 'x.txt').status, 'binary');
});

test('merger.merge merges, flags conflicts and writes the results into the tree', async () => {
    const root = scratch();
    const jarOld = Buffer.from('PK old jar');
    const files = {
        'config/ftbchunks-world.snbt': 'ftbchunks-world.snbt',
        'kubejs/server_scripts/tiered_tags.js': 'tiered_tags.js',
        'config/hyrule_terrors.json5': 'hyrule_terrors.json5'
    };
    for (const [rel, name] of Object.entries(files)) {
        write(root, `compare/old/${rel}`, fixture('old', name));
        write(root, `compare/new/${rel}`, fixture('new', name));
        write(root, `compare/main/${rel}`, fixture('live', name));
    }
    // A jar both sides changed, a file only the pack changed, a file only we have
    write(root, 'compare/old/mods/patched.jar', jarOld);
    write(root, 'compare/new/mods/patched.jar', Buffer.from('PK new stock jar'));
    write(root, 'compare/main/mods/patched.jar', Buffer.from('PK our patched jar'));
    write(root, 'compare/old/config/plain.toml', 'a = 1\n');
    write(root, 'compare/new/config/plain.toml', 'a = 2\n');
    write(root, 'compare/main/config/plain.toml', 'a = 1\n');
    write(root, 'compare/main/config/ours.cfg', 'custom\n');

    const changeList = await comparator.compare(path.join(root, 'compare/old'), path.join(root, 'compare/new'));
    const report = merger.merge(root, changeList);

    assert.deepStrictEqual(report.merged, ['config/ftbchunks-world.snbt']);
    assert.deepStrictEqual(report.conflicts, ['kubejs/server_scripts/tiered_tags.js']);
    assert.deepStrictEqual(report.overwritten, ['mods/patched.jar']);
    assert.deepStrictEqual(report.kept, []);

    const main = (rel) => fs.readFileSync(path.join(root, 'compare/main', rel));
    assert.strictEqual(lf(main('config/ftbchunks-world.snbt')), lf(fixture('expected', 'ftbchunks-world.snbt')));
    assert.ok(main('kubejs/server_scripts/tiered_tags.js').equals(fixture('new', 'tiered_tags.js')), 'conflict takes the pack file');
    assert.ok(main('config/hyrule_terrors.json5').equals(fixture('new', 'hyrule_terrors.json5')), 'CRLF-only takes the pack file');
    assert.strictEqual(main('config/plain.toml').toString(), 'a = 2\n');
    assert.strictEqual(main('config/ours.cfg').toString(), 'custom\n');

    const note = textMerge.formatReport(report);
    assert.match(note, /merged 1 \(config\/ftbchunks-world\.snbt\)/);
    assert.match(note, /conflicts 1 \(kubejs\/server_scripts\/tiered_tags\.js\)/);
    assert.match(note, /overwritten 1 \(mods\/patched\.jar\)/);
});

test('merger.mergeFromManifest fetches old copies only for edited text files', async () => {
    const root = scratch();
    const dir = path.join(root, 'main');
    const entry = (side, rel, content) => ({
        path: `./${path.posix.dirname(rel)}/`,
        name: path.posix.basename(rel),
        url: `https://${side}.example/${rel}`,
        sha1: sha1(content),
        size: content.length
    });
    const names = {
        'config/ftbchunks-world.snbt': 'ftbchunks-world.snbt',
        'kubejs/server_scripts/tiered_tags.js': 'tiered_tags.js',
        'config/hyrule_terrors.json5': 'hyrule_terrors.json5'
    };
    const oldFiles = [];
    const newFiles = [];
    for (const [rel, name] of Object.entries(names)) {
        oldFiles.push(entry('old', rel, fixture('old', name)));
        newFiles.push(entry('new', rel, fixture('new', name)));
        write(dir, rel, fixture('live', name));
    }
    // Unedited on the server: must not be fetched for the merge
    oldFiles.push(entry('old', 'config/untouched.toml', Buffer.from('x = 1\n')));
    newFiles.push(entry('new', 'config/untouched.toml', Buffer.from('x = 2\n')));
    write(dir, 'config/untouched.toml', 'x = 1\n');

    const content = { old: {}, new: {} };
    for (const [rel, name] of Object.entries(names)) {
        content.old[rel] = fixture('old', name);
        content.new[rel] = fixture('new', name);
    }
    content.new['config/untouched.toml'] = Buffer.from('x = 2\n');

    const fetched = [];
    const fetchList = async (list, dest) => {
        for (const file of list) {
            const url = new URL(file.url);
            const side = url.hostname.split('.')[0];
            const rel = url.pathname.slice(1);
            fetched.push(`${side}:${rel}`);
            write(dest, rel, content[side][rel]);
        }
    };

    const changeList = await comparator.findManifestChanges(oldFiles, newFiles);
    const report = await merger.mergeFromManifest(dir, changeList, { files: newFiles }, { files: oldFiles }, {
        fetchList,
        baseDir: path.join(root, 'merge-base')
    });

    const oldFetches = fetched.filter(f => f.startsWith('old:')).sort();
    assert.deepStrictEqual(oldFetches, [
        'old:config/ftbchunks-world.snbt',
        'old:config/hyrule_terrors.json5',
        'old:kubejs/server_scripts/tiered_tags.js'
    ]);
    assert.deepStrictEqual(report.merged, ['config/ftbchunks-world.snbt']);
    assert.deepStrictEqual(report.conflicts, ['kubejs/server_scripts/tiered_tags.js']);

    const read = (rel) => fs.readFileSync(path.join(dir, rel));
    assert.strictEqual(lf(read('config/ftbchunks-world.snbt')), lf(fixture('expected', 'ftbchunks-world.snbt')));
    assert.ok(read('kubejs/server_scripts/tiered_tags.js').equals(fixture('new', 'tiered_tags.js')));
    assert.ok(read('config/hyrule_terrors.json5').equals(fixture('new', 'hyrule_terrors.json5')));
    assert.strictEqual(read('config/untouched.toml').toString(), 'x = 2\n');
    assert.ok(!fs.existsSync(path.join(root, 'merge-base')), 'scratch copies are removed');
});

test('mergeFromManifest without the old copies falls back to the pack files', async () => {
    const root = scratch();
    const dir = path.join(root, 'main');
    const live = fixture('live', 'ftbchunks-world.snbt');
    const old = fixture('old', 'ftbchunks-world.snbt');
    const next = fixture('new', 'ftbchunks-world.snbt');
    write(dir, 'config/ftbchunks-world.snbt', live);
    const file = (content, side) => ({ path: './config/', name: 'ftbchunks-world.snbt', url: `https://${side}.example/x`, sha1: sha1(content), size: content.length });
    const changeList = await comparator.findManifestChanges([file(old, 'old')], [file(next, 'new')]);

    const report = await merger.mergeFromManifest(dir, changeList, { files: [file(next, 'new')] }, { files: [file(old, 'old')] }, {
        baseDir: path.join(root, 'merge-base'),
        fetchList: async (list, dest) => {
            if (list[0].url.includes('old.example')) throw new Error('CDN down');
            write(dest, 'config/ftbchunks-world.snbt', next);
        }
    });
    assert.deepStrictEqual(report.overwritten, ['config/ftbchunks-world.snbt']);
    assert.ok(fs.readFileSync(path.join(dir, 'config/ftbchunks-world.snbt')).equals(next));
});

test('formatReport stays empty when nothing was edited on both sides', () => {
    assert.strictEqual(textMerge.formatReport(textMerge.emptyReport()), '');
    assert.strictEqual(textMerge.formatReport(undefined), '');
    const report = textMerge.emptyReport();
    report.merged.push('a', 'b', 'c', 'd');
    assert.match(textMerge.formatReport(report), /merged 4 \(a, b, c \+1 more\), conflicts 0\./);
});
