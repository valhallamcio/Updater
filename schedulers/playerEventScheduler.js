const yggdrasil = require("../modules/yggdrasil");
const mongo = require("../modules/mongo");
const pterodactyl = require("../modules/pterodactyl");
const functions = require("../modules/functions");
const sessionLogger = require("../modules/sessionLogger");

// Triggers currently executing (30s tick vs multi-second awaited ops overlap — a slow
// execution must not be fired twice by the next tick).
const inFlight = new Set();

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

            const results = await this.runCommands(trigger, server);
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
        let viaOps = false;
        if (this.opsConfig().useOpsApi) {
            try {
                viaOps = !!(await yggdrasil.getLinkSession(server.tag));
            } catch (err) {
                viaOps = false;
            }
        }

        for (let i = 0; i < trigger.commands.length; i++) {
            const command = trigger.commands[i];
            if (viaOps) {
                try {
                    const doc = await yggdrasil.runOp(server.tag, {
                        type: 'run_command',
                        params: { command }
                    }, 15000);
                    const output = doc.result?.data?.output ?? doc.result?.error ?? '';
                    sessionLogger.info('PlayerEventScheduler', `Player trigger (op ${doc.state}): '${command}' for ${trigger.playerId} on ${server.tag}`);
                    results.push({ command, via: 'link', state: doc.state, output: String(output) });
                    continue; // op failed = command RAN and errored — report only, no ptero re-run
                } catch (err) {
                    // transport failure — this command did NOT run; fall back for it + the rest
                    sessionLogger.warn('PlayerEventScheduler', `Ops path failed (${err.message}) — falling back to Pterodactyl for the remaining commands`);
                    viaOps = false;
                }
            }
            sessionLogger.info('PlayerEventScheduler', `Player trigger: '${command}' executed for ${trigger.playerId} on ${server.tag}`);
            await pterodactyl.sendCommand(server.serverId, command);
            await functions.sleep(1000); // 1 second delay between commands
            results.push({ command, via: 'pterodactyl', state: 'sent', output: '' });
        }
        return results;
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
                name: `\`${r.command.slice(0, 200)}\` — ${r.via === 'link' ? `🔗 ${r.state}` : '📟 sent (console)'}`,
                value: r.output ? `\`\`\`\n${r.output.slice(0, 1000)}\n\`\`\`` : '*no output*'
            }));
            await channel.send({
                embeds: [{
                    title: `Player trigger fired: ${trigger.playerId} on ${server.tag}`,
                    color: results.some(r => r.state === 'failed') ? 0xe67e22 : 0x2ecc71,
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
