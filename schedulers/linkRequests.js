/*
 * File: linkRequests.js
 * Project: valhalla-updater
 * -----
 * The staff half of the in-game `/link request`. Some players cannot use Discord at all -
 * they live where it is blocked, or they have their own reason - so the proxy lets them
 * ask in game and drops a doc in bifrost.link_requests. This posts one embed per open
 * request into the staff channel, with an Approve and a Deny button on it.
 *
 * Approve writes `discord_link_exempt` onto the player's bifrost.players doc. The proxy
 * watches that collection, so the player hears about it in game about a second later.
 *
 * The order of the two writes is what keeps a double click honest: the request leaves
 * `open` FIRST, with a filter that only matches while it is still open, and the player doc
 * is written after. A second clicker matches nothing, is told somebody beat them to it,
 * and writes nothing at all. Posting works the other way round - the embed goes out before
 * the request is marked as posted, because a duplicate embed costs staff one glance and a
 * lost one costs the player their answer.
 *
 * No channelId means one warning at startup and nothing else.
 */

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');
const mongo = require('../modules/mongo');
const sessionLogger = require('../modules/sessionLogger');

const LOG = 'LinkRequests';
// Every button this scheduler owns starts with it, so nothing else has to be parsed.
const PREFIX = 'linkreq:';
const BATCH = 10;
const COLOUR = { open: 0x5865f2, approved: 0x2ecc71, denied: 0x95a5a6 };

// One pass at a time: a slow channel must not have the next interval posting the same
// requests again behind it.
let posting = false;

/**
 * The role ids a member holds, whichever shape the interaction carries them in.
 * @param {object} member `interaction.member`.
 * @returns {string[]} Role ids as strings.
 */
function memberRoleIds(member) {
    if (!member || !member.roles) return [];
    if (Array.isArray(member.roles)) return member.roles.map(String);
    if (member.roles.cache) return [...member.roles.cache.keys()].map(String);
    return [];
}

module.exports = {
    name: 'linkRequests',
    defaultConfig: {
        "active": true,
        "interval": 1,
        "channelId": "",
        // empty = anyone with Manage Guild decides
        "staffRoleIds": []
    },

    /**
     * Starts the poster and hooks the two buttons up.
     * @param {object} options Scheduler config (`scheduler.linkRequests` in config.json).
     */
    start: async function (options) {
        const config = Object.assign({}, this.defaultConfig, options || {});

        if (!config.channelId) {
            sessionLogger.warn(LOG, 'Set the link request channel up in /config/config.json!');
            return;
        }

        const { getClient } = require('../discord/bot');
        const client = await getClient();

        client.on('interactionCreate', async interaction => {
            if (!interaction.isButton() || !String(interaction.customId).startsWith(PREFIX)) return;
            try {
                await this.handleButton(interaction, config);
            } catch (error) {
                sessionLogger.error(LOG, 'A link request button failed:', error.message);
            }
        });

        const tick = () => this.postOpenRequests(config).catch(error =>
            sessionLogger.error(LOG, 'Could not post the open link requests (will try again next interval):', error.message));
        tick();
        setInterval(tick, Math.max(1, config.interval) * 60 * 1000);
    },

    /**
     * Posts every open request nobody has seen yet. Never throws.
     * @param {object} config Scheduler config.
     * @param {object} [deps] `{channel}` - only tests pass one.
     * @returns {Promise<object>} `{posted, read}`, or `{posted: 0, reason}` when it did nothing.
     */
    postOpenRequests: async function (config, deps = {}) {
        if (posting) return { posted: 0, reason: 'in-flight' };
        posting = true;
        try {
            const channel = deps.channel || await this.getChannel(config.channelId);
            if (!channel) return { posted: 0, reason: 'no-channel' };

            const requests = await mongo.findOpenLinkRequests(BATCH);
            let posted = 0;
            for (const request of requests || []) {
                try {
                    const message = await channel.send({
                        embeds: [this.buildEmbed(request)],
                        components: this.buildComponents(String(request._id), false)
                    });
                    await mongo.markLinkRequestPosted(request._id, message.id);
                    posted++;
                } catch (error) {
                    sessionLogger.error(LOG, `Could not post link request ${request._id}:`, error.message);
                }
            }

            if (posted > 0) {
                sessionLogger.info(LOG, `Posted ${posted} link request${posted === 1 ? '' : 's'} for staff to decide`);
            }
            return { posted: posted, read: (requests || []).length };
        } finally {
            posting = false;
        }
    },

    /**
     * Decides one request off a button click. Never throws.
     * @param {object} interaction The button interaction.
     * @param {object} config Scheduler config.
     * @returns {Promise<void>} Resolves once the clicker has an answer.
     */
    handleButton: async function (interaction, config) {
        const [, action, id] = String(interaction.customId).split(':');
        if (action !== 'approve' && action !== 'deny') return;

        if (!this.isStaff(interaction, config.staffRoleIds)) {
            await interaction.reply({
                content: '❌ Link requests are for staff to decide.',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const request = await mongo.getLinkRequest(id);
        if (!request) {
            await interaction.editReply('❌ That request is no longer in the database.');
            return;
        }

        const status = action === 'approve' ? 'approved' : 'denied';
        const at = new Date();
        const name = request.username || 'that player';

        // The status first, and only while it is still open - the second click of a double
        // click matches nothing and stops here, so the exemption is never written twice.
        const claim = await mongo.claimLinkRequest(
            request._id, status, interaction.user.id, interaction.user.username);
        if (!claim || claim.matchedCount === 0) {
            await interaction.editReply(`Somebody already decided the request from **${name}**.`);
            return;
        }

        let exemptWritten = true;
        if (status === 'approved') {
            try {
                // The helper has no upsert, so a uuid with no player doc matches nothing and
                // says so quietly. The request has already left `open` and can never be
                // posted again, so a silent miss is a player who is never approved.
                const write = await mongo.setBifrostLinkExempt(request.uuid, {
                    by: String(interaction.user.id),
                    byName: String(interaction.user.username),
                    reason: String(request.reason == null ? '' : request.reason),
                    at: at
                });
                if (!write || write.matchedCount === 0) {
                    exemptWritten = false;
                    sessionLogger.error(LOG,
                        `Approved ${name} but no bifrost.players doc matches ${request.uuid} - the exemption went nowhere`);
                }
            } catch (error) {
                exemptWritten = false;
                sessionLogger.error(LOG,
                    `Approved ${name} but could not write the exemption onto ${request.uuid}:`, error.message);
            }
        }

        await this.closeMessage(interaction, request, {
            status: status,
            byName: interaction.user.username,
            at: at
        });

        sessionLogger.info(LOG, `${interaction.user.username} ${status} the link request from ${name}`);
        if (!exemptWritten) {
            await interaction.editReply(`⚠️ **${name}** is approved, but the exemption did not save — check the logs.`);
            return;
        }
        await interaction.editReply(status === 'approved'
            ? `✅ **${name}** can play without linking Discord.`
            : `❌ Denied the request from **${name}**.`);
    },

    /**
     * May this member decide requests? The configured roles when there are any, Manage
     * Guild when the list is empty.
     * @param {object} interaction The button interaction.
     * @param {string[]} staffRoleIds Role ids from the config.
     * @returns {boolean} True when they may.
     */
    isStaff: function (interaction, staffRoleIds) {
        const ids = (Array.isArray(staffRoleIds) ? staffRoleIds : []).filter(Boolean).map(String);
        if (ids.length === 0) {
            return Boolean(interaction.memberPermissions
                && interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild));
        }
        return memberRoleIds(interaction.member).some(id => ids.includes(id));
    },

    /**
     * Rewrites the embed with the decision on it and takes both buttons out of service.
     * Never throws - the decision is already in Mongo.
     * @param {object} interaction The button interaction.
     * @param {object} request The request doc.
     * @param {object} decision `{status, byName, at}`.
     * @returns {Promise<void>} Resolves when the edit is done or has failed.
     */
    closeMessage: async function (interaction, request, decision) {
        try {
            await interaction.message.edit({
                embeds: [this.buildEmbed(request, decision)],
                components: this.buildComponents(String(request._id), true)
            });
        } catch (error) {
            sessionLogger.error(LOG, `Could not close the message for request ${request._id}:`, error.message);
        }
    },

    /**
     * Builds the request card.
     * @param {object} request A bifrost.link_requests doc.
     * @param {object} [decision] `{status, byName, at}` once somebody has decided.
     * @returns {EmbedBuilder} The embed.
     */
    buildEmbed: function (request, decision) {
        let country = request.country ? String(request.country) : 'Not given';
        if (request.cannotLink) country += '\nSays they cannot use Discord.';

        const embed = new EmbedBuilder()
            .setTitle('Link request')
            .setColor(decision ? COLOUR[decision.status] : COLOUR.open)
            .addFields(
                { name: 'Minecraft name', value: String(request.username || 'unknown'), inline: true },
                { name: 'UUID', value: `\`${String(request.uuid)}\``, inline: true },
                { name: 'Country', value: country },
                { name: 'Reason', value: String(request.reason || 'None given').slice(0, 1024) }
            )
            .setFooter({ text: `Request ${request._id}` });

        if (request.createdAt) embed.setTimestamp(new Date(request.createdAt));
        if (decision) {
            embed.addFields({
                name: decision.status === 'approved' ? 'Approved by' : 'Denied by',
                value: `${decision.byName} — <t:${Math.floor(decision.at.getTime() / 1000)}:f>`
            });
        }
        return embed;
    },

    /**
     * Builds the Approve and Deny row.
     * @param {string} id The request _id, as text.
     * @param {boolean} disabled True once the request is decided.
     * @returns {ActionRowBuilder[]} One row, two buttons.
     */
    buildComponents: function (id, disabled) {
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${PREFIX}approve:${id}`)
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success)
                .setDisabled(Boolean(disabled)),
            new ButtonBuilder()
                .setCustomId(`${PREFIX}deny:${id}`)
                .setLabel('Deny')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(Boolean(disabled))
        )];
    },

    /**
     * Gets the staff channel off the bot client.
     * @param {string} channelId Channel snowflake.
     * @returns {Promise<object|null>} The channel, or null when it cannot be reached.
     */
    getChannel: async function (channelId) {
        try {
            const { getClient } = require('../discord/bot');
            const client = await getClient();
            return await client.channels.fetch(String(channelId));
        } catch (error) {
            sessionLogger.error(LOG, `Could not fetch channel ${channelId}:`, error.message);
            return null;
        }
    }
};
