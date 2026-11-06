/*
 * File: patchedJars.js
 * Project: valhalla-updater
 * -----
 * Guard for jars we replaced with patched builds under the stock file name.
 *
 * The merge only sees file names, so when the pack bumps such a mod its new stock jar
 * silently replaces our patch. A live jar counts as patched when the old pack ships the
 * same name with a different size. Custom jars the old pack never had are not affected:
 * the merge leaves them alone. Sizes come from the panel listing, so no jar is downloaded.
 */

const fs = require('fs');
const path = require('path');
const sessionLogger = require('./sessionLogger');

const packRelative = (p) => String(p).replace(/^\.?\/+/, '');

/** @returns {Map} jar name -> size for the mods/ folder of an unpacked pack. */
function sizesFromDir(modsDir) {
    const sizes = new Map();
    if (!fs.existsSync(modsDir)) return sizes;
    for (const entry of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jar')) sizes.set(entry.name, fs.statSync(path.join(modsDir, entry.name)).size);
    }
    return sizes;
}

/** @returns {Map} jar name -> size for the mods/ entries of an FTB manifest file list. */
function sizesFromManifest(files) {
    const sizes = new Map();
    for (const file of files || []) {
        if (packRelative(file.path).replace(/\/+$/, '') === 'mods' && String(file.name).endsWith('.jar') && Number.isFinite(file.size)) {
            sizes.set(file.name, file.size);
        }
    }
    return sizes;
}

/**
 * @param {Array} liveEntries Panel listing of mods/ ({name, size}).
 * @param {Map} oldSizes From sizesFromDir or sizesFromManifest.
 * @returns {Array} {name, liveSize, packSize} for every live jar that differs from the old pack's.
 */
function findPatched(liveEntries, oldSizes) {
    return liveEntries
        .filter(entry => entry.is_file !== false && String(entry.name).endsWith('.jar') && oldSizes.has(entry.name) && oldSizes.get(entry.name) !== entry.size)
        .map(entry => ({ name: entry.name, liveSize: entry.size, packSize: oldSizes.get(entry.name) }));
}

/**
 * Splits patched jars into the ones the update keeps and the ones it would replace.
 * The pack removing a file and the pack changing it both put the old name in deletions.
 * @param {Array} patched From findPatched.
 * @param {Array} deletions Pack deletions in any of the path forms ("/mods/a.jar", "./mods/a.jar").
 * @returns {{hit: Array, kept: Array}} Jar names.
 */
function decide(patched, deletions) {
    const deleted = new Set(deletions.map(packRelative));
    const hit = [];
    const kept = [];
    for (const jar of patched) (deleted.has(`mods/${jar.name}`) ? hit : kept).push(jar.name);
    return { hit, kept };
}

/**
 * Lists live mods/ on one instance. pterodactyl.listFiles answers [] on any error, and a
 * modded server never has an empty mods/, so an empty answer is retried and then refused.
 * @returns {Promise<Array|null>} The entries, or null when the panel gave none.
 */
async function listLiveMods(client, serverId, attempts = 3, pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await pause(2000);
        const entries = await client.listFiles(serverId, '/mods');
        if (entries.length > 0) return entries;
    }
    return null;
}

/**
 * Runs the guard over every instance of a pack, before the stop.
 * @param {Object} input {client, serverIds, oldSizes, deletions, force, pause}.
 * @returns {Promise<{abort: string|null, note: string, hit: Object}>} hit maps jar name -> instance ids.
 */
async function checkInstances({ client, serverIds, oldSizes, deletions, force = false, pause }) {
    const hit = {};
    const kept = new Set();
    const unlisted = [];
    for (const sid of serverIds) {
        const entries = await listLiveMods(client, sid, 3, pause);
        if (entries === null) {
            unlisted.push(sid);
            continue;
        }
        const decision = decide(findPatched(entries, oldSizes), deletions);
        for (const name of decision.kept) kept.add(name);
        for (const name of decision.hit) (hit[name] = hit[name] || []).push(sid);
    }
    for (const name of kept) if (hit[name]) kept.delete(name);

    const hitNames = Object.keys(hit).sort();
    const where = (name) => serverIds.length > 1 ? ` (${hit[name].join(', ')})` : '';
    sessionLogger.info('PatchedJars', `Patched jars kept: ${[...kept].join(', ') || 'none'}; replaced by the pack: ${hitNames.join(', ') || 'none'}; unlisted: ${unlisted.join(', ') || 'none'}`);

    const parts = [];
    if (unlisted.length > 0) parts.push(`the panel listed no mods/ on ${unlisted.join(', ')}, so patched jars there cannot be checked`);
    if (hitNames.length > 0) parts.push(`the pack would replace our patched ${hitNames.map(name => `\`${name}\`${where(name)}`).join(', ')} with its stock jars`);

    if (parts.length > 0 && !force) {
        return { abort: `${parts.join('; ')}. Rebuild the patch for the new version, or re-run with \`force:true\` to let the pack replace them`, note: '', hit };
    }
    let note = `\n- Patched jars kept: ${kept.size}${kept.size > 0 ? ` (${[...kept].sort().join(', ')})` : ''}.`;
    if (parts.length > 0) note += ` **force: ${parts.join('; ')}.**`;
    return { abort: null, note, hit };
}

module.exports = {
    sizesFromDir,
    sizesFromManifest,
    findPatched,
    decide,
    listLiveMods,
    checkInstances
};
