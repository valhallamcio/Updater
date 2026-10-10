/*
 * playerSync.js
 *
 * The Valhalla-Updater side of player sync (bifrost-lib docs/invariants/player-sync.md,
 * sections 6.6 and 7). The instances of one Bifrost group can move a player's character
 * between them. VU pauses those moves while the instances stop for an update or a restore,
 * reseeds a restored instance, and opens moves again once every instance is back on one
 * pack fingerprint. Routes: /v1/biforesting/sync on Yggdrasil.
 *
 * The gate: a tag takes part only when its instances share a non-empty `group` and
 * GET /sync/:group answers mode shadow or live. Mode off, a 404, no group, or Yggdrasil down
 * at the check keep today's behaviour. Nothing here throws into an update, a restore or a
 * reboot: an error is logged and reported, and the work goes on.
 */

const sessionLogger = require('./sessionLogger');

const SYNC_PATH = '/biforesting/sync';
const ACTIVE_MODES = ['shadow', 'live'];
const ACTOR = 'valhalla-updater';
const REQUEST_TIMEOUT_MS = 10000;
const POLL_MS = 15000;
const DEFAULT_UNFREEZE_WAIT_MINUTES = 15;
// Yggdrasil caps freezeReason at 200 characters.
const MAX_REASON_LENGTH = 200;
// Freeze reasons VU writes. A freeze with any other reason belongs to staff, and VU leaves it on.
const VU_REASON = /^(update|restore) /;

/**
 * How long a release waits for the instances: config.json playerSync.unfreezeWaitMinutes.
 * @returns {number} Milliseconds.
 */
function configuredWaitMs() {
    try {
        const minutes = require('../config/config.json').playerSync?.unfreezeWaitMinutes;
        if (typeof minutes === 'number' && minutes >= 0) return minutes * 60000;
    } catch (error) {
        // No config file: use the default
    }
    return DEFAULT_UNFREEZE_WAIT_MINUTES * 60000;
}

/** True when VU froze the group for an update or a restore. */
function isUpdaterFreeze(reason) {
    return VU_REASON.test(reason || '');
}

function formatWait(ms) {
    return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`;
}

/** A count from a reseed answer field, which can be a number or a list. */
function count(value) {
    if (Array.isArray(value)) return value.length;
    return typeof value === 'number' ? value : '?';
}

/**
 * An axios error as one Error with the HTTP status and the Yggdrasil error code.
 * @returns {Error} error.status and error.code are null when the request got no answer.
 */
function syncError(error, what) {
    const status = error.response?.status ?? null;
    const code = error.response?.data?.error?.code ?? null;
    const detail = error.response?.data?.error?.message || error.message;
    const wrapped = new Error(`${what}: ${status ? `HTTP ${status} ` : ''}${detail}`);
    wrapped.status = status;
    wrapped.code = code;
    return wrapped;
}

/**
 * The one sync group that every given instance has in its server doc.
 * @param {Array} servers Server docs from Yggdrasil.
 * @param {Array} serverIds Pterodactyl ids of the instances.
 * @returns {string|null} The group, or null when one has none or they differ.
 */
function sharedGroup(servers, serverIds) {
    const groups = new Set(serverIds.map(sid => {
        const doc = servers.find(s => s.serverId === sid);
        return doc && typeof doc.group === 'string' ? doc.group.trim() : '';
    }));
    if (groups.size !== 1) return null;
    const [group] = groups;
    return group || null;
}

/**
 * Why moves of a group cannot open yet.
 * @param {object} status GET /sync/:group answer.
 * @returns {string|null} null when every instance is live and on one pack fingerprint.
 */
function unfreezeBlocker(status) {
    const instances = Array.isArray(status.instances) ? status.instances : [];
    if (instances.length === 0) return 'Yggdrasil lists no instances for the group';
    const down = instances.filter(i => !i.live).map(i => i.serverId);
    if (down.length > 0) return `${down.join(', ')} not linked`;
    if (!instances.every(i => i.fpMatch === true)) {
        return `pack fingerprints differ (${instances.map(i => `${i.serverId}: ${i.fp ?? 'none'}`).join(', ')})`;
    }
    return null;
}

/** Like unfreezeBlocker, for "these instances are live" only. */
function liveBlocker(serverIds) {
    return (status) => {
        const instances = Array.isArray(status.instances) ? status.instances : [];
        const down = serverIds.filter(sid => !instances.some(i => i.serverId === sid && i.live));
        return down.length > 0 ? `${down.join(', ')} not linked` : null;
    };
}

/**
 * Builds a player sync client.
 * @param {object} deps Injectable for tests: http (axios-like get/put/post), listServers,
 *   sleep, now, pollMs, unfreezeWaitMs, log.
 */
function createPlayerSync(deps = {}) {
    const http = () => deps.http || require('./yggdrasil').apiClient;
    const listServers = deps.listServers || (() => {
        const yggdrasil = require('./yggdrasil');
        return yggdrasil.getServers(yggdrasil.SERVER_LIST_MAX_AGE_MS);
    });
    const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = deps.now || Date.now;
    const pollMs = deps.pollMs != null ? deps.pollMs : POLL_MS;
    const waitMs = () => (deps.unfreezeWaitMs != null ? deps.unfreezeWaitMs : configuredWaitMs());
    const log = deps.log || sessionLogger;

    const request = { timeout: REQUEST_TIMEOUT_MS, headers: { 'X-Actor': ACTOR } };
    const groupPath = group => `${SYNC_PATH}/${encodeURIComponent(group)}`;

    /** A progress callback that can never throw into the caller. */
    const reporter = report => async (text) => {
        if (!report) return;
        try {
            await report(text);
        } catch (error) {
            log.warn('PlayerSync', `Could not report progress: ${error.message}`);
        }
    };

    /**
     * GET /sync/:group.
     * @returns {Promise<object|null>} The group status, or null on a 404 (no sync doc).
     * @throws On any other error.
     */
    async function getGroup(group) {
        try {
            const response = await http().get(groupPath(group), request);
            return response.data.data;
        } catch (error) {
            if (error.response?.status === 404) return null;
            throw syncError(error, `GET sync group ${group}`);
        }
    }

    /** PUT /sync/:group {frozen, freezeReason}. @returns {Promise<object>} The group doc. */
    async function setFrozen(group, frozen, reason = null) {
        const body = { frozen, freezeReason: frozen && reason ? String(reason).slice(0, MAX_REASON_LENGTH) : null };
        try {
            const response = await http().put(groupPath(group), body, request);
            return response.data.data;
        } catch (error) {
            throw syncError(error, `PUT sync group ${group}`);
        }
    }

    /**
     * POST /sync/:group/reseed {serverId}: the instance's disk becomes the truth for the players it owns.
     * @returns {Promise<object>} { group, serverId, movesAborted: [moveId], movesStuck: [moveId], trusted,
     *   disownsQueued, disownBatches }. Idempotent.
     * @throws error.code 'not_frozen' when the group is not frozen, 'not_member' when the server is not in it.
     */
    async function reseed(group, serverId) {
        try {
            const response = await http().post(`${groupPath(group)}/reseed`, { serverId }, request);
            return response.data.data;
        } catch (error) {
            throw syncError(error, `reseed ${serverId} in ${group}`);
        }
    }

    /**
     * Polls GET /sync/:group until blocker(status) is null or the time runs out.
     * Never throws: an error counts as "not ready yet".
     * @returns {Promise<{ready: boolean, status?: object, reason?: string}>}
     */
    async function waitUntil(group, timeoutMs, blocker) {
        const deadline = now() + timeoutMs;
        let reason = 'no answer';
        for (;;) {
            try {
                const status = await getGroup(group);
                reason = status ? blocker(status) : 'Yggdrasil has no sync doc for the group';
                if (status && reason === null) return { ready: true, status };
            } catch (error) {
                reason = `Yggdrasil unreachable (${error.message})`;
            }
            if (now() >= deadline) break;
            await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
        }
        return { ready: false, reason: `${reason} after ${formatWait(timeoutMs)}` };
    }

    /** Waits until every instance of the group is live and fpMatch is true on all of them. */
    function waitForUnfreezeReady(group, timeoutMs = waitMs()) {
        return waitUntil(group, timeoutMs, unfreezeBlocker);
    }

    /** Waits until each of the given instances is live. */
    function waitForLive(group, serverIds, timeoutMs = waitMs()) {
        return waitUntil(group, timeoutMs, liveBlocker(serverIds));
    }

    /**
     * The gate for one group.
     * @returns {Promise<{synced: boolean|null, doc: object|null, note: string}>} synced is true
     *   for mode shadow or live, false for mode off or no sync doc, null when Yggdrasil is down.
     */
    async function checkGroup(group) {
        try {
            const doc = await getGroup(group);
            if (!doc) return { synced: false, doc: null, note: 'no sync doc' };
            return { synced: ACTIVE_MODES.includes(doc.mode), doc, note: `mode ${doc.mode}` };
        } catch (error) {
            return { synced: null, doc: null, note: error.message };
        }
    }

    /**
     * The synced groups among a list of servers that hold two or more of them.
     * @param {Array} servers Server docs, in the order the caller works on them.
     * @returns {Promise<Map>} group -> its servers, in the given order.
     */
    async function activeGroupsAmong(servers, label) {
        const byGroup = new Map();
        for (const server of servers) {
            const group = typeof server.group === 'string' ? server.group.trim() : '';
            if (!group) continue;
            if (!byGroup.has(group)) byGroup.set(group, []);
            byGroup.get(group).push(server);
        }
        const active = new Map();
        for (const [group, members] of byGroup) {
            if (members.length < 2) continue;
            const gate = await checkGroup(group);
            if (gate.synced) {
                active.set(group, members);
            } else {
                log.info('PlayerSync', `${label}: sync group ${group} keeps the normal timing (${gate.synced === null ? 'Yggdrasil unreachable: ' : ''}${gate.note})`);
            }
        }
        return active;
    }

    /**
     * Pauses moves of the sync group that the instances share. Call it before the first of them stops.
     * @param {Array} serverIds Every instance the run stops.
     * @param {object} opts { label, reason, report, restore }. report(text) appends to the progress.
     * @returns {Promise<object>} Freeze handle for releaseFreeze and reseedAndRelease.
     */
    async function freezeGroup(serverIds, { label, reason, report, restore = false } = {}) {
        const say = reporter(report);
        const handle = { group: null, synced: false, frozen: false, keepFrozen: false, label, reason };
        try {
            let servers;
            try {
                servers = await listServers();
            } catch (error) {
                log.warn('PlayerSync', `${label}: could not read the server list (${error.message}), so no move freeze`);
                return handle;
            }
            const group = sharedGroup(servers, serverIds);
            if (!group) {
                log.info('PlayerSync', `${label}: no shared sync group, so no move freeze`);
                return handle;
            }
            handle.group = group;

            const gate = await checkGroup(group);
            handle.synced = gate.synced;
            if (gate.synced === null) {
                log.warn('PlayerSync', `${label}: could not check sync group ${group} (${gate.note}), so no move freeze`);
                await say(`\n- **Warning: could not check player sync for \`${group}\` (${gate.note}). This run goes on without a move freeze.**`);
                return handle;
            }
            if (!gate.synced) {
                log.info('PlayerSync', `${label}: sync group ${group} is not active (${gate.note}), so no move freeze`);
                return handle;
            }

            if (gate.doc.frozen && !VU_REASON.test(gate.doc.freezeReason || '')) {
                handle.frozen = true;
                handle.keepFrozen = true;
                log.info('PlayerSync', `${label}: sync group ${group} is already frozen (${gate.doc.freezeReason || 'no reason'}), VU leaves it frozen`);
                await say(`\n- Player sync: moves between \`${group}\` instances were already paused (${gate.doc.freezeReason || 'no reason given'}). They stay paused after this run.`);
                return handle;
            }

            try {
                await setFrozen(group, true, reason);
            } catch (error) {
                log.warn('PlayerSync', `${label}: could not freeze sync group ${group} (${error.message})`);
                await say(`\n- **Warning: could not pause moves for \`${group}\` (${error.message}). This run goes on. Players can still start a move while the instances stop.**`);
                return handle;
            }
            handle.frozen = true;
            log.info('PlayerSync', `${label}: froze sync group ${group} (${reason})`);
            await say(restore
                ? `\n- Player sync: moves between \`${group}\` instances are paused. After the restore, the restored world is the truth for the players on each restored instance.`
                : `\n- Player sync: moves between \`${group}\` instances are paused for the update.`);
        } catch (error) {
            log.warn('PlayerSync', `${label}: move freeze failed (${error.message})`);
        }
        return handle;
    }

    /** Reports loudly that the group stays frozen. Never throws. */
    async function stayFrozen(handle, reason, say, next = '') {
        log.error('PlayerSync', `${handle.label}: moves stay frozen for ${handle.group}: ${reason}`);
        await say(`\n\n**Moves stay frozen for \`${handle.group}\`: ${reason}. ${next}Unfreeze with a staff action (\`/sync-group unfreeze group:${handle.group}\`) once every instance is up on one pack.**`);
    }

    /** Waits for every instance on one fingerprint, then unfreezes. Never throws. */
    async function openMoves(handle, say, timeoutMs) {
        try {
            if (handle.keepFrozen) {
                log.info('PlayerSync', `${handle.label}: ${handle.group} was frozen before this run, VU leaves it frozen`);
                return false;
            }
            await say(`\n- Player sync: waiting up to ${formatWait(timeoutMs)} for every \`${handle.group}\` instance to link on one pack...`);
            const result = await waitForUnfreezeReady(handle.group, timeoutMs);
            if (!result.ready) {
                await stayFrozen(handle, result.reason, say);
                return false;
            }
            await setFrozen(handle.group, false);
            log.info('PlayerSync', `${handle.label}: unfroze sync group ${handle.group}`);
            await say(' Done! Moves are open again.');
            return true;
        } catch (error) {
            await stayFrozen(handle, `the unfreeze failed (${error.message})`, say);
            return false;
        }
    }

    /**
     * Opens moves again after an update. Call it after the database write.
     * @param {object} handle From freezeGroup.
     * @param {object} opts { report, stayReason, timeoutMs }. A stayReason leaves the group frozen at once.
     * @returns {Promise<boolean>} True when this call unfroze the group.
     */
    async function releaseFreeze(handle, { report, stayReason = null, timeoutMs } = {}) {
        const say = reporter(report);
        try {
            if (!handle || !handle.group || !handle.frozen) return false;
            if (stayReason) {
                await stayFrozen(handle, stayReason, say);
                return false;
            }
            return await openMoves(handle, say, timeoutMs != null ? timeoutMs : waitMs());
        } catch (error) {
            log.error('PlayerSync', `Release failed: ${error.message}`);
            return false;
        }
    }

    /** Reseeds one instance. On 409 not_frozen it freezes the group again and tries once more. */
    async function reseedFrozen(handle, serverId) {
        try {
            return await reseed(handle.group, serverId);
        } catch (error) {
            if (error.code !== 'not_frozen') throw error;
            log.warn('PlayerSync', `${handle.label}: reseed of ${serverId} refused, ${handle.group} is not frozen. Freezing it again`);
            await setFrozen(handle.group, true, handle.reason);
            return reseed(handle.group, serverId);
        }
    }

    /**
     * After a restore: waits for the restored instances to link, reseeds each one, then opens
     * moves as releaseFreeze does. Call it after the database write.
     * @param {object} handle From freezeGroup.
     * @param {Array} restoredIds The restored instances.
     * @param {object} opts { report, stayReason, timeoutMs }. A stayReason leaves the group frozen at once.
     * @returns {Promise<boolean>} True when this call unfroze the group.
     */
    async function reseedAndRelease(handle, restoredIds, { report, stayReason = null, timeoutMs } = {}) {
        const say = reporter(report);
        try {
            if (!handle || !handle.group) return false;
            const manual = `When the instances are up, reseed each one (POST /v1/biforesting/sync/${handle.group}/reseed with {"serverId": "<id>"}) while the group is frozen.`;
            if (!handle.frozen) {
                if (handle.synced !== false) {
                    log.error('PlayerSync', `${handle.label}: reseed of ${restoredIds.join(', ')} did not run, moves were never paused`);
                    await say(`\n\n**Player sync: the reseed of ${restoredIds.join(', ')} did not run, because moves of \`${handle.group}\` could not be paused. If the group is in shadow or live mode: freeze it, reseed each restored instance (POST /v1/biforesting/sync/${handle.group}/reseed with {"serverId": "<id>"}), then unfreeze.**`);
                }
                return false;
            }
            if (stayReason) {
                await stayFrozen(handle, `${stayReason}. The reseed did not run`, say, `${manual} `);
                return false;
            }

            const wait = timeoutMs != null ? timeoutMs : waitMs();
            await say(`\n- Player sync: start the restored instances from the panel. VU waits up to ${formatWait(wait)} for them to link, then reseeds them.`);
            const live = await waitForLive(handle.group, restoredIds, wait);
            if (!live.ready) {
                await stayFrozen(handle, `${live.reason}. The reseed did not run`, say, `${manual} `);
                return false;
            }

            for (const sid of restoredIds) {
                let result;
                try {
                    result = await reseedFrozen(handle, sid);
                } catch (error) {
                    await stayFrozen(handle, `the reseed of ${sid} failed (${error.message})`, say, `${manual} `);
                    return false;
                }
                log.info('PlayerSync', `${handle.label}: reseeded ${sid} in ${handle.group}: ${JSON.stringify(result)}`);
                const aborted = Array.isArray(result?.movesAborted) ? result.movesAborted.length : 0;
                const stuck = Array.isArray(result?.movesStuck) ? result.movesStuck : [];
                await say(`\n- Reseeded \`${sid}\`: ${count(result?.trusted)} players trusted, ${aborted} moves aborted, ${count(result?.disownsQueued)} disowns queued.`);
                // A stuck move stays stuck after the unfreeze. Staff release it per player.
                if (stuck.length > 0) {
                    await say(`\n- **Player sync: ${stuck.length} move(s) on \`${sid}\` are stuck and need staff (/instance sync <player>): ${stuck.join(', ')}.**`);
                }
            }
            return await openMoves(handle, say, wait);
        } catch (error) {
            log.error('PlayerSync', `Reseed and release failed: ${error.message}`);
            return false;
        }
    }

    return {
        getGroup,
        setFrozen,
        reseed,
        waitForUnfreezeReady,
        waitForLive,
        checkGroup,
        activeGroupsAmong,
        freezeGroup,
        releaseFreeze,
        reseedAndRelease
    };
}

module.exports = {
    ...createPlayerSync(),
    createPlayerSync,
    sharedGroup,
    unfreezeBlocker,
    isUpdaterFreeze,
    ACTIVE_MODES,
    DEFAULT_UNFREEZE_WAIT_MINUTES
};
