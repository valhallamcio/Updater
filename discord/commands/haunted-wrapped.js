/*
 * File: haunted-wrapped.js
 * Project: valhalla-updater
 * -----
 * /haunted-wrapped: a player's Herobrine log from Halloween 2026, sent by DM.
 * It runs from Nov 1 to Nov 8 2026 (UTC dates). Only the player who runs it gets a DM,
 * and the DM shows only their own linked account.
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    escapeMarkdown
} = require('discord.js');

const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const { normalizeUuid } = require('../../modules/uuidUtils');
const haunted = require('../../modules/hauntedWrapped');
const linkFlow = require('./util/linkFlow');

const cooldowns = new Map();
const COOLDOWN_MS = 30 * 1000;
const SERVER_LIST_MAX_AGE_MS = 30 * 1000;

/**
 * The account the log is about. This is the /wrapped rule: the link on bifrost.players,
 * and with several accounts the first one linked.
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
 * The uuid spellings to look up. The proxy writes `_id` as it holds the uuid, which is the
 * same string as bifrost.players.uuid. The dashed lower-case form is the fallback.
 * @param {*} uuid bifrost.players.uuid.
 * @returns {string[]}
 */
function uuidKeys(uuid) {
    if (typeof uuid !== 'string' || !uuid) return [];
    const keys = [uuid];
    try {
        const dashed = normalizeUuid(uuid);
        if (dashed !== uuid) keys.push(dashed);
    } catch {
        // not 32 hex digits: only the stored spelling can match
    }
    return keys;
}

/**
 * Pack names by server id. Without Yggdrasil the log shows no pack names.
 * @returns {Promise<Map<string, string>>}
 */
async function loadServerNames() {
    try {
        return haunted.serverNameMap(await yggdrasil.getServers(SERVER_LIST_MAX_AGE_MS));
    } catch (error) {
        console.error('[HauntedWrapped] Server list failed:', error.message);
        return new Map();
    }
}

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
            `Then use \`/haunted-wrapped\` again.`
        );
    return { embeds: [embed], components: [linkFlow.buildOpenRow()] };
}

/**
 * The command body. `now` decides the window.
 * @param {object} interaction The slash command interaction.
 * @param {number} now Epoch ms.
 */
async function run(interaction, now) {
    const state = haunted.windowState(now);
    if (state !== 'open') {
        return interaction.reply({
            content: state === 'before'
                ? 'Haunted Wrapped opens on November 1.'
                : 'Haunted Wrapped closed on November 8. See you next Halloween.',
            ephemeral: true
        });
    }

    const userId = interaction.user.id;
    const remaining = COOLDOWN_MS - (now - (cooldowns.get(userId) || 0));
    if (remaining > 0) {
        return interaction.reply({
            content: `Please wait **${Math.ceil(remaining / 1000)} seconds** before you use this command again.`,
            ephemeral: true
        });
    }
    cooldowns.set(userId, now);

    await interaction.deferReply({ ephemeral: true });

    try {
        const account = await findLinkedAccount(userId);
        if (!account) return interaction.editReply(notLinkedReply());

        const keys = uuidKeys(account.uuid);
        if (keys.length === 0) {
            return interaction.editReply({ content: 'Could not read your Minecraft UUID. Please ask staff for help.' });
        }

        const username = account.username || 'your account';
        const doc = haunted.normalizeLadder(await mongo.getHerobrinePlayer(keys));
        if (!haunted.hasSightings(doc)) {
            return interaction.editReply({
                content: `No Herobrine sightings on **${escapeMarkdown(username)}**.\n*he never found you.*`
            });
        }

        const embed = haunted.buildHauntedEmbed(doc, {
            username: account.username,
            serverNames: await loadServerNames()
        });

        try {
            const dmChannel = await interaction.user.createDM();
            await dmChannel.send({ embeds: [embed] });
        } catch (dmError) {
            console.error('[HauntedWrapped] Could not send DM:', dmError.message);
            return interaction.editReply({
                content: 'I could not send you a DM. Turn on direct messages from server members, then use `/haunted-wrapped` again.'
            });
        }

        return interaction.editReply({ content: 'Your Haunted Wrapped is in your DMs.' });
    } catch (error) {
        console.error('[HauntedWrapped] Command error:', error);
        return interaction.editReply({ content: 'Something went wrong. Please try again later.' });
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('haunted-wrapped')
        .setDescription('Get your Herobrine log from Halloween 2026 by DM.')
        .setDMPermission(false),

    async execute(interaction) {
        return run(interaction, Date.now());
    },

    _internals: { run, findLinkedAccount, uuidKeys, cooldowns }
};
