const yggdrasil = require("../modules/yggdrasil");
const mongo = require("../modules/mongo");
const pterodactyl = require("../modules/pterodactyl");
const functions = require("../modules/functions");
const sessionLogger = require("../modules/sessionLogger");

module.exports = {
    name: 'playerEventScheduler',
    defaultConfig: {
        "active": true,
        "interval": 30 // Check every 30 seconds for responsive player events
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
            
            for (const trigger of activeTriggers) {
                const { playerId, serverNames, commands, onJoin, lastSeenServers = [] } = trigger;
                
                // Track current servers where player is online
                const currentServers = [];
                for (const serverName of serverNames) {
                    if (playersData[serverName] && playersData[serverName].includes(playerId)) {
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
        try {
            const servers = await yggdrasil.getServers();
            const server = servers.find(s => s.tag === serverName || s.name.trim() === serverName.trim());
            
            if (!server) return;
            
            // Execute each command
            for (const command of trigger.commands) {
                sessionLogger.info('PlayerEventScheduler', `Player trigger: '${command}' executed for ${trigger.playerId} on ${server.tag}`);
                await pterodactyl.sendCommand(server.serverId, command);
                await functions.sleep(1000); // 1 second delay between commands
            }
            
            // Mark trigger as executed (if it's one-time)
            if (trigger.oneTime) {
                await mongo.deactivateScheduleJob(trigger._id);
            }
            
        } catch (error) {
            sessionLogger.error('PlayerEventScheduler', 'Error executing player trigger:', error.message);
        }
    }
};