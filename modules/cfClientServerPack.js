/*
 * File: cfClientServerPack.js
 * Project: valhalla-updater
 * -----
 * Server packs built from a CurseForge client pack, for packs whose author ships no
 * server pack. The client zip names its mods in manifest.json. The build fetches the
 * mods a server needs, copies the overrides, and writes one zip with the layout of a
 * server pack: mods/, the override folders and manifest.json at the root.
 *
 * The update three-way merges old against new against live, so the output is
 * deterministic: the same inputs give the same entries in the same order, with the
 * same bytes and the same entry times. Any missing or short file fails the whole
 * build. There is no partial pack.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    pipeline
} = require('stream/promises');
const archiver = require('archiver');
const axios = require('axios');
const {
    decompress
} = require('./compressor');

// CurseForge classId of "Mods". Resource packs, shaders, worlds and data packs have others.
const MOD_CLASS_ID = 6;

// Override paths only a client reads.
const CLIENT_ONLY_PATHS = [
    /^resourcepacks\//,
    /^shaderpacks\//,
    /^options\.txt$/,
    /^servers\.dat$/,
    /^config\/jei\/world\//
];

const DOWNLOAD_CONCURRENCY = 6;

// A stalled CDN connection must fail the build, not hang it. Idle time, not total time.
const IDLE_TIMEOUT_MS = 60000;

// Every entry gets this time. The real times would make two builds of one version differ.
const ENTRY_DATE = new Date('2000-01-01T00:00:00Z');

const STORE_ONLY = /\.(jar|zip)$/i;

/**
 * Compiles an exclude list. A positive integer, or a string of digits, is a CurseForge
 * modId. Any other string is a regex tested against the jar file name, case-insensitive.
 * @param {Array} [list] Exclude entries.
 * @returns {{modIds: Set<number>, patterns: RegExp[]}}
 * @throws If the list or an entry is invalid.
 */
function parseExclude(list) {
    if (list === undefined || list === null) list = [];
    if (!Array.isArray(list)) throw new Error('cf-client exclude must be a list of modIds or file name regexes');
    const modIds = new Set();
    const patterns = [];
    for (const item of list) {
        if (Number.isInteger(item) && item > 0) {
            modIds.add(item);
        } else if (typeof item === 'string' && /^\d+$/.test(item.trim())) {
            modIds.add(Number(item.trim()));
        } else if (typeof item === 'string' && item.trim() !== '') {
            try {
                patterns.push(new RegExp(item.trim(), 'i'));
            } catch (error) {
                throw new Error(`cf-client exclude entry ${JSON.stringify(item)} is not a valid regex: ${error.message}`);
            }
        } else {
            throw new Error(`cf-client exclude entry ${JSON.stringify(item)} is neither a modId nor a file name regex`);
        }
    }
    return { modIds, patterns };
}

/**
 * Checks a cf-client server pack source from config.json serverPackSources.
 * @param {object} source {type: "cf-client", exclude: [modId or file name regex, ...]}.
 * @returns {{exclude: Array}} The raw exclude list, checked.
 * @throws If the type or the exclude list is invalid.
 */
function parseSource(source) {
    if (!source || source.type !== 'cf-client') {
        throw new Error(`server pack source type must be "cf-client", got ${JSON.stringify(source?.type)}`);
    }
    parseExclude(source.exclude);
    return { exclude: source.exclude || [] };
}

/** True for a file CurseForge tags for clients and not for servers. */
function isClientOnly(file) {
    const versions = file.gameVersions || [];
    return versions.includes('Client') && !versions.includes('Server');
}

/** True for an override path (relative, "/"-separated) that only a client reads. */
function isClientOnlyPath(rel) {
    return CLIENT_ONLY_PATHS.some(pattern => pattern.test(rel));
}

/** A plain file name: no folder part, no dot start. CurseForge data is untrusted. */
function isPlainName(name) {
    return typeof name === 'string' && name !== '' && name === path.posix.basename(name) &&
        !name.includes('\\') && !name.startsWith('.');
}

/** The CDN address of a file, for files whose author turned off direct downloads. */
function cdnUrl(fileId, fileName) {
    return `https://edge.forgecdn.net/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`;
}

/** The sha1 CurseForge lists for a file (algo 1), or null. */
function sha1Of(file) {
    const hash = (file.hashes || []).find(h => h.algo === 1 && typeof h.value === 'string');
    return hash ? hash.value.toLowerCase() : null;
}

/** Plain code-unit order, the same on every host and locale. */
function byName(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The exclude entries a jar matches.
 * @returns {string[]} One reason per matching entry.
 */
function excludeReasons(modId, fileName, exclude, used) {
    const reasons = [];
    if (modId !== null && exclude.modIds.has(modId)) {
        reasons.push(`excluded by modId ${modId}`);
        used.add(modId);
    }
    for (const pattern of exclude.patterns) {
        if (pattern.test(fileName)) {
            reasons.push(`excluded by /${pattern.source}/`);
            used.add(pattern);
        }
    }
    return reasons;
}

/**
 * Decides which manifest files go into the server pack.
 * @param {Array} entries manifest.json files ({projectID, fileID}).
 * @param {Array} files CurseForge file data for those file ids.
 * @param {Array} mods CurseForge mod data for their projects.
 * @param {object} exclude From parseExclude.
 * @returns {{keep: Array, skipped: Array, used: Set}} keep: {fileId, modId, name, fileName, size,
 *   sha1, url}, sorted by file name. skipped: {fileId, modId, name, fileName, reasons}.
 *   used: the exclude entries that matched something.
 * @throws When a file or mod has no data, or a file name is unsafe or taken twice.
 */
function planFiles(entries, files, mods, exclude) {
    const fileById = new Map((files || []).map(f => [f.id, f]));
    const modById = new Map((mods || []).map(m => [m.id, m]));
    const keep = [];
    const skipped = [];
    const used = new Set();
    const names = new Set();

    for (const entry of entries) {
        const fileId = entry && entry.fileID;
        const modId = entry && entry.projectID;
        if (!Number.isInteger(fileId) || !Number.isInteger(modId)) {
            throw new Error(`manifest.json has an entry without a numeric projectID and fileID: ${JSON.stringify(entry)}`);
        }
        const file = fileById.get(fileId);
        if (!file) throw new Error(`CurseForge has no data for file ${fileId} (mod ${modId})`);
        if (file.modId !== modId) throw new Error(`CurseForge file ${fileId} belongs to mod ${file.modId}, the manifest says ${modId}`);
        const mod = modById.get(modId);
        if (!mod) throw new Error(`CurseForge has no data for mod ${modId} (file ${fileId})`);
        if (!isPlainName(file.fileName)) throw new Error(`CurseForge file ${fileId} has an unsafe file name ${JSON.stringify(file.fileName)}`);

        const row = { fileId, modId, name: mod.name || String(modId), fileName: file.fileName };
        const reasons = [];
        if (mod.classId !== MOD_CLASS_ID) reasons.push(`not a mod (classId ${mod.classId})`);
        if (isClientOnly(file)) reasons.push('client only (CurseForge lists Client, not Server)');
        reasons.push(...excludeReasons(modId, file.fileName, exclude, used));
        if (reasons.length > 0) {
            skipped.push({ ...row, reasons });
            continue;
        }

        if (names.has(file.fileName)) throw new Error(`two manifest files are named ${file.fileName}`);
        names.add(file.fileName);
        if (!Number.isInteger(file.fileLength) || file.fileLength <= 0) {
            throw new Error(`CurseForge gives no size for ${file.fileName} (file ${fileId})`);
        }
        keep.push({
            ...row,
            size: file.fileLength,
            sha1: sha1Of(file),
            url: file.downloadUrl || cdnUrl(fileId, file.fileName)
        });
    }

    keep.sort((a, b) => byName(a.fileName, b.fileName));
    skipped.sort((a, b) => byName(a.fileName, b.fileName));
    return { keep, skipped, used };
}

/** The exclude entries that matched nothing, as written in the list. */
function unusedExclude(exclude, used) {
    return [
        ...[...exclude.modIds].filter(id => !used.has(id)).map(String),
        ...exclude.patterns.filter(p => !used.has(p)).map(p => p.source)
    ];
}

/**
 * The override files that go into the server pack, relative and "/"-separated.
 * Client-only paths stay out. A jar in mods/ is checked against the exclude list too.
 * @returns {{keep: string[], skipped: Array}} keep is sorted.
 */
function planOverrides(root, exclude, used) {
    const keep = [];
    const skipped = [];
    const walk = (dir, rel) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), childRel);
            } else if (entry.isFile()) {
                if (isClientOnlyPath(childRel)) {
                    skipped.push({ path: childRel, reasons: ['client-only path'] });
                    continue;
                }
                const reasons = /^mods\/[^/]+$/.test(childRel) ? excludeReasons(null, entry.name, exclude, used) : [];
                if (reasons.length > 0) skipped.push({ path: childRel, reasons });
                else keep.push(childRel);
            }
        }
    };
    walk(root, '');
    keep.sort(byName);
    skipped.sort((a, b) => byName(a.path, b.path));
    return { keep, skipped };
}

/**
 * Streams one URL to a new file and checks what landed.
 * @param {object} http axios-like client.
 * @param {object} expected {size, sha1}, each optional. Without a size the content-length
 *   is checked when the body was not encoded in transit.
 * @throws On a request error, a short or long file, or a hash mismatch.
 */
async function fetchTo(http, url, dest, expected = {}) {
    const name = path.basename(dest);
    const response = await http.get(url, {
        responseType: 'stream',
        timeout: IDLE_TIMEOUT_MS
    });
    const hash = expected.sha1 ? crypto.createHash('sha1') : null;
    let bytes = 0;
    await pipeline(response.data, async function* (source) {
        for await (const chunk of source) {
            bytes += chunk.length;
            if (hash) hash.update(chunk);
            yield chunk;
        }
    }, fs.createWriteStream(dest, { flags: 'wx' }));

    const headers = response.headers || {};
    const declared = parseInt(headers['content-length'], 10);
    const size = Number.isInteger(expected.size) ? expected.size
        : Number.isFinite(declared) && !headers['content-encoding'] ? declared : null;
    if (size !== null && bytes !== size) {
        throw new Error(`${name} is ${bytes} bytes, expected ${size}`);
    }
    if (hash && hash.digest('hex') !== expected.sha1) {
        throw new Error(`${name} does not match its sha1 from CurseForge`);
    }
}

/** Fetches every kept jar into dir. The first failure stops the rest and throws. */
async function fetchJars(http, jars, dir, log) {
    const queue = [...jars];
    let failed = false;
    let done = 0;
    const worker = async () => {
        while (!failed && queue.length > 0) {
            const jar = queue.shift();
            try {
                await fetchTo(http, jar.url, path.join(dir, jar.fileName), { size: jar.size, sha1: jar.sha1 });
            } catch (error) {
                failed = true;
                throw new Error(`could not fetch ${jar.fileName} (${jar.name}, file ${jar.fileId}): ${error.message}`);
            }
            done += 1;
            log(`fetched ${done}/${jars.length} ${jar.fileName}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, worker));
}

/** Writes the entries ([name, source path], already sorted) to a zip with fixed times and modes. */
function writeZip(entries, outPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath, { flags: 'wx' });
        // One stat worker: with more, entries land in the order their stats return.
        const archive = archiver('zip', { zlib: { level: 6 }, statConcurrency: 1 });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.on('warning', reject);
        archive.pipe(output);
        for (const [name, source] of entries) {
            archive.file(source, { name, date: ENTRY_DATE, mode: 0o644, store: STORE_ONLY.test(name) });
        }
        archive.finalize();
    });
}

/** Reads and checks the client pack's manifest.json. */
function readManifest(clientDir) {
    const file = path.join(clientDir, 'manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`the client pack has no readable manifest.json (${error.message})`);
    }
    if (!manifest || !Array.isArray(manifest.files)) throw new Error('the client pack manifest.json has no files list');
    const overrides = manifest.overrides === undefined ? 'overrides' : manifest.overrides;
    if (!isPlainName(overrides)) throw new Error(`the client pack manifest.json names an unsafe overrides folder ${JSON.stringify(overrides)}`);
    return { manifest, overrides };
}

/**
 * Builds a server pack zip from a CurseForge client pack.
 * @param {number} modPackId CurseForge modpack id.
 * @param {number} fileId Client pack file id.
 * @param {string} outZip Where the zip goes. Its folder is created. Scratch goes next to it.
 * @param {object} [opts] {exclude: [modId or file name regex, ...]}.
 * @param {object} [deps] {curseforge (getFileLink, getFiles, getMods), http (axios-like get), log}.
 * @returns {Promise<object>} {zip, kept, skipped, overrides: {kept, skipped}, unusedExclude, minecraft}.
 * @throws On any failure. outZip is then not written, and an old file there is left as it was.
 */
async function build(modPackId, fileId, outZip, opts = {}, deps = {}) {
    const cf = deps.curseforge || require('./curseforge');
    const http = deps.http || axios;
    const log = deps.log || (() => {});
    const exclude = parseExclude(opts.exclude);

    const work = `${outZip}.build`;
    const partial = `${outZip}.part`;
    const clientZip = path.join(work, 'client.zip');
    const clientDir = path.join(work, 'client');
    const jarDir = path.join(work, 'mods');
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(partial, { force: true });
    fs.mkdirSync(jarDir, { recursive: true });

    try {
        const url = await cf.getFileLink(modPackId, fileId);
        if (!url) throw new Error(`CurseForge gave no download link for client pack ${modPackId}/${fileId}`);
        log(`fetching client pack ${modPackId}/${fileId}`);
        await fetchTo(http, url, clientZip);
        await decompress(clientZip, clientDir);

        const { manifest, overrides: overridesName } = readManifest(clientDir);
        const fileIds = manifest.files.map(entry => entry && entry.fileID);
        const modIds = [...new Set(manifest.files.map(entry => entry && entry.projectID))];
        const files = fileIds.length > 0 ? await cf.getFiles(fileIds) : [];
        const mods = modIds.length > 0 ? await cf.getMods(modIds) : [];
        const planned = planFiles(manifest.files, files, mods, exclude);

        const overridesDir = path.join(clientDir, overridesName);
        const overrides = planOverrides(overridesDir, exclude, planned.used);

        const entries = new Map(overrides.keep.map(rel => [rel, path.join(overridesDir, ...rel.split('/'))]));
        if (entries.has('manifest.json')) throw new Error('the overrides hold a manifest.json of their own');
        entries.set('manifest.json', path.join(clientDir, 'manifest.json'));
        for (const jar of planned.keep) {
            const rel = `mods/${jar.fileName}`;
            if (entries.has(rel)) throw new Error(`${rel} is both a manifest file and an override`);
            entries.set(rel, path.join(jarDir, jar.fileName));
        }

        log(`fetching ${planned.keep.length} mod file(s), ${planned.skipped.length} skipped`);
        await fetchJars(http, planned.keep, jarDir, log);

        fs.mkdirSync(path.dirname(path.resolve(outZip)), { recursive: true });
        await writeZip([...entries].sort((a, b) => byName(a[0], b[0])), partial);
        fs.renameSync(partial, outZip);

        return {
            zip: outZip,
            kept: planned.keep,
            skipped: planned.skipped,
            overrides,
            unusedExclude: unusedExclude(exclude, planned.used),
            minecraft: manifest.minecraft || null
        };
    } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

module.exports = {
    MOD_CLASS_ID,
    ENTRY_DATE,
    parseExclude,
    parseSource,
    isClientOnly,
    isClientOnlyPath,
    cdnUrl,
    planFiles,
    planOverrides,
    build
};
