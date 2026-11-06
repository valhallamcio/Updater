/*
 * Unit tests for modules/modloader.js - loader versions, mods.toml ranges, the startup switch.
 * Run: npm test   (node --test test/*.test.js)
 *
 * The case behind this module: Shadowfall 1.1.4 (2026-11-06) shipped apoli 1.124.0, which needs
 * NeoForge [21.1.265,), while the server ran 21.1.262. The updater never touched the loader,
 * so the pack would not have booted. The apoli toml below is copied from that jar.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archiver = require('archiver');

const modloader = require('../modules/modloader');

const APOLI_TOML = `modLoader="javafml"
loaderVersion="[1,)"
license="The A/O License"

[[mods]]
modId="apoli"
version="1.124.0"
description='''
Data-pack-driven Powers library for NeoForge 1.21.1.
[[dependencies.fake]]
modId="neoforge"
versionRange="[99,)"
'''

[[dependencies.apoli]]
    modId="neoforge"
    type="required"
    versionRange="[21.1.265,)"
    ordering="NONE"
    side="BOTH"

[[dependencies.apoli]]
    modId="minecraft"
    type="required"
    versionRange="[1.21.1]"
    ordering="NONE"
    side="BOTH"

[[dependencies.apoli]]
    modId="origins"
    type="incompatible"
    reason="Origins older than 1.49.0 was built against an older Apoli API. Update Origins."
`;

// biforesting gates on a range that still holds after the switch
const BIFORESTING_TOML = `[[mods]]
modId = 'biforesting' # our profiler
[[dependencies.biforesting]]
modId = 'neoforge'   # the loader
versionRange = '[21.1,21.2)'
`;

const STARTUP = 'java -Xms128M -XX:MaxRAMPercentage=95.0 -Dterminal.jline=false -Dterminal.ansi=true @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.262/unix_args.txt nogui';

let tmpRoot = null;
const scratch = () => {
    if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-modloader-'));
    return fs.mkdtempSync(path.join(tmpRoot, 'case-'));
};

function makeJar(file, entries) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(file);
        const archive = archiver('zip');
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
        archive.finalize();
    });
}

test('versions compare part by part as numbers', () => {
    assert.strictEqual(modloader.compareVersions('21.1.265', '21.1.262'), 1);
    assert.strictEqual(modloader.compareVersions('21.1.265', '21.1.73'), 1);
    assert.strictEqual(modloader.compareVersions('21.1.9', '21.1.10'), -1);
    assert.strictEqual(modloader.compareVersions('21.1', '21.1.0'), 0);
    assert.strictEqual(modloader.compareVersions('47.3.10', '47.3.0'), 1);
    assert.strictEqual(modloader.compareVersions('21.1.0-beta', '21.1.0'), -1);
    assert.strictEqual(modloader.compareVersions('21.1.1-beta', '21.1.0'), 1);
});

test('Maven ranges are read the way FML reads them', () => {
    assert.strictEqual(modloader.rangeContains('[21.1.265,)', '21.1.262'), false, 'apoli refuses the old loader');
    assert.strictEqual(modloader.rangeContains('[21.1.265,)', '21.1.265'), true);
    assert.strictEqual(modloader.rangeContains('(21.1.265,)', '21.1.265'), false, 'exclusive lower bound');
    assert.strictEqual(modloader.rangeContains('[21.1,21.2)', '21.1.265'), true, 'biforesting gate holds');
    assert.strictEqual(modloader.rangeContains('[21.1,21.2)', '21.2'), false);
    assert.strictEqual(modloader.rangeContains('[21.1,21.2]', '21.2.0'), true);
    assert.strictEqual(modloader.rangeContains('(,21.1.100]', '21.1.262'), false);
    assert.strictEqual(modloader.rangeContains('[1.21.1]', '1.21.1'), true);
    assert.strictEqual(modloader.rangeContains('[21.1.200]', '21.1.265'), false);
    assert.strictEqual(modloader.rangeContains('[20,21),[21.1.300,)', '21.1.265'), false);
    assert.strictEqual(modloader.rangeContains('[20,21),[21.1.200,)', '21.1.265'), true);
    assert.strictEqual(modloader.rangeContains('*', '21.1.265'), true);
    assert.strictEqual(modloader.rangeContains('', '21.1.265'), true);
    assert.strictEqual(modloader.rangeContains('21.1.0', '21.1.265'), true, 'a bare version accepts any');
    assert.strictEqual(modloader.rangeContains('[21.1,', '21.1.265'), null, 'unreadable');
});

test('variables.txt names the loader of a CurseForge server pack', () => {
    const text = 'MINECRAFT_VERSION=1.21.1\r\nMODLOADER=NeoForge\r\nMODLOADER_VERSION=21.1.265\r\nJAVA_ARGS="-Xmx4G"\r\n';
    assert.deepStrictEqual(modloader.parseVariablesTxt(text), { loader: 'neoforge', version: '21.1.265' });
    assert.deepStrictEqual(modloader.parseVariablesTxt('MODLOADER="Forge"\nMODLOADER_VERSION="47.3.0"\n'), { loader: 'forge', version: '47.3.0' });
    assert.strictEqual(modloader.parseVariablesTxt('MINECRAFT_VERSION=1.21.1\n'), null);
    assert.strictEqual(modloader.parseVariablesTxt(null), null);
});

test('manifests name the loader: CurseForge modLoaders and modpacks.ch targets', () => {
    assert.deepStrictEqual(modloader.loaderFromManifest({
        minecraft: { version: '1.21.1', modLoaders: [{ id: 'neoforge-21.1.265', primary: true }] }
    }), { loader: 'neoforge', version: '21.1.265' });
    assert.deepStrictEqual(modloader.loaderFromManifest({
        targets: [
            { name: 'minecraft', type: 'game', version: '1.21.1' },
            { name: 'neoforge', type: 'modloader', version: '21.1.265' }
        ]
    }), { loader: 'neoforge', version: '21.1.265' });
    assert.deepStrictEqual(modloader.loaderFromManifest({
        minecraft: { modLoaders: [{ id: 'forge-47.3.0' }] }
    }), { loader: 'forge', version: '47.3.0' });
    assert.strictEqual(modloader.loaderFromManifest({ files: [] }), null);
    assert.strictEqual(modloader.loaderFromManifest(null), null);
});

test('the panel startup names the running loader', () => {
    assert.deepStrictEqual(modloader.loaderFromStartup(STARTUP), { loader: 'neoforge', version: '21.1.262' });
    assert.deepStrictEqual(modloader.loaderFromStartup('java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt nogui'),
        { loader: 'forge', version: '47.3.0' });
    assert.strictEqual(modloader.loaderFromStartup('java -jar server.jar'), null);
});

test('mods.toml: only required loader dependencies count', () => {
    assert.deepStrictEqual(modloader.loaderDependencies(APOLI_TOML, 'neoforge'), [{ owner: 'apoli', versionRange: '[21.1.265,)' }],
        'the fake header inside the description is ignored');
    assert.deepStrictEqual(modloader.loaderDependencies(BIFORESTING_TOML, 'neoforge'), [{ owner: 'biforesting', versionRange: '[21.1,21.2)' }]);

    const skipped = `[[dependencies.a]]
modId="neoforge"
type="optional"
versionRange="[99,)"
[[dependencies.b]]
modId="forge"
mandatory=false
versionRange="[99,)"
[[dependencies.c]]
modId="neoforge"
side="CLIENT"
versionRange="[99,)"
[[dependencies.d]]
modId="forge"
mandatory=true
versionRange="[47,)"
`;
    assert.deepStrictEqual(modloader.loaderDependencies(skipped, 'neoforge'), []);
    assert.deepStrictEqual(modloader.loaderDependencies(skipped, 'forge'), [{ owner: 'd', versionRange: '[47,)' }]);
});

test('checkJars names the jar whose range excludes the loader', async () => {
    const dir = scratch();
    await makeJar(path.join(dir, 'apoli-1.124.0.jar'), { 'META-INF/neoforge.mods.toml': APOLI_TOML });
    await makeJar(path.join(dir, 'biforesting.jar'), { 'META-INF/neoforge.mods.toml': BIFORESTING_TOML });
    await makeJar(path.join(dir, 'library.jar'), { 'a/B.class': 'x' });
    fs.writeFileSync(path.join(dir, 'broken.jar'), 'not a zip');
    const jars = ['apoli-1.124.0.jar', 'biforesting.jar', 'library.jar', 'broken.jar'].map(name => path.join(dir, name));

    assert.deepStrictEqual(await modloader.checkJars(jars, 'neoforge', '21.1.262'), [
        { jar: 'apoli-1.124.0.jar', owner: 'apoli', range: '[21.1.265,)' }
    ]);
    assert.deepStrictEqual(await modloader.checkJars(jars, 'neoforge', '21.1.265'), []);
    assert.deepStrictEqual(await modloader.checkJars(jars, 'neoforge', '21.2.0'), [
        { jar: 'biforesting.jar', owner: 'biforesting', range: '[21.1,21.2)' }
    ]);
});

test('planStartupSwitch matches the panel switch script', () => {
    const server = {
        id: 239,
        identifier: 'be816fa3',
        egg: 17,
        container: {
            startup_command: STARTUP,
            image: 'ghcr.io/parkervcp/yolks:java_21',
            environment: {
                NEOFORGE_VERSION: '21.1.262',
                SERVER_JARFILE: 'server.jar',
                STARTUP: STARTUP,
                P_SERVER_LOCATION: 'plutonium',
                P_SERVER_UUID: 'be816fa3-c97b-45b0-b527-cb614e8062b3',
                P_SERVER_ALLOCATION_LIMIT: 0
            }
        }
    };
    const plan = modloader.planStartupSwitch(server, '21.1.265');
    assert.strictEqual(plan.from, '21.1.262');
    assert.deepStrictEqual(plan.body, {
        startup: STARTUP.replace('21.1.262', '21.1.265'),
        environment: { NEOFORGE_VERSION: '21.1.265', SERVER_JARFILE: 'server.jar' },
        egg: 17,
        image: 'ghcr.io/parkervcp/yolks:java_21',
        skip_scripts: true
    });
    assert.strictEqual(modloader.planStartupSwitch(server, '21.1.262'), null, 'already on it');
    assert.throws(() => modloader.planStartupSwitch({ identifier: 'x', container: { startup_command: 'java -jar server.jar', environment: {} } }, '21.1.265'),
        /no NeoForge unix_args path/);

    const templated = {
        identifier: 'y',
        container: {
            startup_command: 'java @libraries/net/neoforged/neoforge/{{NEOFORGE_VERSION}}/unix_args.txt',
            environment: { NEOFORGE_VERSION: '21.1.262' }
        }
    };
    const templatedPlan = modloader.planStartupSwitch(templated, '21.1.265');
    assert.strictEqual(templatedPlan.from, '21.1.262');
    assert.strictEqual(templatedPlan.body.environment.NEOFORGE_VERSION, '21.1.265');
    assert.strictEqual(templatedPlan.body.startup, templated.container.startup_command, 'the template stays a template');
});

test('startupRuns confirms the switch from the panel answer', () => {
    const on = (startup, env = {}) => ({ container: { startup_command: startup, environment: env } });
    assert.ok(modloader.startupRuns(on(STARTUP.replace('21.1.262', '21.1.265')), '21.1.265'));
    assert.ok(!modloader.startupRuns(on(STARTUP), '21.1.265'));
    assert.ok(modloader.startupRuns(on('java @libraries/net/neoforged/neoforge/{{NEOFORGE_VERSION}}/unix_args.txt', { NEOFORGE_VERSION: '21.1.265' }), '21.1.265'));
});

test('NeoForge for 1.20.5 and newer needs Java 21', () => {
    assert.strictEqual(modloader.requiredJava('21.1.265'), 21);
    assert.strictEqual(modloader.requiredJava('20.6.119'), 21);
    assert.strictEqual(modloader.requiredJava('20.4.237'), 17);
});

test('checkJava fails with the setting to fix when Java is missing', async () => {
    await assert.rejects(modloader.checkJava('/nonexistent/java', 21), /NEOFORGE_INSTALLER_JAVA/);
});

/** A fake installer: writes a libraries tree like NeoForge's for the given version. */
function fakeInstall(trees) {
    return async (java, installer, serverDir) => {
        const version = path.basename(installer);
        if (!trees[version]) throw new Error(`no install for ${version}`);
        for (const [rel, content] of Object.entries(trees[version])) {
            const full = path.join(serverDir, 'libraries', rel);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }
    };
}
const fakeFetch = async (version) => version;

const TREES = {
    '21.1.262': {
        'net/neoforged/neoforge/21.1.262/unix_args.txt': 'old args',
        'net/neoforged/fancymodloader/loader/4.0.42/loader-4.0.42.jar': 'fml 42',
        'com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar': 'brigadier',
        'net/minecraft/server/1.21.1-20240808.144430/server-1.21.1-20240808.144430-srg.jar': 'srg v1'
    },
    '21.1.265': {
        'net/neoforged/neoforge/21.1.265/unix_args.txt': 'new args',
        'net/neoforged/neoforge/21.1.265/neoforge-21.1.265-server.jar': 'patched',
        'net/neoforged/fancymodloader/loader/4.0.45/loader-4.0.45.jar': 'fml 45',
        'com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar': 'brigadier',
        'net/minecraft/server/1.21.1-20240808.144430/server-1.21.1-20240808.144430-srg.jar': 'srg v2'
    }
};

test('prepareNeoForge ships the new version dir and what the install added or changed', async () => {
    const workDir = path.join(scratch(), 'loader');
    const prepared = await modloader.prepareNeoForge('21.1.265', workDir, {
        baseVersion: '21.1.262',
        fetch: fakeFetch,
        install: fakeInstall(TREES)
    });
    assert.strictEqual(prepared.diffedAgainst, '21.1.262');
    assert.deepStrictEqual(prepared.files, [
        'net/minecraft/server/1.21.1-20240808.144430/server-1.21.1-20240808.144430-srg.jar',
        'net/neoforged/fancymodloader/loader/4.0.45/loader-4.0.45.jar',
        'net/neoforged/neoforge/21.1.265/neoforge-21.1.265-server.jar',
        'net/neoforged/neoforge/21.1.265/unix_args.txt'
    ]);
    assert.strictEqual(fs.readFileSync(path.join(prepared.payloadDir, 'libraries/net/neoforged/neoforge/21.1.265/unix_args.txt'), 'utf8'), 'new args');
    assert.ok(!fs.existsSync(path.join(prepared.payloadDir, 'libraries/com/mojang')), 'unchanged libraries stay out');
});

test('prepareNeoForge ships every library when the running version cannot be installed', async () => {
    const prepared = await modloader.prepareNeoForge('21.1.265', path.join(scratch(), 'loader'), {
        baseVersion: '21.1.1',
        fetch: fakeFetch,
        install: fakeInstall(TREES)
    });
    assert.strictEqual(prepared.diffedAgainst, null);
    assert.strictEqual(prepared.files.length, Object.keys(TREES['21.1.265']).length);
});

test('prepareNeoForge refuses an install without unix_args.txt and odd version strings', async () => {
    const broken = { '21.1.265': { 'net/neoforged/neoforge/21.1.265/neoforge-21.1.265-server.jar': 'x' } };
    await assert.rejects(modloader.prepareNeoForge('21.1.265', path.join(scratch(), 'loader'), { fetch: fakeFetch, install: fakeInstall(broken) }),
        /no net\/neoforged\/neoforge\/21\.1\.265\/unix_args\.txt/);
    await assert.rejects(modloader.prepareNeoForge('../21', path.join(scratch(), 'loader'), { fetch: fakeFetch, install: fakeInstall(TREES) }),
        /refusing NeoForge version/);
});
