/*
 * File: bot.js
 * Project: valhalla-updater
 * File Created: Friday, 17th May 2024 12:02:23 am
 * Author: flaasz
 * -----
 * Last Modified: Wednesday, 29th May 2024 1:09:25 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const {
    Client,
    GatewayIntentBits
} = require('discord.js');
const commands = require('./commands');
const events = require('./events');
const sessionLogger = require('../modules/sessionLogger');

require('dotenv').config();

const token = process.env.DISCORD_TOKEN;

const client = new Client({
    // GuildVoiceStates is what the voiceChannels scheduler reconciles on - without
    // it the member count of a voice channel is always zero.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

module.exports = {
    launchBot: async function () {
        const maxRetries = 5;
        const baseDelay = 5000; // 5 seconds
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                sessionLogger.info('DiscordBot', `Initializing Discord bot... (Attempt ${attempt}/${maxRetries})`);
                
                commands.loadCommandFiles(client);
                sessionLogger.info('DiscordBot', 'Command files loaded');
                
                events.loadEventFiles(client);
                sessionLogger.info('DiscordBot', 'Event files loaded');

                sessionLogger.info('DiscordBot', 'Connecting to Discord...');
                await client.login(token);
                sessionLogger.info('DiscordBot', 'Successfully connected to Discord');
                return; // Success - exit retry loop
                
            } catch (error) {
                const isServiceUnavailable = error.message.includes('Service Unavailable') || 
                                           error.code === 50035 || 
                                           error.status === 503;
                
                if (isServiceUnavailable && attempt < maxRetries) {
                    const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
                    sessionLogger.warn('DiscordBot', `Discord API unavailable (attempt ${attempt}/${maxRetries}). Retrying in ${delay/1000}s...`);
                    
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                } else {
                    sessionLogger.error('DiscordBot', `Failed to launch bot after ${attempt} attempts:`, error.message);
                    
                    if (attempt === maxRetries) {
                        sessionLogger.error('DiscordBot', 'Max retries exceeded. Bot will continue without Discord connection.');
                        // Don't throw - let the application continue running
                        return;
                    }
                    throw error;
                }
            }
        }
    },

    getClient: function () {
        return new Promise((resolve) => {
            if (client.isReady()) {
                resolve(client);
            } else {
                client.once('ready', () => {
                    resolve(client);
                });
            }
        });
    },
};