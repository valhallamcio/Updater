/*
 * File: updateManager.js
 * Project: valhalla-updater
 * File Created: Saturday, 11th May 2024 3:52:12 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 25th July 2024 5:56:15 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const fs = require('fs');
const path = require('path');
const {
    decompress,
    compressDirectory
} = require('../modules/compressor');
const comparator = require('../modules/comparator');
const merger = require('../modules/merger');
const {
    sleep,
    checkMods,
    getVersion,
    rmRecursive
} = require('../modules/functions');
const curseforge = require('../modules/curseforge');
const {
    download,
    upload
} = require('../modules/downloader');
const pterodactyl = require('../modules/pterodactyl');
const unpacker = require('../modules/unpacker');
const {
    unpack
} = unpacker;
const modpacksch = require('../modules/modpacksch');
const {
    alertScheduledUpdate,
    updateMessage
} = require('../config/messages.json');
const yggdrasil = require('../modules/yggdrasil');
const {
    sendWebhook
} = require('../discord/webhook');
const manifest = require('../modules/manifest');
const perInstanceFiles = require('../modules/perInstanceFiles');
const sessionLogger = require('../modules/sessionLogger');
const {
    active,
    announcementChannelId
} = require("../config/config.json").discord;


/*  REFERENCE  */
let newpack = {
    //_id: new ObjectId('6638d513fb984056c222f480'),
    hostname: '',
    port: 10004,
    tag: 'ske',
    desc: '',
    discord_role_id: '',
    name: 'FTB Skies Expert',
    server_version: '1.19.2',
    modpack_version: '1.8.1',
    genre: '',
    early_access: false,
    color: 'blue',
    serverId: 'asdadas',
    image: '',
    rtp_max_range: '10000',
    rtp_min_range: '250',
    modpackID: 117,
    fileID: 11927,
    rtp_cooldown: '600',
    newestFileID: 11927,
    platform: 'feedthebeast',
    requiresUpdate: false
};
/*  REFERENCE  */


/* ---------- multi-instance helpers ----------
 *
 * Packs can be served by several Pterodactyl instances sharing one mongo tag (il2, pri,
 * mg2, gto). Those instances legitimately differ - ports, backup destination, metrics
 * port, admin-added scripts - so each one is backed up, merged and deployed from its OWN
 * files. Nothing is enumerated: an instance's files simply never enter another instance's
 * merge. See modules/perInstanceFiles for the narrow force-protect layer on top.
 */

/**
 * Where an instance's own backup archive lives. Kept per serverId so /restore can put
 * each instance back to its own state instead of the first instance's.
 */
function instanceVaultPath(tag, serverId, vaultFileName) {
    return `./vault/${tag}/instances/${serverId}/${vaultFileName}`;
}

// Discord rejects a message edit over this; the progress log grows with every instance.
const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Edits the progress message without ever being able to abort the update.
 *
 * Two failure modes, both of which used to land between the last deploy and the database
 * write - i.e. every instance updated, mongo still on the old version:
 * long logs (several instances plus a cross-instance diff pass 2000 characters), and
 * Discord simply being down. The head is dropped rather than the tail because the tail
 * carries the current step and any FAILED markers.
 */
async function editProgress(message, content) {
    let text = content;
    if (text.length > DISCORD_MESSAGE_LIMIT) {
        const notice = "*[earlier progress trimmed]*\n";
        text = notice + text.slice(text.length - (DISCORD_MESSAGE_LIMIT - notice.length));
    }
    try {
        await message.edit(text);
    } catch (error) {
        sessionLogger.warn('UpdateManager', `Could not update the progress message: ${error.message}`);
    }
}

/**
 * Looks for one file on the panel, retrying before believing it is absent.
 *
 * pterodactyl.listFiles returns [] on any API error, which is indistinguishable from an
 * empty directory, and every caller here treats "missing" as a reason to abort a deploy -
 * so a single panel hiccup would fail an instance that is actually fine.
 * @returns {Object|null} The file entry, or null if it never showed up.
 */
async function findRemoteFile(client, serverId, fileName, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await sleep(2000);
        // is_file may be absent on older panels - only an explicit false rules an entry out
        const entry = (await client.listFiles(serverId)).find(e => e.name === fileName && e.is_file !== false);
        if (entry) return entry;
    }
    return null;
}

/**
 * Waits for the panel to actually unpack the deployed archive.
 *
 * pterodactyl.decompressFile logs and swallows its errors, so a panel 500 is
 * indistinguishable from success at the call site - and by then the server directory has
 * already been deleted. Without this the run would go on to delete the uploaded zip, report
 * the instance as deployed, start it and advance the database, leaving an empty server.
 * @param {Array} expected Top-level names the archive must produce.
 * @returns {Array} Names still missing after the last attempt - empty means unpacked.
 */
async function awaitDecompressed(client, serverId, expected, attempts = 5) {
    let missing = expected;
    for (let attempt = 0; attempt < attempts && missing.length > 0; attempt++) {
        // Checked before sleeping: the panel unpacks synchronously, the retries are for
        // the case where it does not rather than a delay every deploy has to pay
        if (attempt > 0) await sleep(2000);
        const listed = new Set((await client.listFiles(serverId)).map(entry => entry.name));
        missing = expected.filter(name => !listed.has(name));
    }
    return missing;
}

/** How long the boot watch waits before calling an instance stuck. Big 1.7.10 packs can take 10+ minutes from container start to "running". */
const BOOT_WATCH_TIMEOUT_MS = 20 * 60 * 1000;
/** Panel state poll cadence during the boot watch. */
const BOOT_WATCH_POLL_MS = 15 * 1000;
/** Online->offline flaps (wings crash-recovery cycles) before the instance is declared crash-looping. E2E 2026-08-14 cycled four times in four minutes. */
const BOOT_WATCH_MAX_FLAPS = 2;

/**
 * Watches one started instance until the panel reports it running, crash-looping, or the
 * deadline passes. A server whose JVM dies during mod loading flaps starting->offline as
 * wings crash-recovery retries it; flap-counting fails that fast, so a broken deploy is
 * reported in minutes instead of the full timeout.
 * @param {Object} deps Injectable for tests - getStatus returns {attributes:{current_state}}.
 * @returns {string|null} The failure reason, or null when the instance came up.
 */
async function verifyBooted(serverId, deps = {}, deadline = BOOT_WATCH_TIMEOUT_MS) {
    const getStatus = deps.getStatus || ((sid) => pterodactyl.getStatus(sid));
    const sleepFn = deps.sleep || sleep;
    const now = deps.now || Date.now;
    const startedAt = now();
    let flaps = 0;
    let lastState = null;
    while (now() - startedAt < deadline) {
        let state = 'unknown';
        try {
            state = (await getStatus(serverId)).attributes.current_state || 'unknown';
        } catch (error) {
            sessionLogger.warn('UpdateManager', `Boot watch could not read ${serverId}: ${error.message}`);
        }
        if (state === 'running') return null;
        if (state === 'offline' && lastState && lastState !== 'offline') {
            flaps++;
            if (flaps >= BOOT_WATCH_MAX_FLAPS) {
                sessionLogger.error('UpdateManager', `${serverId} crash-loops after the deploy (${flaps} offline flaps)`);
                return 'crash-looping';
            }
        }
        lastState = state;
        await sleepFn(BOOT_WATCH_POLL_MS);
    }
    sessionLogger.error('UpdateManager', `${serverId} never reported "running" within ${Math.round(deadline / 60000)}m of the deploy (state: ${lastState || 'unknown'})`);
    return 'stuck';
}

/**
 * Starts the instances that are safe to boot, without being able to abort the run.
 *
 * sendPowerAction rethrows once its retries are exhausted, and every caller sits between
 * the last deploy and the tag-wide database write - so a panel hiccup starting the second
 * of three instances used to leave every instance updated on disk and mongo still claiming
 * the old version. Sending "start" also proves nothing about the boot itself: E2E 2026-08-14
 * crash-looped on a wings unpack-permission bug for 30+ minutes while the run reported
 * success, because the signal had gone through. Ids that never reach "running" (or flap)
 * go into the report exactly like ids the panel refused, so the files-updated warning stays
 * accurate. An instance that will not start is a thing to report, not to roll back.
 * @returns {Array} Ids that did not come up (send failed, crash-looped, or timed out).
 */
async function startInstances(allServerIds, skip = []) {
    const notStarted = [];
    const started = [];
    for (const sid of allServerIds) {
        if (skip.includes(sid)) continue;
        try {
            await pterodactyl.sendPowerAction(sid, "start");
            started.push(sid);
        } catch (error) {
            sessionLogger.error('UpdateManager', `Could not start ${sid}:`, error.message);
            notStarted.push(sid);
        }
    }
    // All running instances share the same clock - watching them in parallel means one slow
    // boot does not push a fast neighbour's crash detection past the wing's retry cadence.
    const failures = await Promise.all(started.map(sid => verifyBooted(sid)));
    started.forEach((sid, i) => {
        if (failures[i]) notStarted.push(sid);
    });
    return notStarted;
}

/**
 * The cross-instance drift report is informational, and it runs in the same gap as the
 * starts above - hashing or comparing must not be able to cost the database write.
 */
async function safeInstanceDiff(instanceManifests, allServerIds) {
    try {
        return perInstanceFiles.formatInstanceDiff(
            await perInstanceFiles.diffInstanceManifests(instanceManifests, allServerIds));
    } catch (error) {
        sessionLogger.warn('UpdateManager', `Could not build the cross-instance diff: ${error.message}`);
        return "";
    }
}

/** Appends a warning for instances whose files are updated but which did not come back up. */
function notStartedWarning(notStarted) {
    if (notStarted.length === 0) return "";
    return `\n\n**WARNING: ${notStarted.join(', ')} did not start. Their files ARE updated - start them from the panel, do not re-run the update.**`;
}

/**
 * Deletes scratch data without letting the deletion decide whether a deploy counts.
 *
 * rmRecursive uses force:true, which only silences ENOENT - an EACCES or EBUSY still
 * throws. Every call site here runs AFTER the panel already has the new files, so a throw
 * would mark a deployed instance failed (and, from inside a catch block, escape it).
 */
function safeRm(target) {
    try {
        rmRecursive(target);
    } catch (error) {
        sessionLogger.warn('UpdateManager', `Could not clean up ${target}: ${error.message}`);
    }
}

/**
 * Marks an error as having been thrown after the instance's live files were deleted.
 *
 * The distinction decides what the operator should do next: a failure before the wipe
 * leaves the instance untouched and the update can simply be run again, while a failure
 * after it leaves the instance empty - re-running would then back up and merge from that
 * empty tree and deploy the result.
 */
function wipedError(message) {
    const error = new Error(message);
    error.serverWiped = true;
    return error;
}

/** Appends a warning for instances left with no files on the panel. */
function wipedWarning(wiped, tag) {
    if (wiped.length === 0) return "";
    return `\n\n**DANGER: ${wiped.join(', ')} were left with NO server files - the merged archive is still on the panel, unpack it there, or use \`/restore\` with the backup in \`./vault/${tag}/instances/\`. Do NOT re-run the update: it would back up and merge from the empty tree.**`;
}

/**
 * Rough scratch-space guard, called once the new pack is on disk so its size is the unit:
 * two extracted reference packs, one unpacked instance tree at a time plus its zip, and
 * one vault archive per instance.
 * @returns {string|null} Error message if space is short, null if fine or undeterminable.
 */
function checkDiskSpace(packZipPath, instanceCount) {
    try {
        const unit = fs.statSync(packZipPath).size;
        const required = unit * (6 + 1.5 * instanceCount);
        const stats = fs.statfsSync('.');
        const free = stats.bavail * stats.bsize;
        const gb = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
        sessionLogger.info('UpdateManager', `Disk check: ${gb(free)} free, ~${gb(required)} needed for ${instanceCount} instance(s)`);
        if (free < required) {
            return `Not enough disk space: ${gb(free)} free but roughly ${gb(required)} is needed for ${instanceCount} instance(s).`;
        }
    } catch (error) {
        sessionLogger.warn('UpdateManager', `Could not check disk space: ${error.message}`);
    }
    return null;
}

/**
 * PHASE A - backs up every instance and snapshots its protected files. Runs before
 * anything destructive, so a failure here means the caller can restart the instances
 * with their files untouched.
 *
 * An existing vault archive is never overwritten: on a re-run after a partial failure
 * that archive is the only rollback point, so this run's copy goes to scratch instead.
 *
 * @returns {Object} Map of serverId -> local archive path to merge from.
 * @throws If any instance could not be archived or downloaded.
 */
async function backupAllInstances(pack, allServerIds, toCompressList, vaultFileName, protectedFiles) {
    const archives = {};

    for (const sid of allServerIds) {
        const remoteArchive = await pterodactyl.compressFile(sid, toCompressList);
        if (!remoteArchive) throw new Error(`could not compress server files on ${sid}`);

        const downloadLink = await pterodactyl.getDownloadLink(sid, remoteArchive);
        if (!downloadLink) throw new Error(`could not get a download link on ${sid}`);

        const vaultPath = instanceVaultPath(pack.tag, sid, vaultFileName);
        let target = vaultPath;
        if (fs.existsSync(vaultPath)) {
            target = `./${pack.tag}/current_${sid}.tar.gz`;
            sessionLogger.warn('UpdateManager', `Backup ${vaultPath} already exists - preserving it and using scratch copy ${target}`);
        }

        await download(downloadLink, target);
        if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
            throw new Error(`backup archive for ${sid} is missing or empty`);
        }
        archives[sid] = target;

        await sleep(1000);
        await pterodactyl.deleteFile(sid, [remoteArchive]);

        // Plain copies of the identity files so /restore can reapply them on their own
        for (const file of protectedFiles) {
            let content;
            try {
                content = await pterodactyl.getFileContents(sid, file);
            } catch (error) {
                // Packs that never shipped a protected file must not fail the backup.
                // The panel answers a missing path with a 500, so getFileContents
                // exhausts its retries and throws instead of returning null.
                sessionLogger.warn('UpdateManager', `Could not snapshot ${file} on ${sid} (${error.message}) - skipping it`);
                continue;
            }
            if (content === null) continue;
            const dest = `./vault/${pack.tag}/per-server/${sid}/${file}`;
            fs.mkdirSync(path.dirname(dest), {
                recursive: true
            });
            fs.writeFileSync(dest, content);
        }

        sessionLogger.info('UpdateManager', `Backed up ${sid} to ${target}`);
    }

    return archives;
}

/**
 * PHASE B tail - zips a merged instance tree and swaps it in for the instance's live files.
 *
 * Both panel steps are verified, because neither reports failure on its own: modules/
 * downloader's upload() and pterodactyl.decompressFile both log and swallow their errors.
 * Unverified, a silent upload failure wipes the server and unpacks a file that was never
 * there, and a silent decompress failure leaves the server empty while the run goes on to
 * start it and advance the database.
 * @param {Object} client Panel client, injectable so the abort paths can be tested.
 * @param {number} unpackAttempts How many times to re-list before calling the unpack failed.
 * @throws If the upload or the unpack cannot be confirmed on the panel.
 */
async function deployMergedTree(pack, serverId, mergedDir, zipName, deleteList, client = pterodactyl, unpackAttempts = 5) {
    const zipPath = `${pack.tag}/${zipName}`;
    await compressDirectory(mergedDir, zipPath);
    const localSize = fs.statSync(zipPath).size;
    const expected = fs.readdirSync(mergedDir);

    const uploadUrl = await client.getUploadLink(serverId);
    if (!uploadUrl) throw new Error(`could not get an upload link for ${serverId}`);
    await upload(zipPath, uploadUrl);

    const remote = await findRemoteFile(client, serverId, zipName);
    if (!remote) throw new Error(`upload of ${zipName} to ${serverId} could not be confirmed - server files left untouched`);
    if (remote.size !== localSize) {
        throw new Error(`upload of ${zipName} to ${serverId} is incomplete (${remote.size} of ${localSize} bytes) - server files left untouched`);
    }

    // DANGER ZONE - LINES BELOW MODIFY THE SERVER FILES ON LIVE BRANCH
    if (!await client.deleteFile(serverId, deleteList)) {
        throw new Error(`could not delete the old files on ${serverId} - nothing was unpacked over them, so the instance is still on its old version`);
    }
    await sleep(1000);

    if (!await client.decompressFile(serverId, zipName)) {
        throw wipedError(`the panel refused to unpack ${zipName} on ${serverId} - the server files are deleted and the archive is still there`);
    }

    // The delete above is confirmed, so these names are gone unless this unpack put them
    // back. Checked before the archive is dropped: until then the zip is the only copy of
    // the new files. Not proof of a COMPLETE extraction - a panel that reports success
    // after filling its disk mid-write still passes - but it catches a no-op unpack.
    const missing = await awaitDecompressed(client, serverId, expected, unpackAttempts);
    if (missing.length > 0) {
        throw wipedError(`decompress of ${zipName} on ${serverId} did not produce ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""} - the uploaded archive was left on the server`);
    }

    await client.deleteFile(serverId, [zipName]);
    // DANGER ZONE - LINES ABOVE MODIFY THE SERVER FILES ON LIVE BRANCH

    // Past the panel work - a local cleanup problem must not fail a deployed instance
    safeRm(`./${zipPath}`);
}

/**
 * PHASE B - unpacks one instance, applies the pack merge to its own files, puts its
 * identity files back on top and deploys the result. One instance is on disk at a time.
 * @param {function} applyMerge Platform-specific merge, called with the unpacked tree path.
 * @param {function} inspect Optional pre-merge report, called with the unpacked tree path.
 * @returns {Object} {manifest, note} - note is whatever inspect returned.
 */
async function mergeAndDeployInstance(pack, serverId, options) {
    const {
        archivePath,
        mainDir,
        applyMerge,
        protectedFiles,
        zipName,
        deleteList,
        inspect
    } = options;

    rmRecursive(mainDir);
    await unpack(archivePath, mainDir);

    // Hashed while the tree is here anyway - powers the cross-instance report for free
    const instanceManifest = manifest.generate(mainDir);
    const note = inspect ? await inspect(mainDir) : "";

    const stash = perInstanceFiles.stashProtected(mainDir, protectedFiles);
    await applyMerge(mainDir);
    const restored = perInstanceFiles.applyProtectedOverlay(mainDir, stash);
    if (restored.length > 0) {
        sessionLogger.info('UpdateManager', `Re-applied ${restored.join(', ')} for ${serverId}`);
    }

    await deployMergedTree(pack, serverId, mainDir, zipName, deleteList);
    safeRm(mainDir);

    return {
        manifest: instanceManifest,
        note
    };
}

module.exports = {

    // Exposed for test/multiInstance.test.js - these decide whether live server files
    // get deleted, so their abort paths are worth pinning down.
    _internals: {
        backupAllInstances,
        deployMergedTree,
        instanceVaultPath,
        checkDiskSpace,
        editProgress,
        findRemoteFile,
        awaitDecompressed,
        verifyBooted,
        startInstances,
        BOOT_WATCH_TIMEOUT_MS,
        BOOT_WATCH_POLL_MS,
        BOOT_WATCH_MAX_FLAPS,
        DISCORD_MESSAGE_LIMIT
    },

    /**
     * Updates the server with the latest version of the modpack. (CurseForge)
     * @param {object} pack Object with the server data.
     * @param {object} interaction Object with the interaction data.(for Discord)
     */

    updateCF: async function (pack, versionOverride, interaction, serverIds = null) {
        // Sorted so the order is deterministic rather than however the API listed them
        const allServerIds = (serverIds && serverIds.length > 0 ? [...serverIds] : [pack.serverId]).sort();
        const protectedFiles = perInstanceFiles.forTag(pack.tag);

        const packManifest = await modpacksch.getCFPackManifest(pack.modpackID, pack.newestFileID);

        let newVersionNumber = getVersion(packManifest.name);
        if (versionOverride) newVersionNumber = versionOverride;

        const alert = alertScheduledUpdate.replace("[NEWVERSION]", newVersionNumber);

        let progressLog = `Update sequence started for **${pack.name}** (${pack.modpackVersion} -> ${newVersionNumber}).`;
        await editProgress(interaction, progressLog);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        let newestServerPackID = await curseforge.getServerFileId(pack.modpackID, pack.newestFileID);
        let currentServerPackID = await curseforge.getServerFileId(pack.modpackID, pack.fileID);

        // Fallback mechanism using additional files endpoint
        if (newestServerPackID === null) {
            progressLog += `\n- Could not find primary server pack ID for new version (${pack.newestFileID}). Checking additional files...`;
            await editProgress(interaction, progressLog);
            newestServerPackID = await curseforge.getAdditionalServerFileId(pack.modpackID, pack.newestFileID);
            if (newestServerPackID !== null) {
                 progressLog += ` Found fallback ID: ${newestServerPackID}.`;
                 await editProgress(interaction, progressLog);
            } else {
                 progressLog += ` No fallback found.`;
                 await editProgress(interaction, progressLog);
            }
        }
        if (currentServerPackID === null) {
            progressLog += `\n- Could not find primary server pack ID for current version (${pack.fileID}). Checking additional files...`;
            await editProgress(interaction, progressLog);
            currentServerPackID = await curseforge.getAdditionalServerFileId(pack.modpackID, pack.fileID);
             if (currentServerPackID !== null) {
                 progressLog += ` Found fallback ID: ${currentServerPackID}.`;
                 await editProgress(interaction, progressLog);
            } else {
                 progressLog += ` No fallback found.`;
                 await editProgress(interaction, progressLog);
            }
        }

        // Re-check IDs after fallback attempt
        if (newestServerPackID === null && currentServerPackID === null) {
            progressLog += `\n- Could not find server pack IDs for **both** the current version (${pack.fileID}) and the new version (${pack.newestFileID}) even after checking additional files. Aborting update.`;
            await editProgress(interaction, progressLog);
            return;
        } else if (newestServerPackID === null) {
            progressLog += `\n- Could not find server pack ID for the new version (${pack.newestFileID}) even after checking additional files. Aborting update.`;
            await editProgress(interaction, progressLog);
            return;
        } else if (currentServerPackID === null) {
            progressLog += `\n- Could not find server pack ID for the current version (${pack.fileID}) even after checking additional files. Aborting update.`;
            await editProgress(interaction, progressLog);
            return;
        }

        const newestServerpackURL = await curseforge.getFileLink(pack.modpackID, newestServerPackID);
        const currentServerPackURL = await curseforge.getFileLink(pack.modpackID, currentServerPackID);

        safeRm(`./${pack.tag}`);

        progressLog += `\n- Downloading new server pack...`;
        await editProgress(interaction, progressLog);
        await download(newestServerpackURL, `./${pack.tag}/downloads/new/${pack.tag}_${newestServerPackID}.zip`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Downloading reference server pack...`;
        await editProgress(interaction, progressLog);
        await download(currentServerPackURL, `./${pack.tag}/downloads/old/${pack.tag}_${currentServerPackID}.zip`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Decompressing new pack files...`;
        await editProgress(interaction, progressLog);
        await decompress(`./${pack.tag}/downloads/new/${pack.tag}_${newestServerPackID}.zip`, `./${pack.tag}/compare/new`);
        await checkMods(`./${pack.tag}/compare/new`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Decompressing reference pack files...`;
        await editProgress(interaction, progressLog);
        await decompress(`./${pack.tag}/downloads/old/${pack.tag}_${currentServerPackID}.zip`, `./${pack.tag}/compare/old`);
        await checkMods(`./${pack.tag}/compare/old`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        const diskError = checkDiskSpace(`./${pack.tag}/downloads/new/${pack.tag}_${newestServerPackID}.zip`, allServerIds.length);
        if (diskError) {
            progressLog += `\n\n**Aborting: ${diskError} Nothing was touched.**`;
            await editProgress(interaction, progressLog);
            return;
        }

        let toCompressList = [];

        await fs.readdirSync(`./${pack.tag}/compare/old`).forEach(file => {
            toCompressList.push(file);
        });

        progressLog += ` Done!\n- Shutting down ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        for (const sid of allServerIds) await pterodactyl.shutdown(sid);

        // PHASE A - back up every instance before anything destructive happens
        const vaultFileName = `${pack.tag}_${pack.modpackVersion}_${pack.fileID}.tar.gz`;
        progressLog += ` Done!\n- Backing up ${allServerIds.length > 1 ? `all ${allServerIds.length} instances` : 'the server'}...`;
        await editProgress(interaction, progressLog);

        let archives;
        try {
            archives = await backupAllInstances(pack, allServerIds, toCompressList, vaultFileName, protectedFiles);
        } catch (error) {
            sessionLogger.error('UpdateManager', 'Backup phase failed:', error.message);
            progressLog += `\n\n**Aborting: backup failed (${error.message}). Server files are untouched, starting everything back up.**`;
            await editProgress(interaction, progressLog);
            const notRestarted = await startInstances(allServerIds);
            if (notRestarted.length > 0) {
                progressLog += `\n**${notRestarted.join(', ')} did not come back up - start them from the panel.**`;
                await editProgress(interaction, progressLog);
            }
            return;
        }

        // What the pack itself changed - identical for every instance, so computed once
        progressLog += ` Done!\n- Comparing pack versions...`;
        await editProgress(interaction, progressLog);
        const changeList = await comparator.compare(`./${pack.tag}/compare/old`, `./${pack.tag}/compare/new`);
        progressLog += ` Done!\n- **Files to delete**: ${changeList.deletions.length}, **Files to add**: ${changeList.additions.length}`;
        await editProgress(interaction, progressLog);

        // PHASE B - each instance is merged from its OWN files and deployed on its own
        const instanceManifests = {};
        const failedInstances = [];
        const wipedInstances = [];
        const mainDir = `./${pack.tag}/compare/main`;

        for (const sid of allServerIds) {
            progressLog += `\n- Merging and deploying \`${sid}\`...`;
            await editProgress(interaction, progressLog);

            try {
                const result = await mergeAndDeployInstance(pack, sid, {
                    archivePath: archives[sid],
                    mainDir,
                    applyMerge: async () => merger.merge(`./${pack.tag}`, changeList),
                    protectedFiles,
                    zipName: `update_${pack.tag}_${sid}_${pack.newestFileID}.zip`,
                    deleteList: toCompressList,
                    inspect: async (dir) => {
                        const customChanges = await comparator.findCustomChanges(dir, `./${pack.tag}/compare/old`);
                        const overWrites = customChanges.editedFiles.filter(file => changeList.additions.includes(file));
                        return ` custom: ${customChanges.customFiles.length}, edited: ${customChanges.editedFiles.length}, overwritten: ${overWrites.length}.`;
                    }
                });
                instanceManifests[sid] = result.manifest;
                progressLog += `${result.note} Done!`;
            } catch (error) {
                sessionLogger.error('UpdateManager', `Deploy failed on ${sid}:`, error.message);
                progressLog += ` **FAILED: ${error.message}**`;
                failedInstances.push(sid);
                if (error.serverWiped) wipedInstances.push(sid);
                safeRm(mainDir);
            }
            await editProgress(interaction, progressLog);
        }

        // An instance whose deploy failed must not boot in a half-written state
        progressLog += `\n- Starting ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        const notStarted = await startInstances(allServerIds, failedInstances);

        progressLog += ` Done!${notStartedWarning(notStarted)}${await safeInstanceDiff(instanceManifests, allServerIds)}`;
        progressLog += `\n- Update sequence completed. Cleaning up...`;
        await editProgress(interaction, progressLog);
        safeRm(`./${pack.tag}`);

        if (failedInstances.length > 0) {
            const safeToRetry = failedInstances.filter(sid => !wipedInstances.includes(sid));
            progressLog += ` Done!\n\n**WARNING: ${failedInstances.join(', ')} failed to deploy and were NOT started. The database was left unchanged.${safeToRetry.length > 0 ? ` ${safeToRetry.join(', ')} still have their files, so the update can be run again. Backups are in \`./vault/${pack.tag}/instances/\`.` : ""}**${wipedWarning(wipedInstances, pack.tag)}`;
            await editProgress(interaction, progressLog);
            return;
        }

        progressLog += ` Done!\n- Updating data and sending update message...`;
        await editProgress(interaction, progressLog);
        await yggdrasil.updateServer(pack.tag, {
            modpack_version: newVersionNumber,
            fileID: pack.newestFileID,
            newestFileID: pack.newestFileID,
            requiresUpdate: false
        });

        //TODO ai summary ???
        const packData = await curseforge.getPackData(pack.modpackID);
        const updateMessageContent = updateMessage.replace("[PACKNAME]", pack.name)
            .replace("[NEWVERSION]", newVersionNumber)
            .replace("[OLDVERSION]", pack.modpackVersion)
            .replace("[CHANGELOGURL]", `https://www.curseforge.com/minecraft/modpacks/${packData.slug}/files/${pack.newestFileID}`)
            .replace("[PINGROLE]", `<@&${pack.discordRoleId}>`)
            .replace("[SUMMARY]", "");

        const updateWebhook = {
            content: updateMessageContent,
            username: pack.name,
            avatarURL: packData.logo.url,
        };

        await sendWebhook(announcementChannelId, updateWebhook);

    },

    /**
     * Updates the server with the latest version of the modpack. (Feed The Beast)
     * @param {object} pack Object with the server data.
     * @param {object} interaction Object with the interaction data.(for Discord)
     */
    updateFTB: async function (pack, versionOverride, interaction, serverIds = null) {
        // Sorted so the order is deterministic rather than however the API listed them
        const allServerIds = (serverIds && serverIds.length > 0 ? [...serverIds] : [pack.serverId]).sort();
        const protectedFiles = perInstanceFiles.forTag(pack.tag);
        const newManifest = await modpacksch.getFTBPackManifest(pack.modpackID, pack.newestFileID);

        let newVersionNumber = getVersion(newManifest.name);
        if (versionOverride) newVersionNumber = versionOverride;

        const alert = alertScheduledUpdate.replace("[NEWVERSION]", newVersionNumber);

        let progressLog = `Update sequence started for **${pack.name}** (${pack.modpackVersion} -> ${newVersionNumber}).`;
        await editProgress(interaction, progressLog);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += `\n- Getting pack manifests...`;
        await editProgress(interaction, progressLog);


        const oldManifest = await modpacksch.getFTBPackManifest(pack.modpackID, pack.fileID);

        // Diagnostic logging for manifest structures
        sessionLogger.info('UpdateManager', `Old manifest has ${oldManifest.files.length} files`);
        sessionLogger.info('UpdateManager', `Sample old manifest file: ${JSON.stringify(oldManifest.files[0])}`);
        sessionLogger.info('UpdateManager', `New manifest has ${newManifest.files.length} files`);
        sessionLogger.info('UpdateManager', `Sample new manifest file: ${JSON.stringify(newManifest.files[0])}`);

        safeRm(`./${pack.tag}`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        let toCompressList = [];
        for (let file of oldManifest.files) {
            if (file.path === "./") toCompressList.push(file.name);
            const match = file.path.match(/\/([^/]+)/);
            const topDir = match ? match[1] : null;
            if (!toCompressList.includes(topDir) && topDir != null) toCompressList.push(topDir);
        }

        // Diagnostic logging for toCompressList
        sessionLogger.info('UpdateManager', `Generated toCompressList with ${toCompressList.length} items`);
        sessionLogger.info('UpdateManager', `toCompressList contents: ${JSON.stringify(toCompressList)}`);

        await sleep(5000);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Shutting down ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        for (const sid of allServerIds) await pterodactyl.shutdown(sid);

        // PHASE A - back up every instance before anything destructive happens
        const vaultFileName = `${pack.tag}_${pack.modpackVersion}_${pack.fileID}.tar.gz`;
        progressLog += ` Done!\n- Backing up ${allServerIds.length > 1 ? `all ${allServerIds.length} instances` : 'the server'}...`;
        await editProgress(interaction, progressLog);

        let archives;
        try {
            archives = await backupAllInstances(pack, allServerIds, toCompressList, vaultFileName, protectedFiles);
        } catch (error) {
            sessionLogger.error('UpdateManager', 'Backup phase failed:', error.message);
            progressLog += `\n\n**Aborting: backup failed (${error.message}). Server files are untouched, starting everything back up.**`;
            await editProgress(interaction, progressLog);
            const notRestarted = await startInstances(allServerIds);
            if (notRestarted.length > 0) {
                progressLog += `\n**${notRestarted.join(', ')} did not come back up - start them from the panel.**`;
                await editProgress(interaction, progressLog);
            }
            return;
        }

        // What the pack itself changed - identical for every instance, so computed once
        progressLog += ` Done!\n- Comparing pack manifests...`;
        await editProgress(interaction, progressLog);

        const oldFilelist = oldManifest.files.filter(obj => !obj.clientonly);
        const newFilelist = newManifest.files.filter(obj => !obj.clientonly);
        const changeList = await comparator.findManifestChanges(oldFilelist, newFilelist);

        progressLog += ` Done!\n- **Files to delete**: ${changeList.deletions.length}, **Files to add**: ${changeList.additions.length}`;
        await editProgress(interaction, progressLog);

        // PHASE B - each instance is merged from its OWN files and deployed on its own.
        // Note mergeFromManifest re-fetches the added files from the FTB CDN per instance;
        // no multi-instance FTB pack exists today, so the repeat download is acceptable.
        const instanceManifests = {};
        const failedInstances = [];
        const wipedInstances = [];
        const mainDir = `./${pack.tag}/compare/main`;

        for (const sid of allServerIds) {
            progressLog += `\n- Merging and deploying \`${sid}\`...`;
            await editProgress(interaction, progressLog);

            try {
                const result = await mergeAndDeployInstance(pack, sid, {
                    archivePath: archives[sid],
                    mainDir,
                    applyMerge: async (dir) => merger.mergeFromManifest(dir, changeList, newManifest),
                    protectedFiles,
                    zipName: `update_${pack.tag}_${sid}_${pack.newestFileID}.zip`,
                    deleteList: toCompressList,
                    inspect: async (dir) => {
                        const currentManifest = manifest.generate(dir);
                        const customChanges = await comparator.findCustomManifestChanges(currentManifest, oldFilelist);
                        const overWrites = customChanges.editedFiles.filter(file => changeList.additions.includes(file));
                        return ` custom: ${customChanges.customFiles.length}, edited: ${customChanges.editedFiles.length}, overwritten: ${overWrites.length}.`;
                    }
                });
                instanceManifests[sid] = result.manifest;
                progressLog += `${result.note} Done!`;
            } catch (error) {
                sessionLogger.error('UpdateManager', `Deploy failed on ${sid}:`, error.message);
                progressLog += ` **FAILED: ${error.message}**`;
                failedInstances.push(sid);
                if (error.serverWiped) wipedInstances.push(sid);
                safeRm(mainDir);
            }
            await editProgress(interaction, progressLog);
        }

        // An instance whose deploy failed must not boot in a half-written state
        progressLog += `\n- Starting ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        const notStarted = await startInstances(allServerIds, failedInstances);

        progressLog += ` Done!${notStartedWarning(notStarted)}${await safeInstanceDiff(instanceManifests, allServerIds)}`;
        progressLog += `\n- Update sequence completed. Cleaning up...`;
        await editProgress(interaction, progressLog);
        safeRm(`./${pack.tag}`);

        if (failedInstances.length > 0) {
            const safeToRetry = failedInstances.filter(sid => !wipedInstances.includes(sid));
            progressLog += ` Done!\n\n**WARNING: ${failedInstances.join(', ')} failed to deploy and were NOT started. The database was left unchanged.${safeToRetry.length > 0 ? ` ${safeToRetry.join(', ')} still have their files, so the update can be run again. Backups are in \`./vault/${pack.tag}/instances/\`.` : ""}**${wipedWarning(wipedInstances, pack.tag)}`;
            await editProgress(interaction, progressLog);
            return;
        }

        progressLog += ` Done!\n- Updating data and sending update message...`;
        await editProgress(interaction, progressLog);
        await yggdrasil.updateServer(pack.tag, {
            modpack_version: newVersionNumber,
            fileID: pack.newestFileID,
            newestFileID: pack.newestFileID,
            requiresUpdate: false
        });

        //TODO ai summary ???
        const packData = await modpacksch.getFTBPackData(pack.modpackID);
        const updateMessageContent = updateMessage.replace("[PACKNAME]", pack.name)
            .replace("[NEWVERSION]", newVersionNumber)
            .replace("[OLDVERSION]", pack.modpackVersion)
            .replace("[CHANGELOGURL]", `https://www.feed-the-beast.com/modpacks/${pack.modpackID}?tab=versions`)
            .replace("[PINGROLE]", `<@&${pack.discordRoleId}>`)
            .replace("[SUMMARY]", "");

        const updateWebhook = {
            content: updateMessageContent,
            username: pack.name,
            avatarURL: packData.art[0].url,
        };

        await sendWebhook(announcementChannelId, updateWebhook);
    },

    /**
     * Restores an update from the list of available versions. Pterodactyl has trouble unpacking tar.gz files, so it repacks the backup to a zip file first.
     * @param {object} pack Object containing the server data.
     * @param {string} backup The backup file to restore from.
     * @param {object} interaction Object containing the interaction data. (for Discord)
     */
    restore: async function (pack, backup, interaction, serverIds = null) {
        const allServerIds = (serverIds && serverIds.length > 0 ? [...serverIds] : [pack.serverId]).sort();

        let restoredPackData = backup.match(/^.+?_(.+)_(.+)\.tar\.gz$/);

        let progressLog = `Restore sequence started for **${pack.name}** (${pack.modpackVersion} -> ${restoredPackData[1]}).`;
        await editProgress(interaction, progressLog);

        // Each instance goes back to its OWN backup where one exists. Backups taken before
        // per-instance updates shipped are a single shared archive holding whichever instance
        // happened to be first, so those get the per-server snapshot laid over the top.
        //
        // Every instance is resolved AND read end to end before any of them is touched:
        // /restore offers the union of the names found under all instances, and a backup
        // phase that died part-way through leaves archives for only the first few - or a
        // truncated one, which passes every exists/non-zero check and only announces itself
        // when the unpack fails, on an instance that has already been wiped. Either way the
        // pack ends up split across two versions with everything stopped.
        progressLog += `\n- Checking the backups...`;
        await editProgress(interaction, progressLog);

        const sources = {};
        const unusable = [];
        for (const sid of allServerIds) {
            const candidates = [instanceVaultPath(pack.tag, sid, backup), `./vault/${pack.tag}/${backup}`];
            // A corrupt per-instance archive falls through to the shared one rather than
            // being preferred just because it is the more specific path
            const usable = [];
            for (const candidate of candidates) {
                if (fs.existsSync(candidate) && await unpacker.verify(candidate)) usable.push(candidate);
            }
            if (usable.length > 0) sources[sid] = usable[0];
            else unusable.push(sid);
        }

        if (unusable.length > 0) {
            progressLog += `\n\n**Aborting: no usable \`${backup}\` for ${unusable.join(', ')}. Nothing was touched.**`;
            await editProgress(interaction, progressLog);
            return;
        }
        progressLog += ` Done!`;

        progressLog += `\n- Shutting down ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        for (const sid of allServerIds) await pterodactyl.shutdown(sid);

        const backupDir = `./${pack.tag}/backup`;
        const failedInstances = [];
        const wipedInstances = [];

        for (const sid of allServerIds) {
            const archivePath = sources[sid];
            const isShared = archivePath !== instanceVaultPath(pack.tag, sid, backup);

            progressLog += `\n- Restoring \`${sid}\` from ${isShared ? 'the shared backup' : 'its own backup'}...`;
            await editProgress(interaction, progressLog);

            try {
                if (!fs.existsSync(archivePath)) throw new Error(`no backup found at ${archivePath}`);

                rmRecursive(backupDir);
                await unpack(archivePath, backupDir);

                if (isShared) {
                    const perServerDir = `./vault/${pack.tag}/per-server/${sid}`;
                    const snapshot = perInstanceFiles.stashProtected(perServerDir, perInstanceFiles.listRelativeFiles(perServerDir));
                    const applied = perInstanceFiles.applyProtectedOverlay(backupDir, snapshot);
                    if (applied.length > 0) {
                        progressLog += ` (re-applied ${applied.join(', ')})`;
                        sessionLogger.info('UpdateManager', `Overlaid per-server files on ${sid}: ${applied.join(', ')}`);
                    }
                }

                const toDeleteList = fs.readdirSync(backupDir);
                const zipFile = `${pack.tag}_${sid}_${restoredPackData[1]}_${restoredPackData[2]}.zip`;
                await deployMergedTree(pack, sid, backupDir, zipFile, toDeleteList);
                safeRm(backupDir);
                progressLog += ` Done!`;
            } catch (error) {
                sessionLogger.error('UpdateManager', `Restore failed on ${sid}:`, error.message);
                progressLog += ` **FAILED: ${error.message}**`;
                failedInstances.push(sid);
                if (error.serverWiped) wipedInstances.push(sid);
                safeRm(backupDir);
            }
            await editProgress(interaction, progressLog);
        }

        // Instances are deliberately left stopped after a restore - start them by hand
        safeRm(`./${pack.tag}`);

        if (failedInstances.length > 0) {
            progressLog += `\n\n**WARNING: ${failedInstances.join(', ')} could not be restored. The database was left unchanged.**${wipedWarning(wipedInstances, pack.tag)}`;
            await editProgress(interaction, progressLog);
            return;
        }

        progressLog += `\n- Restore sequence completed. Updating data...`;
        await editProgress(interaction, progressLog);

        await yggdrasil.updateServer(pack.tag, {
            modpack_version: restoredPackData[1],
            fileID: restoredPackData[2],
            requiresUpdate: true
        });

    },

    /**
     * Updates the server with the latest version of the GregTech New Horizons modpack.
     * @param {object} pack Object with the server data.
     * @param {string} versionOverride Optional specific version to update to.
     * @param {object} interaction Object with the interaction data (for Discord).
     */
    updateGTNH: async function (pack, versionOverride, interaction, serverIds = null) {
        // Sorted so the order is deterministic rather than however the API listed them
        const allServerIds = (serverIds && serverIds.length > 0 ? [...serverIds] : [pack.serverId]).sort();
        const gtnh = require('../modules/gregtechnewhorizons');
        const protectedFiles = perInstanceFiles.forTag(pack.tag);
        
        // Get current and latest version URLs
        let currentVersionUrl = null;
        let newestVersionUrl = null;
        
        // If version override is specified, use that version
        if (versionOverride) {
            // Find the specific version in available versions
            const allVersions = await gtnh.getAllVersions();
            newestVersionUrl = allVersions.find(url => url.includes(`GT_New_Horizons_${versionOverride}_Server_Java_17-21.zip`));
            
            if (!newestVersionUrl) {
                const errorMsg = `Version ${versionOverride} not found in available GTNH versions!`;
                sessionLogger.error('UpdateManager', errorMsg);
                await editProgress(interaction, errorMsg);
                return;
            }
        } else {
            // Get the latest version
            newestVersionUrl = await gtnh.getLatestVersion();
        }
        
        // Get current version based on pack info
        const allVersions = await gtnh.getAllVersions();
        currentVersionUrl = allVersions.find(url => url.includes(`GT_New_Horizons_${pack.modpackVersion}_Server_Java_17-21.zip`));
        
        if (!currentVersionUrl) {
            const errorMsg = `Current version ${pack.modpackVersion} not found in available GTNH versions!`;
            sessionLogger.error('UpdateManager', errorMsg);
            await editProgress(interaction, errorMsg);
            return;
        }
        
        // Extract version numbers for display
        const currentVersion = gtnh.extractVersionFromUrl(currentVersionUrl);
        const newestVersion = gtnh.extractVersionFromUrl(newestVersionUrl);
        
        if (currentVersion === newestVersion) {
            const msg = `Server is already on the latest version (${currentVersion})!`;
            sessionLogger.info('UpdateManager', msg);
            await editProgress(interaction, msg);
            return;
        }
        
        // Start the update process
        const alert = alertScheduledUpdate.replace("[NEWVERSION]", newestVersion);
        let progressLog = `Update sequence started for **${pack.name}** (${currentVersion} -> ${newestVersion}).`;
        await editProgress(interaction, progressLog);
        
        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);
          // Clear working directory
        safeRm(`./${pack.tag}`);
        
        // Check if we have valid version information
        if (!newestVersion || !currentVersion) {
            const errorMsg = `Failed to extract version information from URLs. Current: ${currentVersionUrl}, Newest: ${newestVersionUrl}`;
            sessionLogger.error('UpdateManager', errorMsg);
            await editProgress(interaction, errorMsg);
            return;
        }
        
        // Download server packs
        progressLog += `\n- Downloading new server pack (version ${newestVersion})...`;
        await editProgress(interaction, progressLog);
        await download(newestVersionUrl, `./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Downloading reference server pack (version ${currentVersion})...`;
        await editProgress(interaction, progressLog);
        await download(currentVersionUrl, `./${pack.tag}/downloads/old/${pack.tag}_${currentVersion}.zip`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        // Extract packs
        progressLog += ` Done!\n- Decompressing new pack files...`;
        await editProgress(interaction, progressLog);
        await decompress(`./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`, `./${pack.tag}/compare/new`);
        await checkMods(`./${pack.tag}/compare/new`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Decompressing reference pack files...`;
        await editProgress(interaction, progressLog);
        await decompress(`./${pack.tag}/downloads/old/${pack.tag}_${currentVersion}.zip`, `./${pack.tag}/compare/old`);
        await checkMods(`./${pack.tag}/compare/old`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        const diskError = checkDiskSpace(`./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`, allServerIds.length);
        if (diskError) {
            progressLog += `\n\n**Aborting: ${diskError} Nothing was touched.**`;
            await editProgress(interaction, progressLog);
            return;
        }

        // Get current server files
        let toCompressList = [];
        await fs.readdirSync(`./${pack.tag}/compare/old`).forEach(file => {
            toCompressList.push(file);
        });
        
        progressLog += ` Done!\n- Shutting down ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        for (const sid of allServerIds) await pterodactyl.shutdown(sid);

        // PHASE A - back up every instance before anything destructive happens
        const vaultFileName = `${pack.tag}_${pack.modpackVersion}_${currentVersion}.tar.gz`;
        progressLog += ` Done!\n- Backing up ${allServerIds.length > 1 ? `all ${allServerIds.length} instances` : 'the server'}...`;
        await editProgress(interaction, progressLog);

        let archives;
        try {
            archives = await backupAllInstances(pack, allServerIds, toCompressList, vaultFileName, protectedFiles);
        } catch (error) {
            sessionLogger.error('UpdateManager', 'Backup phase failed:', error.message);
            progressLog += `\n\n**Aborting: backup failed (${error.message}). Server files are untouched, starting everything back up.**`;
            await editProgress(interaction, progressLog);
            const notRestarted = await startInstances(allServerIds);
            if (notRestarted.length > 0) {
                progressLog += `\n**${notRestarted.join(', ')} did not come back up - start them from the panel.**`;
                await editProgress(interaction, progressLog);
            }
            return;
        }

        progressLog += ` Done!\n- Comparing pack versions...`;
        await editProgress(interaction, progressLog);
        // Compare old reference pack with new reference pack - same for every instance
        const changeList = await comparator.compare(`./${pack.tag}/compare/old`, `./${pack.tag}/compare/new`);
        progressLog += ` Done!\n- **Files to delete**: ${changeList.deletions.length}, **Files to add**: ${changeList.additions.length}`;
        await editProgress(interaction, progressLog);

        // Helper function to get full relative path from various possible inputs
        function getPathFromEntry(entry) {
            if (typeof entry === 'string') {
                // If it's already a string path
                return entry.startsWith('/') ? entry.substring(1) : entry;
            } else if (typeof entry === 'object' && entry !== null) {
                // If it's an object from the comparator
                const objPath = entry.path;
                const objName = entry.name || entry.name1 || entry.name2;

                if (typeof objPath === 'string' && typeof objName === 'string') {
                    let fullPath = objPath.endsWith('/') ? objPath + objName : objPath + '/' + objName;
                    fullPath = fullPath.replace(/\/+/g, '/'); // Replace multiple slashes with one
                    return fullPath.startsWith('/') ? fullPath.substring(1) : fullPath;
                } else if (typeof entry.relativePath === 'string') {
                    // Handle potential alternative structure { relativePath: '...' }
                     return entry.relativePath.startsWith('/') ? entry.relativePath.substring(1) : entry.relativePath;
                }
            }
            // If input is invalid or path cannot be determined
            sessionLogger.warn('UpdateManager', 'Could not determine path from entry:', entry);
            return null;
        }

        // Filter out excluded files/folders from the standard change list BEFORE merging
        progressLog += `\n- Filtering excluded files from change list...`;
        await editProgress(interaction, progressLog);

        const originalDeletionCount = changeList.deletions.length;
        const originalAdditionCount = changeList.additions.length;

        // Create NEW filtered lists, don't modify original changeList directly yet
        const filteredDeletions = changeList.deletions.filter(entry => {
            const path = getPathFromEntry(entry);
            // Ensure path is valid before checking exclusion
            return typeof path === 'string' && !gtnh.isExcluded(path);
        });

        const filteredAdditions = changeList.additions.filter(entry => {
            const path = getPathFromEntry(entry);
            // Ensure path is valid before checking exclusion
            return typeof path === 'string' && !gtnh.isExcluded(path);
        });

        // Create a new object for the merge operation containing only filtered changes
        const filteredChangeList = {
            deletions: filteredDeletions,
            additions: filteredAdditions
        };

        const filteredDeletionCount = filteredDeletions.length;
        const filteredAdditionCount = filteredAdditions.length;

        progressLog += ` Done! Filtered ${originalDeletionCount - filteredDeletionCount} deletions and ${originalAdditionCount - filteredAdditionCount} additions.`;
        await editProgress(interaction, progressLog);

        const filteredDeleteList = toCompressList.filter(item => {
            // Don't delete excluded folders or files
            return !gtnh.isExcluded(item);
        });

        // PHASE B - each instance is merged from its OWN files and deployed on its own
        const instanceManifests = {};
        const failedInstances = [];
        const wipedInstances = [];
        const mainDir = `./${pack.tag}/compare/main`;

        for (const sid of allServerIds) {
            progressLog += `\n- Merging and deploying \`${sid}\`...`;
            await editProgress(interaction, progressLog);

            try {
                const result = await mergeAndDeployInstance(pack, sid, {
                    archivePath: archives[sid],
                    mainDir,
                    applyMerge: async () => merger.merge(`./${pack.tag}`, filteredChangeList),
                    protectedFiles,
                    zipName: `update_${pack.tag}_${sid}_${newestVersion}.zip`,
                    deleteList: filteredDeleteList,
                    inspect: async (dir) => {
                        const customChanges = await comparator.findCustomChanges(dir, `./${pack.tag}/compare/old`);
                        const overWrites = customChanges.editedFiles.filter(file => filteredChangeList.additions.includes(file));
                        return ` custom: ${customChanges.customFiles.length}, edited: ${customChanges.editedFiles.length}, overwritten: ${overWrites.length}.`;
                    }
                });
                instanceManifests[sid] = result.manifest;
                progressLog += `${result.note} Done!`;
            } catch (error) {
                sessionLogger.error('UpdateManager', `Deploy failed on ${sid}:`, error.message);
                progressLog += ` **FAILED: ${error.message}**`;
                failedInstances.push(sid);
                if (error.serverWiped) wipedInstances.push(sid);
                safeRm(mainDir);
            }
            await editProgress(interaction, progressLog);
        }

        // An instance whose deploy failed must not boot in a half-written state
        progressLog += `\n- Starting ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        const notStarted = await startInstances(allServerIds, failedInstances);

        progressLog += ` Done!${notStartedWarning(notStarted)}${await safeInstanceDiff(instanceManifests, allServerIds)}`;
        progressLog += `\n- Update sequence completed. Cleaning up...`;
        await editProgress(interaction, progressLog);
        safeRm(`./${pack.tag}`); // Clean up temp directory

        if (failedInstances.length > 0) {
            const safeToRetry = failedInstances.filter(sid => !wipedInstances.includes(sid));
            progressLog += ` Done!\n\n**WARNING: ${failedInstances.join(', ')} failed to deploy and were NOT started. The database was left unchanged.${safeToRetry.length > 0 ? ` ${safeToRetry.join(', ')} still have their files, so the update can be run again. Backups are in \`./vault/${pack.tag}/instances/\`.` : ""}**${wipedWarning(wipedInstances, pack.tag)}`;
            await editProgress(interaction, progressLog);
            return;
        }

        progressLog += ` Done!\n- Updating data and sending update message...`;
        await editProgress(interaction, progressLog);
        // Use consistent database update
        await yggdrasil.updateServer(pack.tag, {
            modpack_version: newestVersion,
            requiresUpdate: false
        });

        // Use consistent webhook structure
        // Note: GTNH doesn't have a specific pack data endpoint like CF/FTB for logo/summary
        const updateMessageContent = updateMessage.replace("[PACKNAME]", pack.name)
            .replace("[NEWVERSION]", newestVersion)
            .replace("[OLDVERSION]", currentVersion) // Use the extracted currentVersion
            .replace("[CHANGELOGURL]", `https://wiki.gtnewhorizons.com/wiki/Upcoming_Features`) // Standard GTNH changelog link
            .replace("[PINGROLE]", `<@&${pack.discordRoleId}>`)
            .replace("[SUMMARY]", "Check the GTNH wiki for detailed changes."); // Placeholder summary

        const updateWebhook = {
            content: updateMessageContent,
            username: `${pack.name} Updater`, // Consistent username
            avatarURL: "", // No standard avatar for GTNH packs
        };

        if (active) {
            await sendWebhook(announcementChannelId, updateWebhook);
        }

        progressLog += ` Done!\n\n**Update completed successfully!** The server **${pack.name}** is now running GTNH version **${newestVersion}**.`;
        await editProgress(interaction, progressLog);
    },

    /**
     * Updates the server with a version of GregTech Odyssey from GitHub releases.
     * Multi-instance aware: per-server files (difficulty, ports) are snapshotted from each
     * instance before deploy and written back after, so instances keep their identity.
     * @param {object} pack Object with the server data.
     * @param {string} versionOverride Release tag to update to (latest release if omitted).
     * @param {object} interaction Object with the interaction data (for Discord).
     * @param {Array} serverIds Pterodactyl server ids of all instances sharing the tag.
     */
    updateGTO: async function (pack, versionOverride, interaction, serverIds = null) {
        // Sorted so the order is deterministic rather than however the API listed them
        const allServerIds = (serverIds && serverIds.length > 0 ? [...serverIds] : [pack.serverId]).sort();
        const gto = require('../modules/gregtechodyssey');
        const protectedFiles = gto.perServerFiles;

        // Resolve the target release
        let newRelease;
        if (versionOverride) {
            newRelease = await gto.resolveVersion(versionOverride);
            if (!newRelease) {
                const errorMsg = `Version ${versionOverride} not found in GTO releases (or it has no server pack asset)!`;
                sessionLogger.error('UpdateManager', errorMsg);
                await editProgress(interaction, errorMsg);
                return;
            }
        } else {
            newRelease = await gto.getLatestVersion();
        }

        // The old reference pack is mandatory: without it the three-way merge cannot
        // separate admin changes from pack changes, so abort instead of guessing.
        const oldRelease = await gto.resolveVersion(pack.modpackVersion);
        if (!oldRelease) {
            const errorMsg = `Current version ${pack.modpackVersion} not found in GTO releases! The old reference pack is required for a safe three-way merge. Aborting - nothing was touched.`;
            sessionLogger.error('UpdateManager', errorMsg);
            await editProgress(interaction, errorMsg);
            return;
        }

        const currentVersion = oldRelease.tag;
        const newestVersion = newRelease.tag;

        if (currentVersion === newestVersion) {
            const msg = `Server is already on the latest version (${currentVersion})!`;
            sessionLogger.info('UpdateManager', msg);
            await editProgress(interaction, msg);
            return;
        }

        const alert = alertScheduledUpdate.replace("[NEWVERSION]", newestVersion);
        let progressLog = `Update sequence started for **${pack.name}** (${currentVersion} -> ${newestVersion}).`;
        await editProgress(interaction, progressLog);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);
        // Clear working directory
        safeRm(`./${pack.tag}`);

        // Download server packs
        progressLog += `\n- Downloading new server pack (version ${newestVersion})...`;
        await editProgress(interaction, progressLog);
        await download(newRelease.url, `./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Downloading reference server pack (version ${currentVersion})...`;
        await editProgress(interaction, progressLog);
        await download(oldRelease.url, `./${pack.tag}/downloads/old/${pack.tag}_${currentVersion}.zip`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        // Extract packs (checkMods hoists the zip's top-level server/ directory)
        progressLog += ` Done!\n- Decompressing new pack files...`;
        await editProgress(interaction, progressLog);
        await decompress(`./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`, `./${pack.tag}/compare/new`);
        await checkMods(`./${pack.tag}/compare/new`);

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        progressLog += ` Done!\n- Decompressing reference pack files...`;
        await editProgress(interaction, progressLog);
        await decompress(`./${pack.tag}/downloads/old/${pack.tag}_${currentVersion}.zip`, `./${pack.tag}/compare/old`);
        await checkMods(`./${pack.tag}/compare/old`);

        // The zips nest everything under server/ - if hoisting failed the comparison
        // would diff garbage and the merge would wreck the server, so verify mods/ landed.
        if (!fs.existsSync(`./${pack.tag}/compare/new/mods`) || !fs.existsSync(`./${pack.tag}/compare/old/mods`)) {
            const errorMsg = `Pack layout check failed: no mods folder after extraction. The GTO zip layout may have changed. Aborting - nothing was touched.`;
            sessionLogger.error('UpdateManager', errorMsg);
            await editProgress(interaction, progressLog + `\n\n**${errorMsg}**`);
            return;
        }

        for (const sid of allServerIds) await pterodactyl.sendCommand(sid, alert);

        const diskError = checkDiskSpace(`./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`, allServerIds.length);
        if (diskError) {
            progressLog += `\n\n**Aborting: ${diskError} Nothing was touched.**`;
            await editProgress(interaction, progressLog);
            return;
        }

        // Get current server files
        let toCompressList = [];
        await fs.readdirSync(`./${pack.tag}/compare/old`).forEach(file => {
            toCompressList.push(file);
        });

        progressLog += ` Done!\n- Shutting down ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        for (const sid of allServerIds) await pterodactyl.shutdown(sid);

        // PHASE A - back up every instance before anything destructive happens
        const vaultFileName = `${pack.tag}_${pack.modpackVersion}_${currentVersion}.tar.gz`;
        progressLog += ` Done!\n- Backing up ${allServerIds.length > 1 ? `all ${allServerIds.length} instances` : 'the server'} (protecting ${protectedFiles.join(', ')})...`;
        await editProgress(interaction, progressLog);

        let archives;
        try {
            archives = await backupAllInstances(pack, allServerIds, toCompressList, vaultFileName, protectedFiles);
        } catch (error) {
            sessionLogger.error('UpdateManager', 'Backup phase failed:', error.message);
            progressLog += `\n\n**Aborting: backup failed (${error.message}). Server files are untouched, starting everything back up.**`;
            await editProgress(interaction, progressLog);
            const notRestarted = await startInstances(allServerIds);
            if (notRestarted.length > 0) {
                progressLog += `\n**${notRestarted.join(', ')} did not come back up - start them from the panel.**`;
                await editProgress(interaction, progressLog);
            }
            return;
        }

        progressLog += ` Done!\n- Comparing pack versions...`;
        await editProgress(interaction, progressLog);
        // Compare old reference pack with new reference pack - same for every instance
        const changeList = await comparator.compare(`./${pack.tag}/compare/old`, `./${pack.tag}/compare/new`);
        progressLog += ` Done!\n- **Files to delete**: ${changeList.deletions.length}, **Files to add**: ${changeList.additions.length}`;
        await editProgress(interaction, progressLog);

        // Helper function to get full relative path from various possible inputs
        function getPathFromEntry(entry) {
            if (typeof entry === 'string') {
                return entry.startsWith('/') ? entry.substring(1) : entry;
            } else if (typeof entry === 'object' && entry !== null) {
                const objPath = entry.path;
                const objName = entry.name || entry.name1 || entry.name2;

                if (typeof objPath === 'string' && typeof objName === 'string') {
                    let fullPath = objPath.endsWith('/') ? objPath + objName : objPath + '/' + objName;
                    fullPath = fullPath.replace(/\/+/g, '/');
                    return fullPath.startsWith('/') ? fullPath.substring(1) : fullPath;
                } else if (typeof entry.relativePath === 'string') {
                    return entry.relativePath.startsWith('/') ? entry.relativePath.substring(1) : entry.relativePath;
                }
            }
            sessionLogger.warn('UpdateManager', 'Could not determine path from entry:', entry);
            return null;
        }

        // Filter out excluded files/folders from the standard change list BEFORE merging
        progressLog += `\n- Filtering excluded files from change list...`;
        await editProgress(interaction, progressLog);

        const originalDeletionCount = changeList.deletions.length;
        const originalAdditionCount = changeList.additions.length;

        const filteredDeletions = changeList.deletions.filter(entry => {
            const path = getPathFromEntry(entry);
            return typeof path === 'string' && !gto.isExcluded(path);
        });

        const filteredAdditions = changeList.additions.filter(entry => {
            const path = getPathFromEntry(entry);
            return typeof path === 'string' && !gto.isExcluded(path);
        });

        const filteredChangeList = {
            deletions: filteredDeletions,
            additions: filteredAdditions
        };

        progressLog += ` Done! Filtered ${originalDeletionCount - filteredDeletions.length} deletions and ${originalAdditionCount - filteredAdditions.length} additions.`;
        await editProgress(interaction, progressLog);

        const filteredDeleteList = toCompressList.filter(item => {
            // Don't delete excluded folders or files
            return !gto.isExcluded(item);
        });

        // PHASE B - each instance is merged from its OWN files and deployed on its own.
        // Difficulty and ports ride along in the archive rather than being written back
        // afterwards, so there is no post-deploy write that can fail and strand an instance.
        const instanceManifests = {};
        const failedInstances = [];
        const wipedInstances = [];
        const mainDir = `./${pack.tag}/compare/main`;

        for (const sid of allServerIds) {
            progressLog += `\n- Merging and deploying \`${sid}\`...`;
            await editProgress(interaction, progressLog);

            try {
                const result = await mergeAndDeployInstance(pack, sid, {
                    archivePath: archives[sid],
                    mainDir,
                    applyMerge: async () => merger.merge(`./${pack.tag}`, filteredChangeList),
                    protectedFiles,
                    zipName: `update_${pack.tag}_${sid}_${newestVersion}.zip`,
                    deleteList: filteredDeleteList,
                    inspect: async (dir) => {
                        const customChanges = await comparator.findCustomChanges(dir, `./${pack.tag}/compare/old`);
                        const overWrites = customChanges.editedFiles.filter(file => filteredChangeList.additions.includes(file));
                        return ` custom: ${customChanges.customFiles.length}, edited: ${customChanges.editedFiles.length}, overwritten: ${overWrites.length}.`;
                    }
                });
                instanceManifests[sid] = result.manifest;
                progressLog += `${result.note} Done!`;
            } catch (error) {
                sessionLogger.error('UpdateManager', `Deploy failed on ${sid}:`, error.message);
                progressLog += ` **FAILED: ${error.message}**`;
                failedInstances.push(sid);
                if (error.serverWiped) wipedInstances.push(sid);
                safeRm(mainDir);
            }
            await editProgress(interaction, progressLog);
        }

        // An instance whose deploy failed must not boot with another one's identity
        progressLog += `\n- Starting ${allServerIds.length > 1 ? 'all instances' : 'the server'}...`;
        await editProgress(interaction, progressLog);
        const notStarted = await startInstances(allServerIds, failedInstances);

        progressLog += ` Done!${notStartedWarning(notStarted)}${await safeInstanceDiff(instanceManifests, allServerIds)}`;
        progressLog += `\n- Update sequence completed. Cleaning up...`;
        await editProgress(interaction, progressLog);
        safeRm(`./${pack.tag}`); // Clean up temp directory

        if (failedInstances.length > 0) {
            const safeToRetry = failedInstances.filter(sid => !wipedInstances.includes(sid));
            progressLog += ` Done!\n\n**WARNING: ${failedInstances.join(', ')} failed to deploy and were NOT started. The database was left unchanged.${safeToRetry.length > 0 ? ` ${safeToRetry.join(', ')} still have their files, so the update can be run again. Backups are in \`./vault/${pack.tag}/instances/\`, per-server files in \`./vault/${pack.tag}/per-server/\`.` : ""}**${wipedWarning(wipedInstances, pack.tag)}`;
            await editProgress(interaction, progressLog);
            return;
        }

        progressLog += ` Done!\n- Updating data and sending update message...`;
        await editProgress(interaction, progressLog);
        await yggdrasil.updateServer(pack.tag, {
            modpack_version: newestVersion,
            requiresUpdate: false
        });

        const updateMessageContent = updateMessage.replace("[PACKNAME]", pack.name)
            .replace("[NEWVERSION]", newestVersion)
            .replace("[OLDVERSION]", currentVersion)
            .replace("[CHANGELOGURL]", newRelease.htmlUrl)
            .replace("[PINGROLE]", `<@&${pack.discordRoleId}>`)
            .replace("[SUMMARY]", "Check the GitHub release for detailed changes.");

        const updateWebhook = {
            content: updateMessageContent,
            username: `${pack.name} Updater`,
            avatarURL: "",
        };

        if (active) {
            await sendWebhook(announcementChannelId, updateWebhook);
        }

        progressLog += ` Done!\n\n**Update completed successfully!** The server **${pack.name}** is now running GTO version **${newestVersion}**.`;
        await editProgress(interaction, progressLog);
    },
};
