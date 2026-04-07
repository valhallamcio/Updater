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
const {
    sendCommand
} = require('../../modules/pterodactyl');
const {
    velocityID
} = require("../../config/config.json").pterodactyl;
const pterodactylHostName = require("../../config/config.json").pterodactyl.pterodactylHostName.replace(/\/$/, "");
require('dotenv').config();

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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('execute')
        .setDescription('Execute a command on the server!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(option =>
            option.setName('server')
            .setDescription('Name of the server to execute the command on')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(option =>
            option.setName('command')
            .setDescription('Command to execute')
            .setRequired(true))
        .setDMPermission(false),
    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const serverList = await getCachedServers();
        const choices = ["all", "Bifrost"]; // Include special options

        // Process server names to ensure they don't exceed Discord's 25-character limit
        for (const server of serverList) {
            // Trim any trailing spaces
            let serverName = server.name.trim();
            
            // If name is too long, truncate to stay under Discord's 25-character limit
            if (serverName.length > 20) {
                serverName = serverName.substring(0, 20) + "..."; // 20 + 3 = 23 chars (safely under 25)
            }
            
            choices.push(serverName);
        }

        // Filter choices to show matches as user types (more flexible than just startsWith)
        const filtered = choices.filter(choice => 
            choice.toLowerCase().includes(focusedValue.toLowerCase())
        );
        // Discord has a maximum of 25 autocomplete choices
        const limitedChoices = filtered.slice(0, 25);
        await interaction.respond(
            limitedChoices.map(choice => ({
                name: choice,
                value: choice
            })),
        );
    },

    async execute(interaction) {
        const query = interaction.options.getString('server');
        const command = interaction.options.getString('command');

        const serverList = await getCachedServers();
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
            // Handle truncated server names in the query
            // First try exact match, then try matching the beginning of the name
            let server = serverList.find(server =>
                server.name.trim() === query.trim() ||
                server.tag === query.toLowerCase()
            );
            
            // If not found and query ends with "...", try matching by prefix
            if (!server && query.endsWith('...')) {
                const prefix = query.substring(0, query.length - 3);
                server = serverList.find(server =>
                    server.name.startsWith(prefix) ||
                    (server.tag && server.tag.toLowerCase().startsWith(prefix.toLowerCase()))
                );
            }
            
            if (!server) {
                await interaction.reply('Server not found! Please try again with a valid server name.');
                return;
            }

            try {
                // Defer the reply to give more time for processing
                await interaction.deferReply();
                
                // Prepare initial message
                let reply = `Sending \`${command}\` to **${server.name}**... 🚀`;
                
                try {
                    // Execute the command with a timeout
                    const response = await Promise.race([
                        sendAdvancedCommand(server.serverId, command),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Command execution timed out')), 15000)
                        )
                    ]);
                    
                    // Update reply based on response
                    if (!response || response === "") {
                        await interaction.editReply(reply.replace('Sending', 'Sent') + "\n**The server did not respond!**");
                    } else if (response.length < 1900) {
                        await interaction.editReply(reply.replace('Sending', 'Sent') + "\n```" + response + "```");
                    } else {
                        await interaction.editReply(reply.replace('Sending', 'Sent') + "\n*Response is too long, sending as attachment...*");
                        const buffer = Buffer.from(response, 'utf-8');
                        const attachment = new AttachmentBuilder(buffer, {
                            name: 'command_response.txt'
                        });
                        await interaction.followUp({
                            files: [attachment]
                        });
                    }
                } catch (error) {
                    // Handle timeout or other errors
                    if (error.message === 'Command execution timed out') {
                        await interaction.editReply(reply.replace('Sending', 'Sent') +
                            "\n⚠️ **Command is taking longer than expected to complete.** The command was sent, but we couldn't wait for the full response.");
                    } else {
                        sessionLogger.error('Execute', `Error executing command on ${server.name}:`, error);
                        await interaction.editReply(reply.replace('Sending', 'Attempted to send') +
                            `\n❌ **Error executing command:** ${error.message}`);
                    }
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
