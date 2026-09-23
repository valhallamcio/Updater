const yggdrasil = require("../modules/yggdrasil");
const mongo = require("../modules/mongo");
const pterodactyl = require("../modules/pterodactyl");
const functions = require("../modules/functions");
const sessionLogger = require("../modules/sessionLogger");

// Triggers currently executing (30s tick vs multi-second awaited ops overlap — a slow
// execution must not be fired twice by the next tick).
const inFlight = new Set();

// A `give_item` op that is never dispatched expires after GIVE_EXPIRES_MS (Yggdrasil's
// minimum), and its sweep runs every 15 s, so the wait covers both. The exec timeout
// sits past the wait: an op the backend acked and never answered must still read as
// acked when the wait ends, never as a `failed` that would run the console lines too.
const GIVE_WAIT_MS = 75000;
const OP_EXPIRES_MS = 60000;
const GIVE_EXEC_TIMEOUT_MS = 120000;
// How long one `run_command` op may take before it is cancelled or read as unknown.
const COMMAND_WAIT_MS = 15000;

/**
 * The server a stored identifier names: a tag, a display name, or a Pterodactyl
 * serverId. A tag names every instance of a pack; the other two name ONE.
 * @param {object[]} servers Yggdrasil's server rows.
 * @param {string} id What the job stored in `serverNames`.
 * @returns {{server: object, byInstance: boolean}|null} The row, and whether it was named as one instance.
 */
function findServer(servers, id) {
    const needle = String(id).trim().toLowerCase();
    if (!needle) return null;
    const byTag = servers.find(s => String(s.tag || '').toLowerCase() === needle);
    if (byTag) return { server: byTag, byInstance: false };
    const byName = servers.find(s => String(s.name || '').trim().toLowerCase() === needle);
    if (byName) return { server: byName, byInstance: true };
    const byId = servers.find(s => String(s.serverId || '').toLowerCase() === needle);
    if (byId) return { server: byId, byInstance: true };
    return null;
}

/** Two rows are one server when they share a Pterodactyl id, or failing that a name. */
function sameServer(a, b) {
    if (!a || !b) return false;
    if (a.serverId && b.serverId) return String(a.serverId) === String(b.serverId);
    return String(a.name || '').trim() === String(b.name || '').trim();
}

module.exports = {
    name: 'playerEventScheduler',
    defaultConfig: {
        "active": true,
        "interval": 30 // Check every 30 seconds for responsive player events
    },

    /**
     * Phase 9 feature flag (rollback lever = flip to false, no redeploy of anything else).
     * Read lazily so tests can stub it; absent section = OFF (prod config predates it).
     */
    opsConfig: function () {
        try {
            return require("../config/config.json").yggdrasilOps ?? { useOpsApi: false };
        } catch (err) {
            return { useOpsApi: false };
        }
    },

    /**
     * Starts the player event scheduler
     * @param {object} options Configuration options
     */
    start: async function (options) {
        sessionLogger.info('PlayerEventScheduler', `Player Event Scheduler started - checking every ${options.interval} seconds`);
        
        // Start the main monitoring loop
        setInterval(() => this.mainLoop(options), options.interval * 1000);
        
        // Run initial check after a short delay
        setTimeout(() => this.mainLoop(options), options.interval * 1000);
    },

    /**
     * Main monitoring loop
     * @param {object} options Configuration options
     */
    mainLoop: async function (options) {
        try {
            // Check for player-triggered commands
            await this.checkPlayerTriggers();
            
        } catch (error) {
            sessionLogger.error('PlayerEventScheduler', 'Error in mainLoop:', error.message);
        }
    },

    /**
     * Check for player-triggered commands
     */
    checkPlayerTriggers: async function () {
        try {
            const playersData = await yggdrasil.getPlayers();
            const activeTriggers = await mongo.getActiveScheduleJobs('player_trigger');
            if (activeTriggers.length === 0) return;

            // playersData is keyed by server TAG (e.g. "gtnh"), but triggers store
            // full server NAMES (e.g. "GT New Horizons") or Pterodactyl ids — so a
            // direct playersData[serverName] lookup is always undefined and the
            // player is never seen as online. Resolve each stored identifier back
            // to its tag before looking it up.
            const servers = await yggdrasil.getServers();

            // A job addressed to ONE instance (by name or id) only fires while the
            // player stands on that instance. The console path cannot see a
            // failed `give`, so a player who hopped to the sibling instance would
            // get nothing and the job would still count as run.
            const needsInstances = activeTriggers.some(t =>
                (t.serverNames || []).some(id => (findServer(servers, id) || {}).byInstance));
            const detailed = needsInstances ? await yggdrasil.getPlayersDetailed() : null;

            for (const trigger of activeTriggers) {
                const { playerId, serverNames, commands, onJoin, lastSeenServers = [] } = trigger;

                // Track current servers (by their stored identifier) where the player is online.
                const currentServers = [];
                for (const serverName of serverNames) {
                    const found = findServer(servers, serverName);
                    const tag = found ? found.server.tag : serverName;
                    const online = playersData[tag];
                    if (!online || !online.some(u => u.toLowerCase() === String(playerId).toLowerCase())) continue;
                    if (found && found.byInstance && !this.onInstance(detailed, servers, tag, playerId, found.server)) continue;
                    currentServers.push(serverName);
                }
                
                const wasOnline = lastSeenServers.length > 0;
                const isOnline = currentServers.length > 0;
                
                if (isOnline) {
                    if (onJoin) {
                        // OnJoin mode: execute EVERY time player goes from offline → online
                        if (!wasOnline) {
                            // Player just came online - execute trigger
                            for (const serverName of currentServers) {
                                await this.executePlayerTrigger(trigger, serverName);
                                break; // Only execute once per join
                            }
                        }
                        // If player was already online, don't execute (not a new join)
                    } else {
                        // Normal mode: execute continuously while online (every check)
                        for (const serverName of currentServers) {
                            await this.executePlayerTrigger(trigger, serverName);
                            break; // Only execute once per check cycle
                        }
                    }
                }
                
                // Update last seen servers for this trigger  
                if (JSON.stringify(currentServers.sort()) !== JSON.stringify(lastSeenServers.sort())) {
                    await mongo.updateScheduleJob(trigger._id, { lastSeenServers: currentServers });
                }
            }
            
        } catch (error) {
            sessionLogger.error('PlayerEventScheduler', 'Error in player triggers:', error.message);
        }
    },

    /**
     * Is the player standing on this one instance right now?
     * @param {object|null} detailed `getPlayersDetailed()` rows by tag, or null when nothing asked for them.
     * @param {object[]} servers Yggdrasil's server rows.
     * @param {string} tag The instance's tag.
     * @param {string} playerId Username.
     * @param {object} server The instance the job names.
     * @returns {boolean} True only on that instance. A row without an instance passes only on a single-instance tag.
     */
    onInstance: function (detailed, servers, tag, playerId, server) {
        const rows = (detailed && detailed[tag]) || [];
        const row = rows.find(r => String(r.username || '').toLowerCase() === String(playerId).toLowerCase());
        if (!row) return false;
        if (!row.instance) return servers.filter(s => s.tag === tag).length <= 1;
        const standing = findServer(servers, row.instance);
        return Boolean(standing) && sameServer(standing.server, server);
    },

    /**
     * Execute commands for player trigger
     * @param {object} trigger Trigger configuration
     * @param {string} serverName Server where player was found
     */
    executePlayerTrigger: async function (trigger, serverName) {
        const key = String(trigger._id);
        if (inFlight.has(key)) return; // still executing from a previous tick
        inFlight.add(key);
        try {
            const servers = await yggdrasil.getServers();
            const found = findServer(servers, serverName);
            const server = found ? found.server : null;

            if (!server) return;

            // The proxy's cake bank cancels a job nobody ran inside its refund
            // window. This claim and that cancel both filter on `active`, so
            // exactly one of them wins, and a job that lost is never run. A
            // oneTime job is also claimed once only: a restart between the run
            // and the deactivation must not run it a second time.
            const claim = await mongo.claimScheduleJob(trigger._id, Boolean(trigger.oneTime));
            if (claim && claim.matchedCount === 0) {
                sessionLogger.info('PlayerEventScheduler', `Player trigger ${key} was cancelled before it ran, skipping`);
                return;
            }

            const results = trigger.give ? await this.runGive(trigger, server) : await this.runCommands(trigger, server);
            // The results are the only record of what the backend said. A job
            // writer (the proxy's cake bank) settles off them, so they go on the
            // document BEFORE the oneTime deactivation flips `active`. A failed
            // write here must not stop the deactivation: the commands already
            // ran, and a second run is the one thing that may never happen.
            try {
                await mongo.updateScheduleJob(trigger._id, { results: results, executedAt: new Date() });
            } catch (error) {
                sessionLogger.warn('PlayerEventScheduler', `Could not persist the results of ${key} (the job still deactivates):`, error.message);
            }
            await this.reportResults(trigger, server, results);

            // Mark trigger as executed (if it's one-time)
            if (trigger.oneTime) {
                await mongo.deactivateScheduleJob(trigger._id);
            }

        } catch (error) {
            sessionLogger.error('PlayerEventScheduler', 'Error executing player trigger:', error.message);
        } finally {
            inFlight.delete(key);
        }
    },

    /**
     * Run the trigger's commands — via link ops (captured output, completion-gated ordering)
     * when useOpsApi is on and the server is linked, else the classic Pterodactyl console path.
     *
     * Error split (double-execution hazard): an op that FAILED still RAN on the backend, so it
     * is only reported, never re-run via ptero. Only transport-level trouble (no link session,
     * createOp/timeout throw) falls back — and then the REMAINING commands all go via ptero.
     */
    runCommands: async function (trigger, server) {
        const results = [];
        // By Pterodactyl id when there is one: a tag can name two instances.
        const serverRef = server.serverId || server.tag;
        let viaOps = false;
        if (this.opsConfig().useOpsApi) {
            try {
                viaOps = !!(await yggdrasil.getLinkSession(serverRef));
            } catch (err) {
                viaOps = false;
            }
        }

        for (let i = 0; i < trigger.commands.length; i++) {
            const command = trigger.commands[i];
            if (viaOps) {
                let doc = null;
                let exists = false;
                try {
                    // The expiry matters: with the policy `ops` bit off an op waits as
                    // `pending` and runs the day the bit turns on, long after the console
                    // below has run the same line.
                    doc = await yggdrasil.runOp(serverRef, {
                        type: 'run_command',
                        params: { command },
                        expiresInMs: OP_EXPIRES_MS
                    }, COMMAND_WAIT_MS);
                    exists = true;
                } catch (err) {
                    if (err && err.opId) {
                        // Queued with no answer yet: cancel it before anything else runs the line.
                        exists = true;
                        doc = await this.tryCancel(err.opId) || await this.tryGetOp(err.opId);
                    } else {
                        sessionLogger.warn('PlayerEventScheduler', `Ops path failed (${err.message})`);
                    }
                }
                const row = exists ? this.commandRow(command, doc) : null;
                if (row) {
                    sessionLogger.info('PlayerEventScheduler', `Player trigger (op ${row.state}): '${command}' for ${trigger.playerId} on ${server.tag}`);
                    results.push(row);
                    continue; // op failed = command RAN and errored — report only, no ptero re-run
                }
                // The op provably never reached the backend: this line and the rest go by console.
                sessionLogger.warn('PlayerEventScheduler', `'${command}' never reached ${server.tag} over the link — falling back to Pterodactyl for the remaining commands`);
                viaOps = false;
            }
            sessionLogger.info('PlayerEventScheduler', `Player trigger: '${command}' executed for ${trigger.playerId} on ${server.tag}`);
            await pterodactyl.sendCommand(server.serverId, command);
            await functions.sleep(1000); // 1 second delay between commands
            results.push({ command, via: 'pterodactyl', state: 'sent', output: '' });
        }
        return results;
    },

    /**
     * Hand over a `give` spec (the proxy's cake bank) through one `give_item` op. The op
     * gives what fits and reports `given`, and the proxy puts the rest back in the bank.
     *
     * The console `commands` are the fallback, and they run only when the op provably
     * never reached the backend. An op that was sent and never answered is an `unknown`
     * row with no fallback: a second delivery is the one outcome that may never happen.
     * @returns {object[]} the give row first, then any fallback rows.
     */
    runGive: async function (trigger, server) {
        const give = trigger.give;
        const cake = trigger.cake || {};
        const fallback = async (rows = []) => rows.concat(await this.runCommands(trigger, server));
        if (!this.opsConfig().useOpsApi) return fallback();

        // By Pterodactyl id, never the tag: two instances can share a tag.
        const serverRef = server.serverId;
        let linked = false;
        try {
            linked = Boolean(serverRef) && Boolean(await yggdrasil.getLinkSession(serverRef));
        } catch (err) {
            linked = false;
        }
        if (!linked) return fallback();

        // The mod tries the uuid first and the name after it.
        const target = cake.uuid ? { uuid: cake.uuid, name: trigger.playerId } : { name: trigger.playerId };
        let created;
        try {
            ({ op: created } = await yggdrasil.createOp(serverRef, {
                type: 'give_item',
                params: { id: give.item, count: give.count, overflow: 'fail' },
                target,
                expiresInMs: OP_EXPIRES_MS,
                execTimeoutMs: GIVE_EXEC_TIMEOUT_MS,
                idempotencyKey: `cakebank:${trigger._id}`
            }));
        } catch (err) {
            sessionLogger.warn('PlayerEventScheduler', `give_item for ${trigger.playerId} on ${server.tag} could not be queued (${err.message}), using the console`);
            return fallback();
        }

        const opId = created._id;
        const base = { via: 'link', op: 'give_item', opId, requested: give.count };
        const stopAt = [...yggdrasil.TERMINAL_OP_STATES, 'waiting_player'];
        let doc = stopAt.includes(created.state) ? created : null;
        if (!doc) {
            try {
                doc = await yggdrasil.waitOp(opId, GIVE_WAIT_MS, stopAt);
            } catch (err) {
                doc = null;
            }
        }

        // The mod found no such player and gave nothing. The op waits for a login, so it
        // is cancelled first. A dispatch between the two reads could still run it. No
        // console run follows: the player left, a console give cannot reach them either,
        // and a blind console row would read as delivered. The proxy refunds the lot.
        if (doc && doc.state === 'waiting_player') {
            const cancelled = await this.tryCancel(opId);
            if (cancelled && cancelled.attempts === doc.attempts) {
                sessionLogger.info('PlayerEventScheduler', `give_item ${opId}: ${trigger.playerId} is not on ${server.tag}, nothing given`);
                return [{ ...base, state: 'cancelled', given: 0, offline: true }];
            }
            doc = cancelled || await this.tryGetOp(opId);
        } else if (!doc) {
            doc = await this.tryCancel(opId) || await this.tryGetOp(opId);
        }

        const state = doc ? doc.state : null;
        if (state === 'completed') {
            const data = (doc.result && doc.result.data) || {};
            if (typeof data.given === 'number' && Number.isFinite(data.given)) {
                sessionLogger.info('PlayerEventScheduler', `give_item ${opId}: ${data.given} of ${give.count} ${give.item} to ${trigger.playerId} on ${server.tag}`);
                return [{ ...base, state: 'completed', given: data.given, full: Boolean(data.full) }];
            }
        } else if (state === 'failed') {
            const error = String((doc.result && doc.result.error) || '');
            sessionLogger.warn('PlayerEventScheduler', `give_item ${opId} failed (${error}), using the console`);
            return fallback([{ ...base, state: 'failed', given: 0, error }]);
        } else if ((state === 'expired' || state === 'cancelled') && doc.attempts === 0) {
            sessionLogger.info('PlayerEventScheduler', `give_item ${opId} ${state} before it was sent, using the console`);
            return fallback([{ ...base, state, given: 0, dispatched: false }]);
        }

        sessionLogger.warn('PlayerEventScheduler', `give_item ${opId} for ${trigger.playerId} on ${server.tag} was sent and has no count to read (${state || 'no state'}). No console fallback.`);
        return [{ ...base, state: 'unknown' }];
    },

    /**
     * The result row for a `run_command` op, or null when it provably never ran: it expired
     * or was cancelled with no dispatch. An op that was sent and has no answer is `unknown`,
     * and nothing runs the line again.
     */
    commandRow: function (command, doc) {
        const state = doc ? doc.state : null;
        if ((state === 'expired' || state === 'cancelled') && doc.attempts === 0) return null;
        if (state === 'completed' || state === 'failed') {
            const output = doc.result?.data?.output ?? doc.result?.error ?? '';
            return { command, via: 'link', state, output: String(output) };
        }
        return { command, via: 'link', state: 'unknown', output: '', ...(doc && doc._id ? { opId: doc._id } : {}) };
    },

    /** The cancelled op, or null when the cancel was refused or did not reach Yggdrasil. */
    tryCancel: async function (opId) {
        try {
            return (await yggdrasil.cancelOp(opId)) || null;
        } catch (err) {
            return null;
        }
    },

    /** The op as Yggdrasil holds it now, or null. */
    tryGetOp: async function (opId) {
        try {
            return (await yggdrasil.getOp(opId)) || null;
        } catch (err) {
            return null;
        }
    },

    /**
     * Post a result embed to the channel the trigger was created in (best-effort — jobs made
     * before phase 9 have no discord context, and an embed failure must never block oneTime
     * deactivation).
     */
    reportResults: async function (trigger, server, results) {
        if (!trigger.discord?.channelId) return;
        if (!results.some(r => r.via === 'link')) return; // classic path stays silent, as it always was
        try {
            const { getClient } = require('../discord/bot');
            const client = await getClient();
            const channel = await client.channels.fetch(trigger.discord.channelId);
            // field NAME caps at 256 chars — 200 leaves room for the backticks + status suffix
            const fields = results.slice(0, 25).map(r => ({
                name: `\`${String(r.command ?? `${r.op} ${r.opId ?? ''}`).slice(0, 200)}\` — ${r.via === 'link' ? `🔗 ${r.state}` : '📟 sent (console)'}`,
                value: r.op === 'give_item'
                    ? (r.state === 'completed' ? `given ${r.given} of ${r.requested}` : (r.error || `requested ${r.requested}`))
                    : (r.output ? `\`\`\`\n${r.output.slice(0, 1000)}\n\`\`\`` : '*no output*')
            }));
            await channel.send({
                embeds: [{
                    title: `Player trigger fired: ${trigger.playerId} on ${server.tag}`,
                    color: results.some(r => r.state === 'failed' || r.state === 'unknown') ? 0xe67e22 : 0x2ecc71,
                    fields,
                    timestamp: new Date().toISOString()
                }]
            });
        } catch (error) {
            sessionLogger.warn('PlayerEventScheduler', 'Result report failed (non-fatal):', error.message);
        }
    }
};

module.exports.findServer = findServer;
module.exports.sameServer = sameServer;
