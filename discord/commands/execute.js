/*
 * File: execute.js
 * Project: valhalla-updater
 * File Created: Friday, 24th May 2024 4:40:44 pm
 * Author: flaasz
 * -----
 * Last Modified: Saturday, 15th June 2024 3:51:33 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const {
    pterosocket
} = require('pterosocket');
const {
    SlashCommandBuilder,
    AttachmentBuilder
} = require('discord.js');
const sessionLogger = require('../../modules/sessionLogger');
const yggdrasil = require('../../modules/yggdrasil');
const serverTargets = require('../../modules/serverTargets');
const {
    sendCommand
} = require('../../modules/pterodactyl');
const {
    velocityID
} = require("../../config/config.json").pterodactyl;
const pterodactylHostName = require("../../config/config.json").pterodactyl.pterodactylHostName.replace(/\/$/, "");
require('dotenv').config();

// Same limits as the player-event scheduler's run_command path.
const OP_EXPIRES_MS = 60000;
const COMMAND_WAIT_MS = 15000;

/**
 * Run one command over the link.
 * Returns null when the op provably never reached the backend, so the console may run it.
 * Otherwise returns the text to show. The command ran, or it may still run,
 * and the console must not run it a second time.
 */
async function runViaLink(serverId, command) {
    let doc = null;
    let opId = null;
    try {
        // The expiry matters: a queued op must not run later, after the console has run the same line.
        doc = await yggdrasil.runOp(serverId, {
            type: 'run_command',
            params: { command },
            expiresInMs: OP_EXPIRES_MS
        }, COMMAND_WAIT_MS);
    } catch (err) {
        if (!err || !err.opId) throw err; // the op was never created: the caller uses the console
        opId = err.opId;
        // Queued with no answer yet: cancel it before anything else runs the line.
        doc = await yggdrasil.cancelOp(opId).catch(() => null) || await yggdrasil.getOp(opId).catch(() => null);
    }
    const state = doc ? doc.state : null;
    if ((state === 'expired' || state === 'cancelled') && doc.attempts === 0) return null;
    if (state === 'completed') {
        const output = doc.result && doc.result.data ? doc.result.data.output : '';
        return typeof output === 'string' && output !== '' ? output : '(no output)';
    }
    if (state === 'failed') return `Command failed: ${(doc.result && doc.result.error) || 'unknown error'}`;
    return `No answer from the server yet (op ${(doc && doc._id) || opId}). It may still run, so check it before you send it again.`;
}

// Cache for server list with a 5-minute TTL
let serverListCache = {
    data: null,
    timestamp: 0,
    ttl: 5 * 60 * 1000 // 5 minutes in milliseconds
};

/**
 * Gets the server list, using cache if available and not expired
 * @returns {Promise<Array>} Array of server objects
 */
async function getCachedServers() {
    const now = Date.now();
    
    // If cache is valid, return cached data
    if (serverListCache.data && (now - serverListCache.timestamp) < serverListCache.ttl) {
        return serverListCache.data;
    }
    
    // Otherwise, fetch fresh data and update cache
    const servers = await yggdrasil.getServers();
    serverListCache.data = servers;
    serverListCache.timestamp = now;
    
    return servers;
}

const TIMED_OUT = 'Command execution timed out';

/**
 * Runs one command on one instance: over the link when it is linked, else on the console.
 * Never throws.
 * @param {object} server The instance.
 * @param {string} command Console line.
 * @param {object} deps Injectable for tests: getLinkSession, runViaLink, sendAdvancedCommand, consoleTimeoutMs.
 * @returns {Promise<{server: object, via: string, output: string, error: string|null, timedOut: boolean}>}
 */
async function runOnInstance(server, command, deps = {}) {
    const getLinkSession = deps.getLinkSession || (id => yggdrasil.getLinkSession(id));
    const viaLink = deps.runViaLink || runViaLink;
    const viaConsole = deps.sendAdvancedCommand || sendAdvancedCommand;
    const consoleTimeoutMs = deps.consoleTimeoutMs != null ? deps.consoleTimeoutMs : 15000;

    // via-link path (biforesting v2): durable op with real captured output.
    // Falls back to the pterosocket console scrape when not linked / op fails.
    try {
        const session = await getLinkSession(server.serverId);
        if (session) {
            const output = await viaLink(server.serverId, command);
            if (output !== null) return { server, via: 'link', output, error: null, timedOut: false };
            sessionLogger.warn('Execute', `Link op never reached ${server.name}, falling back to console`);
        }
    } catch (linkErr) {
        sessionLogger.warn('Execute', `Link path failed on ${server.name} (${linkErr.message}), falling back to console`);
    }

    let timer = null;
    try {
        const output = await Promise.race([
            viaConsole(server.serverId, command),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(TIMED_OUT)), consoleTimeoutMs);
            })
        ]);
        return { server, via: 'console', output: output || '', error: null, timedOut: false };
    } catch (error) {
        if (error.message === TIMED_OUT) return { server, via: 'console', output: '', error: null, timedOut: true };
        sessionLogger.error('Execute', `Error executing command on ${server.name}:`, error);
        return { server, via: 'console', output: '', error: error.message, timedOut: false };
    } finally {
        clearTimeout(timer);
    }
}

/** The text for one instance's result, without its output. */
function resultStatus(result) {
    if (result.error) return `❌ **Error executing command:** ${result.error}`;
    if (result.timedOut) return "⚠️ **Command is taking longer than expected to complete.** The command was sent, but we couldn't wait for the full response.";
    if (!result.output) return '**The server did not respond!**';
    return null;
}

/**
 * The reply for one or more instances. Each instance gets its own section.
 * @param {string} command The console line.
 * @param {Array} results From runOnInstance, one per instance.
 * @param {number} limit Longest reply before the outputs go into an attachment.
 * @returns {{content: string, attachment: string|null}}
 */
function formatReport(command, results, limit = 1900) {
    if (results.length === 1) {
        const [result] = results;
        const verb = result.error ? 'Attempted to send' : 'Sent';
        const head = result.via === 'link'
            ? `${verb} \`${command}\` to **${result.server.name}** via link... 🔗`
            : `${verb} \`${command}\` to **${result.server.name}**... 🚀`;
        const status = resultStatus(result);
        if (status) return { content: `${head}\n${status}`, attachment: null };
        if (result.output.length < limit) return { content: `${head}\n\`\`\`${result.output}\`\`\``, attachment: null };
        return { content: `${head}\n*Response is too long, sending as attachment...*`, attachment: result.output };
    }

    const tags = [...new Set(results.map(r => r.server.tag).filter(Boolean))];
    const where = tags.length === 1 ? ` of \`${tags[0]}\`` : '';
    const head = `Sent \`${command}\` to **${results.length} instances**${where} 🚀`;
    const label = r => `**${r.server.name}** (\`${r.server.serverId}\`)${r.via === 'link' ? ' 🔗' : ''}`;

    const full = results.map(r => `\n${label(r)}\n${resultStatus(r) || `\`\`\`${r.output}\`\`\``}`).join('');
    if (head.length + full.length <= limit) return { content: head + full, attachment: null };

    const short = results.map(r => `\n${label(r)}: ${resultStatus(r) || '*output in the attachment*'}`).join('');
    const attachment = results
        .map(r => `=== ${r.server.name} (${r.server.serverId}) ===\n${r.output || resultStatus(r) || ''}`)
        .join('\n\n');
    return { content: `${head}${short}`.slice(0, 2000), attachment };
}

module.exports = {
    runViaLink,
    runOnInstance,
    formatReport,
    data: new SlashCommandBuilder()
        .setName('execute')
        .setDescription('Execute a command on the server!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(option =>
            option.setName('server')
            .setDescription('A tag runs on every instance. Pick one instance to run on it alone.')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(option =>
            option.setName('command')
            .setDescription('Command to execute')
            .setRequired(true))
        .setDMPermission(false),
    async autocomplete(interaction) {
        const serverList = await getCachedServers();
        await interaction.respond(serverTargets.autocompleteChoices(serverList, interaction.options.getFocused(), ['all', 'Bifrost']));
    },

    /**
     * @param {object} interaction The slash command.
     * @param {object} deps Injectable for tests: servers (the server list), run (runOnInstance).
     */
    async execute(interaction, deps = {}) {
        const query = interaction.options.getString('server');
        const command = interaction.options.getString('command');

        const serverList = deps.servers || await getCachedServers();
        if (query === 'all') {
            for (const server of serverList) {
                sendCommand(server.serverId, command);
                //console.log(`Sent command to ${server.name}`);
            }
            await interaction.reply(`Sent \`${command}\` to **all** servers! 🚀`);
            return;
        } else if (query === 'Bifrost') {
            sendCommand(velocityID, command);
            await interaction.reply(`Sent \`${command}\` to **Bifrost**! 🚀`);

        } else {
            // A tag names every instance of the pack. An id or an instance name names one.
            const { servers: targets, error } = serverTargets.resolveTargets(serverList, query);
            if (targets.length === 0) {
                await interaction.reply(error || 'Server not found! Please try again with a valid server name.');
                return;
            }

            try {
                // Defer the reply to give more time for processing
                await interaction.deferReply();

                const run = deps.run || runOnInstance;
                const results = await Promise.all(targets.map(server => run(server, command)));
                const report = formatReport(command, results);
                await interaction.editReply(report.content);
                if (report.attachment !== null) {
                    const attachment = new AttachmentBuilder(Buffer.from(report.attachment, 'utf-8'), {
                        name: 'command_response.txt'
                    });
                    await interaction.followUp({
                        files: [attachment]
                    });
                }
            } catch (error) {
                // Handle interaction errors
                sessionLogger.error('Execute', 'Discord interaction error:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply(`❌ **Error:** ${error.message}`);
                } else {
                    await interaction.editReply(`❌ **Error:** ${error.message}`);
                }
            }
        }
    }
};

/**
 * Sends a command to a server using the Pterodactyl socket, and returns the response.
 * @param {string} serverId Id of the server on Pterodactyl.
 * @param {string} command Command to be executed on the server.
 * @returns {string} Response from the server.
 */
async function sendAdvancedCommand(serverId, command) {
    let response = "";
    let lastOutputTime = 0;
    let outputReceived = false;
    
    // Determine timeout based on command complexity
    // Simple commands get shorter timeouts, complex ones get longer
    const getCommandTimeout = (cmd) => {
        // Default timeout: 3000ms
        let timeout = 3000;
        
        // Adjust timeout based on command type
        if (cmd.includes('help') || cmd.includes('list')) {
            return 2000; // Simple informational commands
        } else if (cmd.includes('save-all') || cmd.includes('reload')) {
            return 5000; // Commands that might take longer
        } else if (cmd.includes('backup') || cmd.includes('generate')) {
            return 10000; // Commands that likely take much longer
        }
        
        return timeout;
    };
    
    // Calculate initial timeout based on command
    const initialTimeout = getCommandTimeout(command);
    
    return new Promise((resolve, reject) => {
        const socket = new pterosocket(pterodactylHostName, process.env.PTERODACTYL_APIKEY, serverId);
        let responseTimer = null;
        let maxWaitTimer = null;
        
        // Function to close socket and clean up
        const cleanupAndResolve = () => {
            if (responseTimer) clearTimeout(responseTimer);
            if (maxWaitTimer) clearTimeout(maxWaitTimer);
            
            try {
                socket.close();
            } catch (err) {
                // Socket might already be closed
                sessionLogger.debug('Execute', 'Error closing socket (might already be closed):', err);
            }
            
            resolve(response);
        };
        
        socket.once("start", async () => {
            try {
                await sendCommand(serverId, command);
                lastOutputTime = Date.now();
                
                // Set a dynamic timeout that resets whenever we receive output
                responseTimer = setTimeout(() => {
                    // If we've received output and haven't received any for 1.5 seconds, we're probably done
                    if (outputReceived && Date.now() - lastOutputTime > 1500) {
                        cleanupAndResolve();
                    } else {
                        // Otherwise, wait for the initial timeout
                        setTimeout(cleanupAndResolve, initialTimeout);
                    }
                }, 1500);
                
                // Set a maximum wait time to prevent hanging
                maxWaitTimer = setTimeout(cleanupAndResolve, Math.max(initialTimeout, 10000));
            } catch (error) {
                sessionLogger.error('Execute', 'Error sending command:', error);
                cleanupAndResolve();
            }
        });

        socket.on('console_output', (output) => {
            outputReceived = true;
            lastOutputTime = Date.now();
            
            output = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
            
            const headerRegex = /\[\d\d:\d\d:\d\d\] \[Server thread\/INFO] \[minecraft\/MinecraftServer\]: |\[\d\d:\d\d:\d\d\] \[Server thread\/INFO]: |\[\d\d:\d\d:\d\d\] \[Server thread\/INFO] \[minecraft\/DedicatedServer\]: /gm;

            if (headerRegex.test(output) || output === command) {
                if (output != command) {
                    output = output.replace(headerRegex, "");
                    response += output + "\n";
                }
            }
            
            // Reset the response timer whenever we get output
            if (responseTimer) {
                clearTimeout(responseTimer);
                responseTimer = setTimeout(() => {
                    // If no new output for 1.5 seconds, we're probably done
                    if (Date.now() - lastOutputTime > 1500) {
                        cleanupAndResolve();
                    }
                }, 1500);
            }
        });

        socket.once('close', () => {
            cleanupAndResolve();
        });

        socket.once('error', (error) => {
            sessionLogger.error('Execute', 'Socket error:', error);
            cleanupAndResolve(); // Still resolve with whatever response we have
        });
    });
}
