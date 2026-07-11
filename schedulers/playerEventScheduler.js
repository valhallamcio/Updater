const yggdrasil = require("../modules/yggdrasil");
const mongo = require("../modules/mongo");
const pterodactyl = require("../modules/pterodactyl");
const functions = require("../modules/functions");
const sessionLogger = require("../modules/sessionLogger");

// Triggers currently executing (30s tick vs multi-second awaited ops overlap — a slow
// execution must not be fired twice by the next tick).
const inFlight = new Set();

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
            // full server NAMES (e.g. "GT New Horizons") — so a direct
            // playersData[serverName] lookup is always undefined and the player is
            // never seen as online. Resolve each stored identifier (name or tag)
            // back to its tag before looking it up.
            const servers = await yggdrasil.getServers();
            const resolveTag = (id) => {
                const needle = String(id).trim().toLowerCase();
                const match = servers.find(s =>
                    s.tag.toLowerCase() === needle ||
                    s.name.trim().toLowerCase() === needle
                );
                return match ? match.tag : id;
            };

            for (const trigger of activeTriggers) {
                const { playerId, serverNames, commands, onJoin, lastSeenServers = [] } = trigger;

                // Track current servers (by their stored identifier) where the player is online.
                const currentServers = [];
                for (const serverName of serverNames) {
                    const online = playersData[resolveTag(serverName)];
                    if (online && online.some(u => u.toLowerCase() === String(playerId).toLowerCase())) {
                        currentServers.push(serverName);
                    }
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
            const server = servers.find(s => s.tag === serverName || s.name.trim() === serverName.trim());

            if (!server) return;

            const results = await this.runCommands(trigger, server);
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
            const fields = results.slice(0, 25).map(r => ({
                name: `\`${r.command.slice(0, 250)}\` — ${r.via === 'link' ? `🔗 ${r.state}` : '📟 sent (console)'}`,
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