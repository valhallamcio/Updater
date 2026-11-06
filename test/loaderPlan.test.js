/*
 * Unit tests for the pre-flight and the NeoForge switch in managers/updateManager.js.
 * Run: npm test   (node --test test/*.test.js)
 *
 * Every helper here takes the panel client as a parameter, and every test passes a fake.
 * Never fall back to the real client in a test: updateManager binds it at require time,
 * so a missing stub would send the calls to the live panel (see test/multiInstance.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modloader = require('../modules/modloader');
const { _internals } = require('../managers/updateManager');

const startupOn = (version) => `java -Xms128M @user_jvm_args.txt @libraries/net/neoforged/neoforge/${version}/unix_args.txt nogui`;

let tmpRoot = null;
const scratch = () => {
    if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-loader-plan-'));
    return fs.mkdtempSync(path.join(tmpRoot, 'case-'));
};

/** Panel client fake: startups and application servers per instance id, listings per directory. */
function panel({ startups = {}, servers = {}, files = {}, patchApplies = true } = {}) {
    return {
        startupReads: [],
        patches: [],
        async getStartup(sid) {
            this.startupReads.push(sid);
            if (!(sid in startups)) throw new Error('API returned 500');
            return { startup_command: startups[sid] };
        },
        async getApplicationServer(sid) {
            if (!servers[sid]) throw new Error('PTERODACTYL_ADMIN_APIKEY (the panel application key, ptla_) is not set in the updater .env');
            return JSON.parse(JSON.stringify(servers[sid]));
        },
        async updateStartup(id, body) {
            this.patches.push({ id, body });
            const server = Object.values(servers).find(entry => entry.id === id);
            if (patchApplies) {
                server.container.startup_command = body.startup;
                server.container.environment = { ...body.environment };
            }
            return server;
        },
        async listFiles(sid, dir = '/') {
            return (files[sid] && files[sid][dir]) || [];
        }
    };
}

const appServer = (id, identifier, version) => ({
    id,
    identifier,
    uuid: `${identifier}-0000`,
    egg: 17,
    container: {
        startup_command: startupOn(version),
        image: 'ghcr.io/parkervcp/yolks:java_21',
        environment: { NEOFORGE_VERSION: version, P_SERVER_UUID: 'x' }
    }
});

/** modloader with the slow parts replaced: no Java run, no installer download. */
function ops(overrides = {}) {
    const calls = { prepare: [], checkJars: [] };
    return {
        calls,
        ...modloader,
        checkJava: async () => ({ major: 21 }),
        prepareNeoForge: async (version, workDir, options) => {
            calls.prepare.push({ version, workDir, options });
            return { payloadDir: path.join(workDir, 'payload'), files: ['net/neoforged/neoforge/21.1.265/unix_args.txt'], bytes: 9 * 1024 * 1024 };
        },
        checkJars: async (jars, loader, version) => {
            calls.checkJars.push({ jars, loader, version });
            return [];
        },
        ...overrides
    };
}

const neoforge = (version) => ({ loader: 'neoforge', version });

test('no bump when every instance already runs the pack loader', async () => {
    const loaderOps = ops();
    const result = await _internals.planLoader(['a'], { target: neoforge('21.1.262'), newJars: ['x.jar'], workDir: '/tmp/x' },
        panel({ startups: { a: startupOn('21.1.262') } }), loaderOps);
    assert.strictEqual(result.abort, null);
    assert.strictEqual(result.bump, null);
    assert.match(result.note, /NeoForge 21\.1\.262, no switch needed/);
    assert.deepStrictEqual(loaderOps.calls.checkJars, [{ jars: ['x.jar'], loader: 'neoforge', version: '21.1.262' }]);
    assert.strictEqual(loaderOps.calls.prepare.length, 0);
});

test('the Shadowfall case: 21.1.262 live, the pack wants 21.1.265, only the old instance switches', async () => {
    const loaderOps = ops();
    const client = panel({
        startups: { a: startupOn('21.1.262'), b: startupOn('21.1.265') },
        servers: { a: appServer(239, 'a', '21.1.262') }
    });
    const result = await _internals.planLoader(['a', 'b'], { target: neoforge('21.1.265'), newJars: [], workDir: '/tmp/w' }, client, loaderOps);
    assert.strictEqual(result.abort, null);
    assert.deepStrictEqual(result.bump.switchIds, ['a']);
    assert.deepStrictEqual(result.bump.from, { a: '21.1.262' });
    assert.strictEqual(result.bump.version, '21.1.265');
    assert.strictEqual(loaderOps.calls.prepare[0].options.baseVersion, '21.1.262', 'payload diffed against the running version');
    assert.match(result.note, /switching 21\.1\.262 on a after the deploy, 1 library file\(s\) ready \(9\.0 MB\)/);
    assert.strictEqual(client.patches.length, 0, 'nothing is changed before the stop');
});

test('a new jar that refuses the loader aborts before the stop and names the jar', async () => {
    const loaderOps = ops({
        checkJars: async (jars, loader, version) => version === '21.1.262'
            ? [{ jar: 'apoli-1.124.0.jar', owner: 'apoli', range: '[21.1.265,)' }] : []
    });
    // The pack forgot to raise its loader: it still says 21.1.262
    const result = await _internals.planLoader(['a'], { target: neoforge('21.1.262'), newJars: [], workDir: '/tmp/w' },
        panel({ startups: { a: startupOn('21.1.262') } }), loaderOps);
    assert.match(result.abort, /`apoli-1\.124\.0\.jar` needs NeoForge \[21\.1\.265,\), but a would run NeoForge 21\.1\.262/);
});

test('no Java on the updater host aborts the bump with the setting to fix', async () => {
    const loaderOps = ops({ checkJava: modloader.checkJava });
    const result = await _internals.planLoader(['a'], { target: neoforge('21.1.265'), newJars: [], workDir: '/tmp/w', java: '/nonexistent/java' },
        panel({ startups: { a: startupOn('21.1.262') }, servers: { a: appServer(1, 'a', '21.1.262') } }), loaderOps);
    assert.match(result.abort, /the pack needs NeoForge 21\.1\.265 \(21\.1\.262 on a\), but the switch cannot be prepared/);
    assert.match(result.abort, /NEOFORGE_INSTALLER_JAVA/);
    assert.strictEqual(loaderOps.calls.prepare.length, 0);
});

test('a missing application key aborts the bump before the stop', async () => {
    const result = await _internals.planLoader(['a'], { target: neoforge('21.1.265'), newJars: [], workDir: '/tmp/w' },
        panel({ startups: { a: startupOn('21.1.262') } }), ops());
    assert.match(result.abort, /PTERODACTYL_ADMIN_APIKEY/);
});

test('an unreadable startup aborts, a startup without a loader path only warns', async () => {
    const failed = await _internals.planLoader(['a'], { target: neoforge('21.1.265'), newJars: [], workDir: '/tmp/w' }, panel({}), ops());
    assert.match(failed.abort, /could not read the startup command of a/);

    const custom = await _internals.planLoader(['a'], { target: neoforge('21.1.265'), newJars: [], workDir: '/tmp/w' },
        panel({ startups: { a: 'bash start.sh' } }), ops());
    assert.strictEqual(custom.abort, null);
    assert.strictEqual(custom.bump, null);
    assert.match(custom.note, /the startup of a names no NeoForge version/);
});

test('Forge bumps are reported, never switched', async () => {
    const loaderOps = ops();
    const result = await _internals.planLoader(['a'], { target: { loader: 'forge', version: '47.3.10' }, newJars: [], workDir: '/tmp/w' },
        panel({ startups: { a: 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt nogui' } }), loaderOps);
    assert.strictEqual(result.abort, null);
    assert.strictEqual(result.bump, null);
    assert.match(result.note, /The updater does not switch Forge/);
    assert.match(result.note, /47\.3\.0 on a/);
    assert.strictEqual(loaderOps.calls.prepare.length, 0);
});

test('other loaders are not checked and cost no panel call', async () => {
    const client = panel({});
    const result = await _internals.planLoader(['a'], { target: { loader: 'fabric', version: '0.16.9' } }, client, ops());
    assert.strictEqual(result.abort, null);
    assert.match(result.note, /fabric 0\.16\.9, not checked/);
    assert.deepStrictEqual(client.startupReads, []);
});

test('a failed fetch of the new jars aborts', async () => {
    const result = await _internals.planLoader(['a'], {
        target: neoforge('21.1.262'),
        newJars: async () => { throw new Error('CDN down'); },
        workDir: '/tmp/w'
    }, panel({ startups: { a: startupOn('21.1.262') } }), ops());
    assert.match(result.abort, /could not fetch the new jars.*CDN down/);
});

test('runPreflight reports an abort and returns null, or the notes and the plan', async () => {
    let log = '';
    const report = async (text) => { log += text; };
    const refused = await _internals.runPreflight(['a'], { oldSizes: new Map(), deletions: [], loader: null, pause: async () => {} }, report, panel({}), ops());
    assert.strictEqual(refused, null);
    assert.match(log, /\*\*Aborting before the stop: the panel listed no mods\/ on a.*Nothing was touched\.\*\*/);

    log = '';
    const client = panel({
        startups: { a: startupOn('21.1.262') },
        files: { a: { '/mods': [{ name: 'a.jar', size: 1, is_file: true }] } }
    });
    const ok = await _internals.runPreflight(['a'], {
        oldSizes: new Map([['a.jar', 1]]),
        deletions: [],
        loader: { target: neoforge('21.1.262'), newJars: [], workDir: '/tmp/w' }
    }, report, client, ops());
    assert.deepStrictEqual(ok, { bump: null });
    assert.match(log, /Pre-flight checks\.\.\. Done!\n- Patched jars kept: 0\.\n- Loader: NeoForge 21\.1\.262, no switch needed/);
});

test('switchLoader confirms the unpack, saves the old startup, patches and verifies', async () => {
    const recordDir = scratch();
    const servers = { a: appServer(239, 'a', '21.1.262') };
    const client = panel({
        servers,
        files: { a: { '/libraries/net/neoforged/neoforge/21.1.265': [{ name: 'unix_args.txt', is_file: true }] } }
    });
    const from = await _internals.switchLoader({ tag: 'shadow' }, 'a', '21.1.265', { client, recordDir });
    assert.strictEqual(from, '21.1.262');
    assert.strictEqual(client.patches.length, 1);
    assert.strictEqual(client.patches[0].id, 239);
    assert.match(client.patches[0].body.startup, /neoforge\/21\.1\.265\/unix_args\.txt/);
    assert.deepStrictEqual(client.patches[0].body.environment, { NEOFORGE_VERSION: '21.1.265' });
    const saved = JSON.parse(fs.readFileSync(path.join(recordDir, 'startup-before-neoforge-21.1.265.json'), 'utf8'));
    assert.match(saved.container.startup_command, /21\.1\.262/);
});

test('switchLoader leaves the startup alone when the new libraries are not on the panel', async () => {
    const client = panel({ servers: { a: appServer(1, 'a', '21.1.262') } });
    await assert.rejects(_internals.switchLoader({ tag: 'shadow' }, 'a', '21.1.265', { client, recordDir: scratch() }),
        /unix_args\.txt is not on a after the unpack/);
    assert.strictEqual(client.patches.length, 0);
});

test('switchLoader fails when the panel does not show the new startup afterwards', async () => {
    const client = panel({
        servers: { a: appServer(1, 'a', '21.1.262') },
        files: { a: { '/libraries/net/neoforged/neoforge/21.1.265': [{ name: 'unix_args.txt', is_file: true }] } },
        patchApplies: false
    });
    await assert.rejects(_internals.switchLoader({ tag: 'shadow' }, 'a', '21.1.265', { client, recordDir: scratch() }),
        /does not show NeoForge 21\.1\.265/);
});

test('changedJars lists only jars directly in mods/ that exist', () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, 'mods', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'mods', 'a.jar'), 'x');
    fs.writeFileSync(path.join(root, 'mods', 'sub', 'b.jar'), 'x');
    assert.deepStrictEqual(_internals.changedJars(['/mods/a.jar', '/mods/sub/b.jar', '/config/x.toml', '/mods/gone.jar'], root),
        [path.join(root, 'mods', 'a.jar')]);
});
