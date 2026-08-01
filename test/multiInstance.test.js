/*
 * Unit tests for modules/perInstanceFiles.js — the multi-instance identity contract.
 * Run: npm test   (node --test test/*.test.js)
 *
 * These pin the behaviour that used to break IL2: two instances sharing the "il2" tag
 * must come out of an update with their OWN ports, backup destinations and metrics ports,
 * never the other instance's. The real fix is that each instance is merged from its own
 * files (updateManager), so these cover the force-protect layer on top of that plus the
 * cross-instance diff that surfaces drift nobody enumerated.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perInstanceFiles = require('../modules/perInstanceFiles');
const manifest = require('../modules/manifest');

// Real values read off the two live IL2 instances during the investigation.
const SUP = {
    id: '0ae41dd1',
    'server.properties': 'max-tick-time=120000\nquery.port=10035\nserver-port=10035\n',
    'config/AdvancedBackups.properties': 'config.advancedbackups.path=./backup/il2/supporter\nconfig.advancedbackups.frequency.schedule=7:00\n',
    'config/prometheus_exporter-server.toml': 'listen_port = 10041\n'
};
const PUB = {
    id: '29494616',
    'server.properties': 'max-tick-time=900000\nquery.port=10006\nserver-port=10006\n',
    'config/AdvancedBackups.properties': 'config.advancedbackups.path=./backup/il2/public\nconfig.advancedbackups.frequency.schedule=2:00\n',
    'config/prometheus_exporter-server.toml': 'listen_port = 10011\n'
};

// What the modpack itself would ship - the values that must NOT win.
const PACK_DEFAULTS = {
    'server.properties': 'max-tick-time=60000\nquery.port=25565\nserver-port=25565\n',
    'config/AdvancedBackups.properties': 'config.advancedbackups.path=./backup\nconfig.advancedbackups.frequency.schedule=0:00\n',
    'config/prometheus_exporter-server.toml': 'listen_port = 25585\n'
};

const FILES = Object.keys(PACK_DEFAULTS);

let tmpRoot = null;
const scratch = () => {
    if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-multi-instance-'));
    return fs.mkdtempSync(path.join(tmpRoot, 'tree-'));
};

/** Writes an instance's files into a fresh directory, plus some shared pack content. */
function buildInstanceTree(instance, extra = {}) {
    const dir = scratch();
    const write = (rel, content) => {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    };
    for (const file of FILES) write(file, instance[file]);
    write('mods/somemod.jar', 'identical on every instance');
    write('config/shared.cfg', 'identical on every instance');
    for (const [rel, content] of Object.entries(extra)) write(rel, content);
    return dir;
}

/** Stands in for merger.merge: the pack overwrites everything it ships. */
function applyPackMerge(dir) {
    for (const [rel, content] of Object.entries(PACK_DEFAULTS)) {
        fs.writeFileSync(path.join(dir, rel), content);
    }
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('the three identity files are protected by default', () => {
    const files = perInstanceFiles.forTag('il2');
    assert.ok(files.includes('server.properties'));
    assert.ok(files.includes('config/AdvancedBackups.properties'));
    assert.ok(files.includes('config/prometheus_exporter-server.toml'));
});

test('forTag folds in extra platform paths without dropping the defaults', () => {
    const files = perInstanceFiles.forTag('gto', ['config/gtocore.yaml']);
    assert.ok(files.includes('config/gtocore.yaml'), 'GTO difficulty file kept');
    assert.ok(files.includes('server.properties'), 'defaults still present');
    assert.strictEqual(new Set(files).size, files.length, 'no duplicates');
});

test('two instances keep their own ports and backup paths through a merge that overwrites them', () => {
    const supDir = buildInstanceTree(SUP);
    const pubDir = buildInstanceTree(PUB);
    const protectedFiles = perInstanceFiles.forTag('il2');

    // Each instance is stashed, merged and overlaid independently - the loop in updateManager
    for (const dir of [supDir, pubDir]) {
        const stash = perInstanceFiles.stashProtected(dir, protectedFiles);
        applyPackMerge(dir);
        perInstanceFiles.applyProtectedOverlay(dir, stash);
    }

    // The bug: both instances ending up on one set of values
    assert.notStrictEqual(read(supDir, 'server.properties'), read(pubDir, 'server.properties'));

    assert.match(read(supDir, 'server.properties'), /server-port=10035/);
    assert.match(read(pubDir, 'server.properties'), /server-port=10006/);
    assert.match(read(supDir, 'server.properties'), /max-tick-time=120000/);
    assert.match(read(pubDir, 'server.properties'), /max-tick-time=900000/);

    // Distinct AdvancedBackups destinations - a shared one corrupts the incremental chain
    assert.match(read(supDir, 'config/AdvancedBackups.properties'), /path=\.\/backup\/il2\/supporter/);
    assert.match(read(pubDir, 'config/AdvancedBackups.properties'), /path=\.\/backup\/il2\/public/);

    // Distinct prometheus ports - a shared one means one JVM fails to bind
    assert.match(read(supDir, 'config/prometheus_exporter-server.toml'), /listen_port = 10041/);
    assert.match(read(pubDir, 'config/prometheus_exporter-server.toml'), /listen_port = 10011/);

    // The pack's own values must not have survived anywhere
    for (const dir of [supDir, pubDir]) {
        assert.doesNotMatch(read(dir, 'server.properties'), /25565/);
        assert.doesNotMatch(read(dir, 'config/prometheus_exporter-server.toml'), /25585/);
    }
});

test('non-protected pack changes still get applied', () => {
    const dir = buildInstanceTree(SUP);
    const stash = perInstanceFiles.stashProtected(dir, perInstanceFiles.forTag('il2'));
    fs.writeFileSync(path.join(dir, 'config/shared.cfg'), 'updated by the pack');
    applyPackMerge(dir);
    perInstanceFiles.applyProtectedOverlay(dir, stash);

    assert.strictEqual(read(dir, 'config/shared.cfg'), 'updated by the pack',
        'the overlay must only touch the protected list');
});

test('stashProtected skips files the pack does not ship instead of throwing', () => {
    const dir = buildInstanceTree(SUP);
    fs.rmSync(path.join(dir, 'config/prometheus_exporter-server.toml'));

    const stash = perInstanceFiles.stashProtected(dir, perInstanceFiles.forTag('il2'));
    assert.ok(!('config/prometheus_exporter-server.toml' in stash));
    assert.ok('server.properties' in stash);

    const restored = perInstanceFiles.applyProtectedOverlay(dir, stash);
    assert.ok(!restored.includes('config/prometheus_exporter-server.toml'));
});

test('applyProtectedOverlay recreates a protected file the merge deleted', () => {
    const dir = buildInstanceTree(SUP);
    const stash = perInstanceFiles.stashProtected(dir, perInstanceFiles.forTag('il2'));

    fs.rmSync(path.join(dir, 'config'), { recursive: true });
    perInstanceFiles.applyProtectedOverlay(dir, stash);

    assert.match(read(dir, 'config/AdvancedBackups.properties'), /supporter/);
});

test('cross-instance diff catches same-length files whose contents differ', async () => {
    // server.properties is 1391 bytes on BOTH live instances and prometheus is 1392 on both,
    // yet the ports differ - a size comparison reports these as identical.
    const supDir = buildInstanceTree(SUP);
    const pubDir = buildInstanceTree(PUB);

    assert.strictEqual(
        fs.statSync(path.join(supDir, 'config/prometheus_exporter-server.toml')).size,
        fs.statSync(path.join(pubDir, 'config/prometheus_exporter-server.toml')).size,
        'fixture must reproduce the equal-size case');

    const report = await perInstanceFiles.diffInstanceManifests({
        [SUP.id]: manifest.generate(supDir),
        [PUB.id]: manifest.generate(pubDir)
    }, [SUP.id, PUB.id]);

    assert.strictEqual(report.length, 1);
    assert.deepStrictEqual(report[0].different.sort(), [
        'config/AdvancedBackups.properties',
        'config/prometheus_exporter-server.toml',
        'server.properties'
    ]);
    assert.deepStrictEqual(report[0].onlyHere, []);
    assert.deepStrictEqual(report[0].onlyThere, []);
});

test('cross-instance diff reports files present on only one instance', async () => {
    // The real case: a kubejs script that exists only on the supporter instance
    const supDir = buildInstanceTree(SUP, {
        'kubejs/server_scripts/random_scripts/dimensional_stabilizer_ban.js': '// supporter only'
    });
    const pubDir = buildInstanceTree(PUB, {
        'config/prometheus_exporter-server.bak': 'hand-made repair'
    });

    const report = await perInstanceFiles.diffInstanceManifests({
        [SUP.id]: manifest.generate(supDir),
        [PUB.id]: manifest.generate(pubDir)
    }, [SUP.id, PUB.id]);

    assert.deepStrictEqual(report[0].onlyHere, ['kubejs/server_scripts/random_scripts/dimensional_stabilizer_ban.js']);
    assert.deepStrictEqual(report[0].onlyThere, ['config/prometheus_exporter-server.bak']);

    const summary = perInstanceFiles.formatInstanceDiff(report);
    assert.match(summary, /dimensional_stabilizer_ban\.js/);
    assert.match(summary, /prometheus_exporter-server\.bak/);
});

test('an all-digit server id does not silently become the baseline', async () => {
    // Object.keys hoists "29494616" ahead of "0ae41dd1" because it looks like an array
    // index, so the caller's order has to win or the report names the wrong baseline.
    const manifests = {
        [SUP.id]: manifest.generate(buildInstanceTree(SUP)),
        [PUB.id]: manifest.generate(buildInstanceTree(PUB))
    };
    assert.strictEqual(Object.keys(manifests)[0], PUB.id, 'fixture must reproduce the key reordering');

    const report = await perInstanceFiles.diffInstanceManifests(manifests, [SUP.id, PUB.id]);
    assert.strictEqual(report[0].baseId, SUP.id);
    assert.strictEqual(report[0].serverId, PUB.id);
});

test('instances that failed to deploy are left out of the diff', async () => {
    const manifests = {
        [SUP.id]: manifest.generate(buildInstanceTree(SUP))
    };
    // PUB threw before producing a manifest, but is still in allServerIds
    const report = await perInstanceFiles.diffInstanceManifests(manifests, [SUP.id, PUB.id]);
    assert.deepStrictEqual(report, []);
});

test('a single instance produces no diff report', async () => {
    const report = await perInstanceFiles.diffInstanceManifests({
        [SUP.id]: manifest.generate(buildInstanceTree(SUP))
    });
    assert.deepStrictEqual(report, []);
    assert.strictEqual(perInstanceFiles.formatInstanceDiff(report), "");
});

test('formatInstanceDiff caps long lists so the Discord message cannot blow up', async () => {
    const many = {};
    for (let i = 0; i < 50; i++) many[`extra/file${i}.cfg`] = `content ${i}`;

    const report = await perInstanceFiles.diffInstanceManifests({
        [SUP.id]: manifest.generate(buildInstanceTree(SUP, many)),
        [PUB.id]: manifest.generate(buildInstanceTree(PUB))
    });

    const summary = perInstanceFiles.formatInstanceDiff(report, 8);
    assert.match(summary, /and 42 more/);
    assert.ok(summary.length < 2000, `summary should stay short, got ${summary.length}`);
});

test('listRelativeFiles walks nested snapshot folders and tolerates a missing one', () => {
    const dir = buildInstanceTree(SUP);
    const found = perInstanceFiles.listRelativeFiles(dir);

    assert.ok(found.includes('server.properties'));
    assert.ok(found.includes('config/AdvancedBackups.properties'), 'nested paths are relative and /-separated');
    assert.deepStrictEqual(perInstanceFiles.listRelativeFiles(path.join(dir, 'does-not-exist')), []);
});

test('a shared legacy backup can be re-stamped with an instance snapshot', () => {
    // /restore falls back to the one shared archive for backups taken before this fix.
    // It holds whichever instance happened to be first, so PUB's snapshot goes over the top.
    const sharedBackup = buildInstanceTree(SUP);
    const snapshotDir = buildInstanceTree(PUB);

    const snapshot = perInstanceFiles.stashProtected(snapshotDir, perInstanceFiles.forTag('il2'));
    perInstanceFiles.applyProtectedOverlay(sharedBackup, snapshot);

    assert.match(read(sharedBackup, 'server.properties'), /server-port=10006/);
    assert.match(read(sharedBackup, 'config/AdvancedBackups.properties'), /public/);
    assert.strictEqual(read(sharedBackup, 'mods/somemod.jar'), 'identical on every instance',
        'shared pack content comes from the backup, untouched');
});

/*
 * NOTE: backupAllInstances is deliberately NOT unit-tested here — it still reaches for the
 * module-level `pterodactyl`. updateManager binds that at require time, so swapping
 * require.cache afterwards does not stub it; an earlier version of this file did exactly
 * that and issued real delete/decompress calls against a live server. deployMergedTree
 * below is safe to test only because it takes the panel client as a parameter — any test
 * for backupAllInstances has to make it do the same first.
 */

test('instanceVaultPath keeps each instance in its own folder', () => {
    const { _internals } = require('../managers/updateManager');
    assert.strictEqual(
        _internals.instanceVaultPath('il2', SUP.id, 'il2_4.0_8458874.tar.gz'),
        './vault/il2/instances/0ae41dd1/il2_4.0_8458874.tar.gz');
    assert.notStrictEqual(
        _internals.instanceVaultPath('il2', SUP.id, 'x.tar.gz'),
        _internals.instanceVaultPath('il2', PUB.id, 'x.tar.gz'));
});

/* ---------- deploy guards ----------
 *
 * Between the wipe and the unpack the uploaded zip is the only copy of an instance's new
 * files, and both panel calls involved report failure by logging and returning undefined.
 * These pin the two things that must never happen: deleting that zip when the unpack was
 * not confirmed, and touching the live files at all when the upload was not confirmed.
 */

/** Panel client stub. `listings` is consumed one call at a time, last entry repeats. */
function fakePanel(listings, uploadUrl = 'http://127.0.0.1:1/upload') {
    const calls = [];
    let index = 0;
    return {
        calls,
        deleted: () => calls.filter(c => c.op === 'delete').flatMap(c => c.files),
        getUploadLink: async () => {
            calls.push({ op: 'uploadLink' });
            return uploadUrl;
        },
        listFiles: async () => {
            const entry = listings[Math.min(index++, listings.length - 1)];
            calls.push({ op: 'list' });
            return entry;
        },
        decompressFile: async (id, file) => {
            calls.push({ op: 'decompress', file });
            return true;
        },
        deleteFile: async (id, files) => {
            calls.push({ op: 'delete', files });
            return true;
        }
    };
}

/** Runs fn with cwd inside the scratch tree — deployMergedTree writes its zip to `./<tag>/`. */
async function inScratchCwd(fn) {
    const previous = process.cwd();
    const dir = scratch();
    process.chdir(dir);
    try {
        fs.mkdirSync('tst');
        return await fn();
    } finally {
        process.chdir(previous);
    }
}

test('a decompress the panel never performed does not get the archive deleted', async () => {
    const { _internals } = require('../managers/updateManager');
    const tree = buildInstanceTree(SUP);
    const zipName = 'update_tst.zip';

    await inScratchCwd(async () => {
        // The backstop, not the return-value check: the panel CLAIMS the unpack succeeded
        // (decompressFile returns true) but the directory only ever holds the zip, so the
        // wipe has left the instance empty. Covers a panel that reports a no-op as done.
        const client = fakePanel([]);
        client.listFiles = async () => {
            client.calls.push({ op: 'list' });
            return [{ name: zipName, size: fs.statSync(`tst/${zipName}`).size, is_file: true }];
        };

        await assert.rejects(
            () => _internals.deployMergedTree({ tag: 'tst' }, SUP.id, tree, zipName, ['mods'], client, 1),
            error => {
                assert.match(error.message, /decompress .* did not produce/);
                // Tells the caller to warn against re-running - that would back up the empty tree
                assert.strictEqual(error.serverWiped, true);
                return true;
            });

        assert.ok(client.deleted().includes('mods'), 'the wipe did happen - that is the state being recovered from');
        assert.ok(!client.deleted().includes(zipName),
            'the uploaded archive is the only copy of the new files and must survive');
    });
});

test('a confirmed unpack deletes the archive and leaves nothing behind', async () => {
    const { _internals } = require('../managers/updateManager');
    const tree = buildInstanceTree(SUP);
    const zipName = 'update_tst.zip';

    await inScratchCwd(async () => {
        const client = fakePanel([]);
        client.listFiles = async () => {
            client.calls.push({ op: 'list' });
            return [
                { name: zipName, size: fs.statSync(`tst/${zipName}`).size, is_file: true },
                ...fs.readdirSync(tree).map(name => ({ name, size: 1, is_file: false }))
            ];
        };

        await _internals.deployMergedTree({ tag: 'tst' }, SUP.id, tree, zipName, ['mods'], client, 2);

        assert.ok(client.deleted().includes(zipName), 'archive cleaned up once the unpack is confirmed');
        assert.strictEqual(fs.existsSync(`tst/${zipName}`), false, 'local zip cleaned up too');
    });
});

test('a wipe the panel refused stops the run before anything is unpacked over it', async () => {
    const { _internals } = require('../managers/updateManager');
    const tree = buildInstanceTree(SUP);
    const zipName = 'update_tst.zip';

    await inScratchCwd(async () => {
        // deleteFile 500s. The old top-level names are all still there, so a check that only
        // looks for them would pass and delete the archive, reporting a no-op as an update.
        const client = fakePanel([]);
        client.listFiles = async () => [{ name: zipName, size: fs.statSync(`tst/${zipName}`).size, is_file: true }];
        client.deleteFile = async (id, files) => {
            client.calls.push({ op: 'delete', files });
            return false;
        };

        await assert.rejects(
            () => _internals.deployMergedTree({ tag: 'tst' }, SUP.id, tree, zipName, ['mods'], client, 1),
            error => {
                assert.match(error.message, /could not delete the old files/);
                // NOT flagged: the files are still there, so this one is safe to re-run
                assert.strictEqual(error.serverWiped, undefined);
                return true;
            });

        assert.ok(!client.calls.some(c => c.op === 'decompress'), 'nothing unpacked on top of the old files');
        assert.ok(!client.deleted().includes(zipName), 'archive kept');
    });
});

test('a decompress the panel rejected outright is not treated as done', async () => {
    const { _internals } = require('../managers/updateManager');
    const tree = buildInstanceTree(SUP);
    const zipName = 'update_tst.zip';

    await inScratchCwd(async () => {
        const client = fakePanel([]);
        client.listFiles = async () => [
            { name: zipName, size: fs.statSync(`tst/${zipName}`).size, is_file: true },
            ...fs.readdirSync(tree).map(name => ({ name, size: 1, is_file: false }))
        ];
        client.decompressFile = async () => false;

        await assert.rejects(
            () => _internals.deployMergedTree({ tag: 'tst' }, SUP.id, tree, zipName, ['mods'], client, 1),
            error => {
                assert.match(error.message, /refused to unpack/);
                assert.strictEqual(error.serverWiped, true);
                return true;
            });

        assert.ok(!client.deleted().includes(zipName),
            'the listing looks unpacked, but the panel said no - the archive stays');
    });
});

test('an unconfirmable upload never reaches the delete', async () => {
    const { _internals } = require('../managers/updateManager');
    const tree = buildInstanceTree(SUP);

    await inScratchCwd(async () => {
        const client = fakePanel([[], [], []]); // listFiles returns [] on API errors too
        await assert.rejects(
            () => _internals.deployMergedTree({ tag: 'tst' }, SUP.id, tree, 'update_tst.zip', ['mods'], client, 1),
            /could not be confirmed/);

        assert.deepStrictEqual(client.deleted(), [], 'live files untouched');
    });
});

test('a size mismatch on the uploaded archive aborts before the wipe', async () => {
    const { _internals } = require('../managers/updateManager');
    const tree = buildInstanceTree(SUP);

    await inScratchCwd(async () => {
        const client = fakePanel([[{ name: 'update_tst.zip', size: 12, is_file: true }]]);
        await assert.rejects(
            () => _internals.deployMergedTree({ tag: 'tst' }, SUP.id, tree, 'update_tst.zip', ['mods'], client, 1),
            /is incomplete/);

        assert.deepStrictEqual(client.deleted(), [], 'live files untouched');
    });
});

test('findRemoteFile rides out a transient listing failure', async () => {
    const { _internals } = require('../managers/updateManager');
    // listFiles returns [] on any API error, which is indistinguishable from an empty dir
    const client = fakePanel([[], [{ name: 'x.zip', size: 5, is_file: true }]]);

    const found = await _internals.findRemoteFile(client, SUP.id, 'x.zip', 2);
    assert.strictEqual(found.size, 5);
});

test('findRemoteFile gives up rather than matching a directory of the same name', async () => {
    const { _internals } = require('../managers/updateManager');
    const client = fakePanel([[{ name: 'x.zip', size: 0, is_file: false }]]);

    assert.strictEqual(await _internals.findRemoteFile(client, SUP.id, 'x.zip', 1), null);
});

test('awaitDecompressed reports exactly what the unpack failed to produce', async () => {
    const { _internals } = require('../managers/updateManager');
    const client = fakePanel([[{ name: 'mods' }, { name: 'config' }]]);

    assert.deepStrictEqual(
        await _internals.awaitDecompressed(client, SUP.id, ['mods', 'config'], 1), []);
    assert.deepStrictEqual(
        await _internals.awaitDecompressed(client, SUP.id, ['mods', 'config', 'server.properties'], 1),
        ['server.properties']);
});

/* ---------- progress message ---------- */

test('an over-long progress log is trimmed instead of throwing mid-update', async () => {
    const { _internals } = require('../managers/updateManager');
    let sent = null;
    const message = {
        edit: async (content) => {
            if (content.length > _internals.DISCORD_MESSAGE_LIMIT) throw new Error('Invalid Form Body');
            sent = content;
        }
    };

    // Several instances plus a cross-instance diff get past 2000 characters on their own
    const log = 'Update sequence started.' + '\n- deployed an instance'.repeat(200) + '\n- FINAL LINE';
    assert.ok(log.length > _internals.DISCORD_MESSAGE_LIMIT, 'fixture must exceed the limit');

    await _internals.editProgress(message, log);

    assert.ok(sent.length <= _internals.DISCORD_MESSAGE_LIMIT);
    assert.match(sent, /FINAL LINE$/, 'the tail carries the current step and any FAILED markers');
    assert.match(sent, /earlier progress trimmed/);
});

test('a Discord outage cannot abort a run that already deployed', async () => {
    const { _internals } = require('../managers/updateManager');
    const message = { edit: async () => { throw new Error('503 Service Unavailable'); } };

    // Throwing here used to land between the last deploy and the database write
    await _internals.editProgress(message, 'short');
});

test.after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});
