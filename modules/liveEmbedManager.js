const { EmbedBuilder } = require('discord.js');
const crypto = require('crypto');
const mongo = require('./mongo');
const yggdrasil = require('./yggdrasil');
const sessionLogger = require('./sessionLogger');


let discordClient = null;
let debounceTimer = null;
const DEBOUNCE_MS = 2000;

/**
 * Initializes the live embed manager.
 * Subscribes to Yggdrasil WebSocket events to trigger embed updates.
 */
async function init() {
    const { getClient } = require('../discord/bot');
    discordClient = await getClient();

    const events = [
        'server.state.changed',
        'player.list.updated',
        'server.crashed',
        'server.recovered',
        'server.crash-loop.started',
        'server.crash-loop.ended'
    ];

    for (const event of events) {
        yggdrasil.on(event, () => {
            scheduleUpdate();
        });
    }

    sessionLogger.info('LiveEmbedManager', 'Initialized and listening for Yggdrasil events');
}

/**
 * Debounced update scheduler — avoids flooding Discord API when multiple events fire at once.
 */
function scheduleUpdate() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        updateAllEmbeds();
    }, DEBOUNCE_MS);
}

/**
 * Updates all live embeds with current server data.
 */
async function updateAllEmbeds() {
    try {
        const liveEmbeds = await mongo.getLiveEmbeds();
        if (liveEmbeds.length === 0) return;

        const servers = await yggdrasil.getServers();
        const currentHash = generateServerStateHash(servers);

        const needsUpdate = liveEmbeds.some(embed => embed.lastHash !== currentHash);
        if (!needsUpdate) return;

        sessionLogger.info('LiveEmbedManager', 'Server status changes detected, updating live embeds...');

        for (const embedData of liveEmbeds) {
            if (embedData.lastHash !== currentHash) {
                await updateSingleEmbed(embedData, servers, currentHash);
            }
        }
    } catch (error) {
        sessionLogger.error('LiveEmbedManager', 'Error updating embeds:', error.message);
    }
}

/**
 * Updates a single live embed Discord message.
 */
async function updateSingleEmbed(embedData, servers, newHash) {
    try {
        const channel = await discordClient.channels.fetch(embedData.channelId);
        if (!channel) {
            sessionLogger.warn('LiveEmbedManager', `Channel ${embedData.channelId} not found, REMOVING embed ${embedData.messageId} from DB`);
            await mongo.removeLiveEmbed(embedData.messageId);
            return;
        }

        const message = await channel.messages.fetch(embedData.messageId);
        if (!message) {
            sessionLogger.warn('LiveEmbedManager', `Message ${embedData.messageId} not found, REMOVING from DB`);
            await mongo.removeLiveEmbed(embedData.messageId);
            return;
        }

        const updatedEmbed = generateServerEmbed(servers);
        await message.edit({ embeds: [updatedEmbed] });
        await mongo.updateLiveEmbedHash(embedData.messageId, newHash);

        sessionLogger.info('LiveEmbedManager', `Updated live embed ${embedData.messageId}`);
    } catch (error) {
        if (error.code === 10008 || error.code === 10003) {
            sessionLogger.warn('LiveEmbedManager', `Discord error code ${error.code} (message/channel not found), REMOVING embed ${embedData.messageId} from DB`);
            await mongo.removeLiveEmbed(embedData.messageId);
        } else if (error.code === 50013) {
            sessionLogger.warn('LiveEmbedManager', `Missing permissions (50013) to update embed ${embedData.messageId}`);
        } else {
            sessionLogger.error('LiveEmbedManager', `Error updating live embed ${embedData.messageId} (code=${error.code}):`, error.message);
        }
    }
}

/**
 * Registers a new live embed for automatic updates.
 */
async function registerEmbed(messageId, channelId, guildId, userId) {
    const servers = await yggdrasil.getServers();
    const hash = generateServerStateHash(servers);

    await mongo.storeLiveEmbed(messageId, channelId, guildId, userId, hash);
    sessionLogger.info('LiveEmbedManager', `Registered live embed ${messageId}`);
}

/**
 * Removes a live embed from tracking.
 */
async function removeEmbed(messageId) {
    await mongo.removeLiveEmbed(messageId);
    sessionLogger.info('LiveEmbedManager', `Removed live embed ${messageId}`);
}

/**
 * Generates the server status embed.
 * @param {Array} servers Array of server objects from Yggdrasil API.
 * @returns {EmbedBuilder} The generated embed.
 */
function generateServerEmbed(servers) {
    const embed = new EmbedBuilder()
        .setColor(0x9c59b6)
        .setTitle('Server List')
        .setTimestamp()
        .setFooter({
            text: "To see players online use /online"
        });

    let onlineCount = 0;
    let versionObj = {};
    const seen = new Set();

    for (let server of servers) {
        if (server.excludeFromServerList) continue;
        if (seen.has(server.tag)) continue;
        seen.add(server.tag);
        if (!versionObj[server.serverVersion]) versionObj[server.serverVersion] = [];
        versionObj[server.serverVersion].push(server);
    }

    const sortedVersions = Object.keys(versionObj).sort((a, b) => compareVersions(b, a));
    const excludedTags = ["BINGO", "ALP"];

    for (const key of sortedVersions) {
        let str = "";

        for (let s of versionObj[key]) {
            var statusEmoji = "<:c:1389899748370157609>";

            if (s.status === 'running') {
                onlineCount++;
                statusEmoji = "<:u:1389899745866027090>";
            }

            if (s.tag == "PLUS") statusEmoji = "";
            if (!excludedTags.includes(s.tag) && !s.earlyAccess) {
                str += `- **${s.tag.toUpperCase()} | ${s.name}** ${statusEmoji}\n ${s.tag.toLowerCase()}.valhallamc.io *(v.${s.modpackVersion})*\n`;
            }
        }

        if (str) {
            embed.addFields({
                name: `Minecraft ${key}`,
                value: str
            });
        }
    }

    embed.setDescription(`Servers online: ${onlineCount}\n*Last updated: <t:${Math.floor(Date.now() / 1000)}:R>*`);
    return embed;
}

/**
 * Generates a hash of the current server state for change detection.
 */
function generateServerStateHash(servers) {
    const stateData = servers.map(server => ({
        tag: server.tag,
        name: server.name,
        modpackVersion: server.modpackVersion,
        serverVersion: server.serverVersion,
        excludeFromServerList: server.excludeFromServerList,
        earlyAccess: server.earlyAccess,
        status: server.status
    }));

    return crypto.createHash('sha256').update(JSON.stringify(stateData)).digest('hex');
}

function compareVersions(a, b) {
    const versionA = a.split('.').map(Number);
    const versionB = b.split('.').map(Number);

    for (let i = 0; i < Math.max(versionA.length, versionB.length); i++) {
        if (versionA[i] === undefined) return -1;
        if (versionB[i] === undefined) return 1;
        if (versionA[i] < versionB[i]) return -1;
        if (versionA[i] > versionB[i]) return 1;
    }
    return 0;
}

module.exports = {
    init,
    registerEmbed,
    removeEmbed,
    generateServerEmbed,
    generateServerStateHash
};
