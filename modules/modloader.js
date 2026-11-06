/*
 * File: modloader.js
 * Project: valhalla-updater
 * -----
 * Mod loader checks for an update: which loader the new pack wants, which one each
 * instance runs, whether the new jars accept it, and the NeoForge server files a bump needs.
 *
 * The updater never changed the loader, so a pack that needs a newer NeoForge failed to
 * boot. Our NeoForge servers start with `@libraries/net/neoforged/neoforge/<ver>/unix_args.txt`
 * in the panel startup command, so the startup names the version that runs. Forge 1.20.1
 * uses `libraries/net/minecraftforge/forge/<mc>-<ver>/unix_args.txt`; that one is only reported.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    spawn
} = require('child_process');
const axios = require('axios');
const yauzl = require('yauzl');
const {
    download
} = require('./downloader');
const sessionLogger = require('./sessionLogger');

// The version part excludes braces, so a {{NEOFORGE_VERSION}} template is not read as a version
const NEOFORGE_ARGS = /libraries\/net\/neoforged\/neoforge\/([^/\s{}]+)\/unix_args\.txt/;
const FORGE_ARGS = /libraries\/net\/minecraftforge\/forge\/([^/\s{}]+)\/unix_args\.txt/;
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
// Versions end up in URLs and paths
const VERSION_SHAPE = /^[0-9][0-9A-Za-z.+-]*$/;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/* ---------- versions and ranges ---------- */

function splitVersion(version) {
    const match = String(version).trim().match(/^(\d+(?:\.\d+)*)(.*)$/);
    if (!match) return { parts: [], qualifier: String(version).trim() };
    return {
        parts: match[1].split('.').map(Number),
        qualifier: match[2].replace(/^[-.+]/, '')
    };
}

/**
 * Compares two loader versions part by part as numbers, so 21.1.265 > 21.1.73.
 * Missing parts count as 0. A release outranks its own pre-release (21.1.0 > 21.1.0-beta).
 * @returns {number} -1, 0 or 1.
 */
function compareVersions(a, b) {
    const left = splitVersion(a);
    const right = splitVersion(b);
    const length = Math.max(left.parts.length, right.parts.length);
    for (let i = 0; i < length; i++) {
        const delta = (left.parts[i] || 0) - (right.parts[i] || 0);
        if (delta !== 0) return delta < 0 ? -1 : 1;
    }
    if (left.qualifier === right.qualifier) return 0;
    if (!left.qualifier) return 1;
    if (!right.qualifier) return -1;
    return left.qualifier < right.qualifier ? -1 : 1;
}

function restrictionContains(group, version) {
    const inner = group.slice(1, -1);
    if (!inner.includes(',')) return compareVersions(version, inner.trim()) === 0;
    const [lower, upper] = inner.split(',').map(part => part.trim());
    if (lower) {
        const c = compareVersions(version, lower);
        if (c < 0 || (c === 0 && group[0] !== '[')) return false;
    }
    if (upper) {
        const c = compareVersions(version, upper);
        if (c > 0 || (c === 0 && group[group.length - 1] !== ']')) return false;
    }
    return true;
}

/**
 * Whether a Maven version range from mods.toml accepts a version, the way FML reads it:
 * "[21.1.265,)", "[21.1,21.2)", "[21.1.200]", unions like "[1,2),[3,)". A bare version or
 * "*" accepts everything.
 * @returns {boolean|null} null when the range cannot be read.
 */
function rangeContains(spec, version) {
    const text = String(spec ?? '').trim();
    if (text === '' || text === '*' || !/[[(]/.test(text)) return true;
    const groups = text.match(/[[(][^\])]*[\])]/g);
    if (!groups || groups.join(',').replace(/\s/g, '') !== text.replace(/\s/g, '')) return null;
    return groups.some(group => restrictionContains(group, version));
}

/* ---------- which loader ---------- */

/**
 * Reads the loader from a CurseForge server pack's variables.txt (ServerPackCreator).
 * @returns {{loader: string, version: string}|null}
 */
function parseVariablesTxt(text) {
    if (typeof text !== 'string') return null;
    const vars = {};
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (match) vars[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    if (!vars.MODLOADER || !vars.MODLOADER_VERSION) return null;
    return {
        loader: vars.MODLOADER.toLowerCase(),
        version: vars.MODLOADER_VERSION
    };
}

/**
 * Reads the loader from a pack manifest: CurseForge `minecraft.modLoaders`
 * ({id: "neoforge-21.1.265"}) or modpacks.ch `targets` ({type: "modloader", name, version}).
 * @returns {{loader: string, version: string}|null}
 */
function loaderFromManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return null;
    const modLoaders = manifest.minecraft && manifest.minecraft.modLoaders;
    if (Array.isArray(modLoaders) && modLoaders.length > 0) {
        const pick = modLoaders.find(entry => entry.primary) || modLoaders[0];
        const match = String(pick.id || '').match(/^([a-z]+)-(.+)$/i);
        if (match) return { loader: match[1].toLowerCase(), version: match[2] };
    }
    if (Array.isArray(manifest.targets)) {
        const target = manifest.targets.find(entry => entry.type === 'modloader');
        if (target && target.name && target.version) {
            return { loader: String(target.name).toLowerCase(), version: String(target.version) };
        }
    }
    return null;
}

/**
 * Reads the running loader off a panel startup command.
 * @returns {{loader: string, version: string}|null} Forge versions lose their "1.20.1-" prefix.
 */
function loaderFromStartup(startup) {
    const text = String(startup || '');
    let match = text.match(NEOFORGE_ARGS);
    if (match) return { loader: 'neoforge', version: match[1] };
    match = text.match(FORGE_ARGS);
    if (match) return { loader: 'forge', version: match[1].replace(/^\d+(?:\.\d+)*-/, '') };
    return null;
}

/* ---------- mods.toml ---------- */

function stripComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === '\\' && quote === '"') i++;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === '#') {
            return line.slice(0, i);
        }
    }
    return line;
}

function tomlValue(raw) {
    const value = raw.trim();
    const quoted = value.match(/^"((?:[^"\\]|\\.)*)"$/) || value.match(/^'([^']*)'$/);
    if (quoted) return quoted[1];
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}

function isRequired(props) {
    if (typeof props.side === 'string' && props.side.toUpperCase() === 'CLIENT') return false;
    if (typeof props.type === 'string') return props.type.toLowerCase() === 'required';
    return props.mandatory !== false;
}

/**
 * Finds the required dependencies on a loader in a mods.toml. A line scanner is enough:
 * FML files use `[[dependencies.<mod>]]` tables with flat key = value lines.
 * @param {string} tomlText Content of META-INF/neoforge.mods.toml or mods.toml.
 * @param {string} loaderId "neoforge" or "forge".
 * @returns {Array} {owner, versionRange} per required dependency.
 */
function loaderDependencies(tomlText, loaderId) {
    const tables = [];
    let current = null;
    let multiline = null;
    for (const raw of String(tomlText).split(/\r?\n/)) {
        if (multiline) {
            if (raw.includes(multiline)) multiline = null;
            continue;
        }
        const line = stripComment(raw).trim();
        if (!line) continue;
        const header = line.match(/^\[\[\s*dependencies\.\s*(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\s*\]\]$/);
        if (header) {
            current = { owner: header[1] || header[2] || header[3], props: {} };
            tables.push(current);
            continue;
        }
        if (line.startsWith('[')) {
            current = null;
            continue;
        }
        const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
        if (!pair) continue;
        const opener = ["'''", '"""'].find(quote => pair[2].startsWith(quote));
        if (opener) {
            if (!pair[2].slice(3).includes(opener)) multiline = opener;
            continue;
        }
        if (current) current.props[pair[1]] = tomlValue(pair[2]);
    }
    return tables
        .filter(table => table.props.modId === loaderId && typeof table.props.versionRange === 'string' && isRequired(table.props))
        .map(table => ({ owner: table.owner, versionRange: table.props.versionRange }));
}

/**
 * Reads the first of some small text entries from a zip.
 * @returns {Promise<string|null>} null when the file is no zip or has none of them.
 */
function readZipText(zipPath, names) {
    return new Promise((resolve) => {
        yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
            if (openError) return resolve(null);
            const found = {};
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                resolve(value);
            };
            zip.on('error', () => finish(null));
            zip.on('end', () => finish(names.map(name => found[name]).find(text => text !== undefined) ?? null));
            zip.on('entry', (entry) => {
                if (!names.includes(entry.fileName) || entry.uncompressedSize > 1024 * 1024) return zip.readEntry();
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError) return zip.readEntry();
                    const chunks = [];
                    stream.on('data', chunk => chunks.push(chunk));
                    stream.on('error', () => zip.readEntry());
                    stream.on('end', () => {
                        found[entry.fileName] = Buffer.concat(chunks).toString('utf8');
                        zip.readEntry();
                    });
                });
            });
            zip.readEntry();
        });
    });
}

/**
 * Lists the jars whose required loader range excludes a loader version.
 * @param {Array} jarPaths Local paths of the new and bumped jars.
 * @param {string} loaderId "neoforge" or "forge".
 * @param {string} version The loader version the server will run.
 * @returns {Promise<Array>} {jar, owner, range} per excluding dependency.
 */
async function checkJars(jarPaths, loaderId, version) {
    const names = loaderId === 'neoforge' ? ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml'] : ['META-INF/mods.toml'];
    const excluded = [];
    for (const jar of jarPaths) {
        const toml = await readZipText(jar, names);
        if (toml === null) continue;
        for (const dependency of loaderDependencies(toml, loaderId)) {
            // An unexpanded build template says nothing about the range
            if (dependency.versionRange.includes('${')) continue;
            const accepts = rangeContains(dependency.versionRange, version);
            if (accepts === null) {
                sessionLogger.warn('ModLoader', `Cannot read the ${loaderId} range "${dependency.versionRange}" in ${path.basename(jar)}, skipping it`);
            } else if (!accepts) {
                excluded.push({ jar: path.basename(jar), owner: dependency.owner, range: dependency.versionRange });
            }
        }
    }
    return excluded;
}

/* ---------- panel startup ---------- */

/**
 * Builds the application API PATCH body that moves a server's startup to another NeoForge.
 * Port of tickets-valhalla/scripts/neoforge-startup-switch.py: the environment is echoed
 * back without the panel's own P_SERVER_* and STARTUP keys, NEOFORGE_VERSION follows the
 * startup, skip_scripts is true (the API needs the field), egg and image stay.
 * @param {Object} server Application API server attributes.
 * @param {string} version Target NeoForge version.
 * @returns {{from: string, body: Object}|null} null when the startup already runs that version.
 * @throws If the startup names no NeoForge version.
 */
function planStartupSwitch(server, version) {
    const container = server.container || {};
    const startup = String(container.startup_command || '');
    const env = container.environment || {};
    const match = startup.match(NEOFORGE_ARGS);
    const templated = !match && /\{\{\s*NEOFORGE_VERSION\s*\}\}/.test(startup) && 'NEOFORGE_VERSION' in env;
    if (!match && !templated) {
        throw new Error(`the startup of ${server.identifier || server.uuid} has no NeoForge unix_args path`);
    }
    const from = match ? match[1] : String(env.NEOFORGE_VERSION);
    if (from === version) return null;

    const environment = Object.fromEntries(Object.entries(env)
        .filter(([key]) => !key.startsWith('P_SERVER_') && key !== 'STARTUP'));
    if ('NEOFORGE_VERSION' in environment) environment.NEOFORGE_VERSION = version;
    return {
        from,
        body: {
            startup: match ? startup.replace(new RegExp(NEOFORGE_ARGS.source, 'g'), `libraries/net/neoforged/neoforge/${version}/unix_args.txt`) : startup,
            environment,
            egg: server.egg,
            image: container.image,
            skip_scripts: true
        }
    };
}

/** @returns {boolean} Whether a server's application API attributes start the given NeoForge. */
function startupRuns(server, version) {
    const container = server.container || {};
    const startup = String(container.startup_command || '');
    if (startup.includes(`/neoforge/${version}/unix_args.txt`)) return true;
    return !NEOFORGE_ARGS.test(startup) && /\{\{\s*NEOFORGE_VERSION\s*\}\}/.test(startup) &&
        (container.environment || {}).NEOFORGE_VERSION === version;
}

/* ---------- NeoForge server files ---------- */

function assertVersion(version) {
    if (!VERSION_SHAPE.test(String(version))) throw new Error(`refusing NeoForge version ${JSON.stringify(version)}`);
}

/** NeoForge for 1.20.5 and newer needs Java 21, older ones Java 17. */
function requiredJava(neoforgeVersion) {
    const [major, minor] = splitVersion(neoforgeVersion).parts;
    return major > 20 || (major === 20 && minor >= 5) ? 21 : 17;
}

function outputTail(output, lines = 3) {
    return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-lines).join(' | ');
}

/** Runs a command, keeping the end of its output. Rejects when it cannot start or times out. */
function run(command, args, { cwd, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let output = '';
        const keep = (chunk) => {
            output = (output + chunk).slice(-8000);
        };
        let child;
        try {
            child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            return reject(error);
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 60000)} min`));
        }, timeoutMs);
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
    });
}

/**
 * Checks that Java runs on the updater host. The live updater is a Node container, so
 * this fails there until NEOFORGE_INSTALLER_JAVA points at a Java install.
 * @returns {Promise<{major: number|null, line: string}>}
 * @throws With a message that names the setting to fix.
 */
async function checkJava(java, minimum = 0) {
    const hint = `Set NEOFORGE_INSTALLER_JAVA in .env to a Java ${minimum || 21} binary on the updater host`;
    let result;
    try {
        result = await run(java, ['-version'], { timeoutMs: 30000 });
    } catch (error) {
        throw new Error(`no working Java at "${java}" (${error.code || error.message}). ${hint}`);
    }
    if (result.code !== 0) throw new Error(`"${java} -version" exited with ${result.code}. ${hint}`);
    const match = result.output.match(/version "(\d+)(?:\.(\d+))?/);
    const major = match ? (match[1] === '1' ? Number(match[2]) : Number(match[1])) : null;
    if (minimum && (major === null || major < minimum)) {
        throw new Error(`Java at "${java}" is ${major === null ? 'of unknown version' : `Java ${major}`}, NeoForge needs Java ${minimum}. ${hint}`);
    }
    return { major, line: result.output.trim().split(/\r?\n/)[0] };
}

/**
 * Downloads a NeoForge installer and checks it against the maven's checksum.
 * @returns {Promise<string>} Local path of the installer.
 */
async function fetchInstaller(version, dir) {
    assertVersion(version);
    const name = `neoforge-${version}-installer.jar`;
    const url = `${NEOFORGE_MAVEN}/${version}/${name}`;
    const target = path.join(dir, name);
    await download(url, target);

    for (const algorithm of ['sha256', 'sha1']) {
        let expected;
        try {
            const response = await axios.get(`${url}.${algorithm}`, { responseType: 'text', timeout: 30000 });
            expected = String(response.data).trim().split(/\s+/)[0].toLowerCase();
        } catch (error) {
            continue;
        }
        const actual = crypto.createHash(algorithm).update(fs.readFileSync(target)).digest('hex');
        if (actual !== expected) {
            fs.rmSync(target, { force: true });
            throw new Error(`${name} does not match the maven's ${algorithm}`);
        }
        return target;
    }
    fs.rmSync(target, { force: true });
    throw new Error(`the NeoForge maven gave no checksum for ${name}`);
}

/** Runs `java -jar <installer> --installServer <serverDir>`. */
async function runInstaller(java, installerPath, serverDir) {
    fs.mkdirSync(serverDir, { recursive: true });
    const absolute = path.resolve(installerPath);
    const { code, output } = await run(java, ['-jar', absolute, '--installServer', path.resolve(serverDir)], { cwd: path.dirname(absolute) });
    if (code !== 0) throw new Error(`the installer ${path.basename(installerPath)} exited with ${code}: ${outputTail(output)}`);
}

/** Map of path relative to dir -> sha1 of every file below it. */
function snapshotTree(dir) {
    const files = new Map();
    if (!fs.existsSync(dir)) return files;
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) files.set(path.relative(dir, full).split(path.sep).join('/'), crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'));
        }
    };
    walk(dir);
    return files;
}

/**
 * Installs a NeoForge server into scratch and collects the library files the live server lacks.
 *
 * The deployed tree only holds the old pack's top-level names, so `libraries/` must come
 * on its own. The running version is installed first into the same folder; the files the
 * new install then adds or changes are the payload, plus all of
 * libraries/net/neoforged/neoforge/<ver>/. When the running version cannot be installed,
 * every library goes, which is larger but safe: unpacking a library over itself changes nothing.
 * @param {string} version Target NeoForge version.
 * @param {string} workDir Scratch folder, wiped first.
 * @param {Object} options java, baseVersion (the running version), fetch and install (injectable for tests).
 * @returns {Promise<Object>} {payloadDir, files, bytes, diffedAgainst}. payloadDir holds libraries/...
 * @throws If the target version cannot be installed.
 */
async function prepareNeoForge(version, workDir, options = {}) {
    assertVersion(version);
    if (options.baseVersion) assertVersion(options.baseVersion);
    const fetch = options.fetch || fetchInstaller;
    const install = options.install || runInstaller;
    const java = options.java || 'java';

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    const serverDir = path.join(workDir, 'server');
    const libraries = path.join(serverDir, 'libraries');

    let before = new Map();
    let diffedAgainst = null;
    if (options.baseVersion && options.baseVersion !== version) {
        try {
            await install(java, await fetch(options.baseVersion, workDir), serverDir);
            before = snapshotTree(libraries);
            diffedAgainst = options.baseVersion;
        } catch (error) {
            sessionLogger.warn('ModLoader', `Could not install NeoForge ${options.baseVersion} to diff against, shipping every library: ${error.message}`);
            fs.rmSync(serverDir, { recursive: true, force: true });
            before = new Map();
        }
    }

    await install(java, await fetch(version, workDir), serverDir);
    const own = `net/neoforged/neoforge/${version}/`;
    if (!fs.existsSync(path.join(libraries, own, 'unix_args.txt'))) {
        throw new Error(`the NeoForge ${version} install produced no ${own}unix_args.txt`);
    }

    const after = snapshotTree(libraries);
    const files = [...after.entries()]
        .filter(([rel, sha1]) => rel.startsWith(own) || before.get(rel) !== sha1)
        .map(([rel]) => rel)
        .sort();

    const payloadDir = path.join(workDir, 'payload');
    let bytes = 0;
    for (const rel of files) {
        const dest = path.join(payloadDir, 'libraries', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(libraries, rel), dest);
        bytes += fs.statSync(dest).size;
    }
    sessionLogger.info('ModLoader', `NeoForge ${version} payload: ${files.length} file(s), ${bytes} bytes${diffedAgainst ? `, diffed against ${diffedAgainst}` : ', full library set'}: ${files.join(', ')}`);
    return {
        payloadDir,
        files,
        bytes,
        diffedAgainst
    };
}

module.exports = {
    NEOFORGE_ARGS,
    FORGE_ARGS,
    compareVersions,
    rangeContains,
    parseVariablesTxt,
    loaderFromManifest,
    loaderFromStartup,
    loaderDependencies,
    readZipText,
    checkJars,
    planStartupSwitch,
    startupRuns,
    requiredJava,
    checkJava,
    fetchInstaller,
    runInstaller,
    snapshotTree,
    prepareNeoForge
};
