/*
 * File: wrapped.js
 * Project: valhalla-updater
 * File Created: Sunday, 22nd December 2024
 * Author: Valhalla Team
 * -----
 * ValhallaMC Wrapped - Your personal Minecraft journey summary
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const mongo = require('../../modules/mongo');
const { mongoBase64ToUuid, normalizeUuid } = require('../../modules/uuidUtils');
const { aggregatePlayerStats } = require('../../modules/wrappedStatsAggregator');
const { generateWrappedEmbeds } = require('../../modules/wrappedGenerator');
const linkFlow = require('./util/linkFlow');

// Rate limiting
const cooldowns = new Map();
const COOLDOWN_MS = 60 * 1000; // 1 minute cooldown

/**
 * Extracts UUID from MongoDB player document.
 * @param {object} player - Player document from MongoDB
 * @returns {string|null} Dashed UUID or null
 */
function extractPlayerUuid(player) {
    if (!player || !player.uuid) return null;
    
    try {
        // MongoDB stores UUID as Binary with subtype 03
        if (player.uuid.buffer) {
            // It's a Binary object
            const base64 = player.uuid.buffer.toString('base64');
            return mongoBase64ToUuid(base64);
        } else if (typeof player.uuid === 'string') {
            return normalizeUuid(player.uuid);
        }
    } catch (error) {
        console.error('Error extracting UUID:', error);
    }
    
    return null;
}

/**
 * The account a Discord's Wrapped is about. The link lives on bifrost.players, where
 * the proxy's discord-link and Fenrir's /link write it. With several accounts the first
 * one linked wins, which is the main account for nearly everyone.
 * @param {string} discordId Discord snowflake.
 * @returns {Promise<object|null>} `{uuid, username}` or null when nothing is linked.
 */
async function findLinkedAccount(discordId) {
    const linked = await mongo.findBifrostPlayersByDiscordId(discordId);
    if (!linked || linked.length === 0) return null;
    const when = (p) => (p.discord_linked_at ? new Date(p.discord_linked_at).getTime() : Infinity);
    return [...linked].sort((a, b) => when(a) - when(b))[0];
}

/**
 * The reply for a Discord with no linked account: where to link, and the button.
 * @returns {object} `{embeds, components}` for editReply.
 */
function notLinkedReply() {
    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('Discord Account Not Linked')
        .setDescription(
            `Your Discord account is not linked to a Minecraft account on ValhallaMC.\n\n` +
            `**To link your account:**\n` +
            `1. Join the server and type \`/link\` in game. You get a short code.\n` +
            `2. Open <#${linkFlow.linkChannelId()}> and press **Link account**, or use the button below.\n` +
            `3. Type the code.\n\n` +
            `Once linked, come back and use \`/wrapped\` again!`
        );
    return { embeds: [embed], components: [linkFlow.buildOpenRow()] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wrapped')
        .setDescription('Get your personal ValhallaMC Wrapped - Your Minecraft journey summary!')
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Look up any player by Minecraft username')
                .setRequired(false)
        )
        .setDMPermission(false),
    
    async execute(interaction) {
        const userId = interaction.user.id;
        const targetUsername = interaction.options.getString('username');
        
        // Check cooldown
        if (!targetUsername) {
            const lastUsed = cooldowns.get(userId) || 0;
            const remaining = COOLDOWN_MS - (Date.now() - lastUsed);
            
            if (remaining > 0) {
                return interaction.reply({
                    content: `Please wait **${Math.ceil(remaining / 1000)} seconds** before using this command again.`,
                    ephemeral: false
                });
            }
            
            // Set cooldown
            cooldowns.set(userId, Date.now());
        }
        
        // Defer reply as this will take time
        await interaction.deferReply({ ephemeral: false });
        
        try {
            let player;
            let uuid;
            let username;
            let isLookup = false;
            
            if (targetUsername) {
                // Username lookup mode - find player by username
                isLookup = true;
                console.log(`[Wrapped] ${interaction.user.tag} looking up: ${targetUsername}`);
                
                player = await mongo.getPlayerByUsername(targetUsername);
                
                if (!player) {
                    return interaction.editReply({
                        content: `Could not find a player named **${targetUsername}** in the database.`,
                    });
                }
                
                uuid = extractPlayerUuid(player);
                username = player.username || targetUsername;
                
            } else {
                // Normal mode - the Discord link the proxy and /link keep on bifrost.players
                player = await findLinkedAccount(userId);
                
                if (!player) {
                    return interaction.editReply(notLinkedReply());
                }
                
                uuid = extractPlayerUuid(player);
                username = player.username || 'Unknown Player';
            }
            
            if (!uuid) {
                return interaction.editReply({
                    content: 'Could not retrieve Minecraft UUID. Please contact staff for help.',
                });
            }
            
            // Show processing message
            await interaction.editReply({
                content: `Generating Wrapped for **${username}**...\n*Scanning across all servers, this may take a moment!*`,
            });
            
            // Aggregate statistics
            const stats = await aggregatePlayerStats(uuid);
            
            // Generate embeds (now 1-2 max)
            const embeds = generateWrappedEmbeds(stats, username);
            
            // If username lookup, show directly in channel (public)
            if (isLookup) {
                // Add a header note for username lookups
                const headerEmbed = new EmbedBuilder()
                    .setColor(0x9B59B6)
                    .setDescription(
                        `**${username}'s ValhallaMC Wrapped**\n` +
                        `UUID: \`${uuid}\`\n` +
                        `Servers with data: ${stats.totals.servers_played}\n` +
                        `*Requested by ${interaction.user.username}*`
                    );
                
                return interaction.editReply({
                    content: null,
                    embeds: [headerEmbed, ...embeds]
                });
            }
            
            // Normal user - send via DM
            try {
                const dmChannel = await interaction.user.createDM();
                
                // Build privacy header into first embed description
                const privacyNote = `Hey **${interaction.user.username}**! Here's your personal Wrapped for **${username}**!\n` +
                    `Data collected until December 22, 2025 | Servers scanned: ${stats.totals.servers_played}\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                
                // Prepend privacy note to first embed
                if (embeds.length > 0) {
                    const firstEmbed = embeds[0];
                    const originalDesc = firstEmbed.data.description || '';
                    firstEmbed.setDescription(privacyNote + originalDesc);
                }
                
                // Send all embeds in a single message (max 10 embeds per message, we have 1-2)
                await dmChannel.send({ embeds: embeds });
                
                // Update the original reply
                await interaction.editReply({
                    content: `Your Wrapped has been sent to your DMs! Check your messages.`,
                });
                
            } catch (dmError) {
                // DMs are likely disabled
                console.error('Could not send DM:', dmError.message);
                
                // Show preview in ephemeral reply
                const fallbackEmbed = new EmbedBuilder()
                    .setColor(0x9B59B6)
                    .setTitle('Could Not Send DM')
                    .setDescription(
                        `I couldn't send your Wrapped via DM.\n\n` +
                        `**Please enable DMs from server members:**\n` +
                        `1. Right-click on the server icon\n` +
                        `2. Go to Privacy Settings\n` +
                        `3. Enable "Direct Messages"\n\n` +
                        `Then try \`/wrapped\` again!\n\n` +
                        `**Quick Preview:**\n` +
                        `Playtime: ${Math.floor(stats.totals.play_time_ticks / 20 / 3600)} hours\n` +
                        `Servers: ${stats.totals.servers_played}\n` +
                        `Deaths: ${stats.totals.deaths.toLocaleString()}\n` +
                        `Mob Kills: ${stats.totals.mob_kills.toLocaleString()}\n` +
                        `Blocks Mined: ${stats.totals.blocks_mined.toLocaleString()}\n` +
                        `Quests: ${stats.totals.quests_completed.toLocaleString()} completed`
                    )
                    .setThumbnail(`https://mc-heads.net/avatar/${username}/128`)
                    .setFooter({ text: 'Enable DMs for the full experience!' });
                
                await interaction.editReply({
                    content: null,
                    embeds: [fallbackEmbed]
                });
            }
            
        } catch (error) {
            console.error('Wrapped command error:', error);
            
            await interaction.editReply({
                content: `An error occurred while generating your Wrapped. Please try again later.\n*Error: ${error.message}*`,
            });
        }
    },

    _internals: { findLinkedAccount, notLinkedReply }
};
