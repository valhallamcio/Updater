/*
 * File: chatFlags.js
 * Project: valhalla-updater
 * -----
 * The staff half of Bifrost's chat guard. A message that hits the hard word list, a hate
 * symbol or the Jev block threshold mutes the player for good, and the proxy writes a doc
 * to bifrost.chat_flags. A lower Jev score writes a doc with no mute, for review. This
 * posts one card per open flag into the staff channel, with buttons on it.
 *
 * The proxy keeps one open doc per player. While it is open, the proxy can add context
 * lines and raise `action` from review to muted. Every pass compares each open card with
 * the doc and edits the card when the doc changed.
 *
 * A click works like a link request. The flag leaves `open` first, on a filter that only
 * matches while it is still open. The console command goes to Bifrost after that. A second
 * clicker matches nothing, is told who got there first, and sends nothing. Bifrost's
 * console does not strip a leading slash, so the commands go without one.
 *
 * No channelId means one warning at startup and nothing else.
 */

const crypto = require('crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits,
    escapeMarkdown
} = require('discord.js');
const mongo = require('../modules/mongo');
const pterodactyl = require('../modules/pterodactyl');
const sessionLogger = require('../modules/sessionLogger');

const LOG = 'ChatFlags';
// Every button this scheduler owns starts with it, so nothing else has to be parsed.
const PREFIX = 'chatflag:';
const BATCH = 10;
const SYNC_BATCH = 50;
const COLOUR = { muted: 0xe74c3c, review: 0xe67e22, decided: 0x95a5a6 };
const NO_MENTIONS = { parse: [] };

// The buttons on each kind of card, in the order staff see them.
const BUTTONS = {
    muted: ['ban', 'unmute', 'keep'],
    review: ['mute', 'ban', 'dismiss']
};
const CHOICES = {
    ban: { status: 'banned', label: 'Ban', style: ButtonStyle.Danger, command: 'ban' },
    unmute: { status: 'unmuted', label: 'Unmute', style: ButtonStyle.Secondary, command: 'unmute' },
    keep: { status: 'kept', label: 'Keep muted', style: ButtonStyle.Primary, command: null },
    mute: { status: 'muted', label: 'Mute', style: ButtonStyle.Primary, command: 'mute' },
    dismiss: { status: 'dismissed', label: 'Dismiss', style: ButtonStyle.Secondary, command: null }
};
const DECIDED = {
    banned: 'Banned',
    unmuted: 'Unmuted',
    kept: 'Kept muted',
    muted: 'Muted',
    dismissed: 'Dismissed'
};
const SOURCE = { hardlist: 'Hard word list', symbol: 'Hate symbol', jev: 'Jev classifier' };
const SCORES = ['hate', 'harass', 'threat', 'selfharm'];

// Bifrost's console splits a line on whitespace, and a newline starts a new command.
const SAFE_NAME = /^[^\s\u0000-\u001f\u007f]+$/;

// One pass at a time: a slow channel must not have the next interval posting the same
// flags again behind it.
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

/**
 * Player text made safe for a card: one line, no markdown, and no mention that resolves.
 * @param {*} value Text the player or the proxy wrote.
 * @returns {string} Text Discord shows as it is.
 */
function cleanText(value) {
    const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
    return escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true, maskedLink: true })
        .replace(/^>/, '\\>')
        .replace(/@/g, '@\u200b')
        .replace(/</g, '<\u200b');
}

/**
 * A value for a console line or inline code: control characters and backticks out.
 * @param {*} value The value.
 * @returns {string} One line of text.
 */
function oneLine(value) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/`/g, "'")
        .trim();
}

/**
 * Cuts text to a Discord limit.
 * @param {string} text The text.
 * @param {number} max The limit.
 * @returns {string} The text, or its start with an ellipsis.
 */
function fit(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A Discord timestamp tag, or nothing when the date is not usable.
 * @param {*} value A Date or anything `new Date` takes.
 * @param {string} style The tag style letter.
 * @returns {string} `<t:unix:style>` or ''.
 */
function stamp(value, style) {
    if (value == null) return '';
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? `<t:${Math.floor(time / 1000)}:${style}>` : '';
}

/**
 * The classifier scores as whole percentages.
 * @param {object|null} scores `{hate, harass, threat, selfharm}` from 0 to 1, or null.
 * @returns {string} One line for the card.
 */
function formatScores(scores) {
    if (!scores || typeof scores !== 'object') return 'None';
    return SCORES.map(key => {
        const value = scores[key];
        return `${key} ${typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a'}`;
    }).join(', ');
}

/**
 * The buttons a flag's card carries.
 * @param {string} action The flag's `action`.
 * @returns {string[]} Choice keys.
 */
function buttonsFor(action) {
    return BUTTONS[action] || BUTTONS.review;
}

module.exports = {
    name: 'chatFlags',
    defaultConfig: {
        "active": true,
        "interval": 1,
        "channelId": "",
        // empty = anyone with Manage Guild decides
        "staffRoleIds": []
    },

    /**
     * Starts the poster and hooks the buttons up.
     * @param {object} options Scheduler config (`scheduler.chatFlags` in config.json).
     */
    start: async function (options) {
        const config = Object.assign({}, this.defaultConfig, options || {});

        if (!config.channelId) {
            sessionLogger.warn(LOG, 'Set the chat flag channel up in /config/config.json!');
            return;
        }

        const client = await this.getClient();

        client.on('interactionCreate', async interaction => {
            if (!interaction.isButton() || !String(interaction.customId).startsWith(PREFIX)) return;
            try {
                await this.handleButton(interaction, config);
            } catch (error) {
                sessionLogger.error(LOG, 'A chat flag button failed:', error.message);
            }
        });

        const tick = () => this.postOpenFlags(config).catch(error =>
            sessionLogger.error(LOG, 'Could not post the open chat flags (will try again next interval):', error.message));
        tick();
        setInterval(tick, Math.max(1, config.interval) * 60 * 1000);
    },

    /**
     * Posts every open flag nobody has seen yet, then brings the open cards up to date.
     * Never throws.
     * @param {object} config Scheduler config.
     * @param {object} [deps] `{channel}` - only tests pass one.
     * @returns {Promise<object>} `{posted, edited, read}`, or `{posted: 0, edited: 0, reason}`
     *     when it did nothing.
     */
    postOpenFlags: async function (config, deps = {}) {
        if (posting) return { posted: 0, edited: 0, reason: 'in-flight' };
        posting = true;
        try {
            const channel = deps.channel || await this.getChannel(config.channelId);
            if (!channel) return { posted: 0, edited: 0, reason: 'no-channel' };

            const flags = await mongo.findChatFlagsToPost(BATCH);
            let posted = 0;
            for (const flag of flags || []) {
                try {
                    const message = await channel.send({
                        embeds: [this.buildEmbed(flag)],
                        components: this.buildComponents(flag),
                        allowedMentions: NO_MENTIONS
                    });
                    await mongo.markChatFlagPosted(flag._id, message.id, channel.id, this.cardHash(flag));
                    posted++;
                } catch (error) {
                    sessionLogger.error(LOG, `Could not post chat flag ${flag._id}:`, error.message);
                }
            }

            const edited = await this.syncPostedFlags(channel);

            if (posted > 0) {
                sessionLogger.info(LOG, `Posted ${posted} chat flag${posted === 1 ? '' : 's'} for staff to decide`);
            }
            return { posted: posted, edited: edited, read: (flags || []).length };
        } finally {
            posting = false;
        }
    },

    /**
     * Edits every open card whose flag the proxy changed after the card was drawn.
     * @param {object} channel The configured staff channel.
     * @returns {Promise<number>} How many cards it edited.
     */
    syncPostedFlags: async function (channel) {
        const flags = await mongo.findPostedChatFlags(SYNC_BATCH);
        let edited = 0;
        for (const flag of flags || []) {
            const hash = this.cardHash(flag);
            if (hash === flag.cardHash) continue;
            try {
                const home = flag.channelId && String(flag.channelId) !== String(channel.id)
                    ? await this.getChannel(flag.channelId)
                    : channel;
                if (!home) continue;
                const message = await home.messages.fetch(String(flag.messageId));
                await message.edit({
                    embeds: [this.buildEmbed(flag)],
                    components: this.buildComponents(flag),
                    allowedMentions: NO_MENTIONS
                });
                await mongo.setChatFlagCardHash(flag._id, hash);
                edited++;

                // A click can close the card while this edit is in flight, and the edit
                // then puts the buttons back. Read the flag again and close it once more.
                const after = await mongo.getChatFlag(flag._id);
                if (after && after.status !== 'open') {
                    await message.edit({
                        embeds: [this.buildEmbed(after, {
                            status: after.status,
                            byName: after.decidedName,
                            at: after.decidedAt
                        })],
                        components: [],
                        allowedMentions: NO_MENTIONS
                    });
                }
            } catch (error) {
                sessionLogger.error(LOG, `Could not update the card for chat flag ${flag._id}:`, error.message);
            }
        }
        return edited;
    },

    /**
     * Decides one flag off a button click. Never throws.
     * @param {object} interaction The button interaction.
     * @param {object} config Scheduler config.
     * @returns {Promise<void>} Resolves once the clicker has an answer.
     */
    handleButton: async function (interaction, config) {
        const [, key, id] = String(interaction.customId).split(':');
        const choice = CHOICES[key];
        if (!choice) return;

        if (!this.isStaff(interaction, config.staffRoleIds)) {
            await interaction.reply({
                content: '❌ Chat flags are for staff to decide.',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const flag = await mongo.getChatFlag(id);
        if (!flag) {
            await interaction.editReply('❌ That flag is no longer in the database.');
            return;
        }
        if (flag.status !== 'open') {
            await interaction.editReply(this.alreadyHandled(flag));
            return;
        }
        if (!buttonsFor(flag.action).includes(key)) {
            await this.refreshMessage(interaction.message, flag);
            await interaction.editReply('⚠️ This flag changed after the card went up. The card shows the current choices now.');
            return;
        }

        const name = cleanText(flag.username || 'that player');
        if (choice.command && !SAFE_NAME.test(String(flag.username || ''))) {
            await interaction.editReply(
                `❌ The name on this flag cannot go into a console command safely. Handle **${name}** in game.`);
            return;
        }

        const byName = interaction.user.username;
        // The status first, and only while the flag is still open with the action this
        // clicker saw. The second click of a double click stops here and sends nothing.
        const claim = await mongo.claimChatFlag(flag._id, flag.action, choice.status, interaction.user.id, byName);
        if (!claim || claim.matchedCount === 0) {
            const now = await mongo.getChatFlag(id);
            if (now && now.status === 'open') {
                await this.refreshMessage(interaction.message, now);
                await interaction.editReply('⚠️ This flag changed after the card went up. The card shows the current choices now.');
                return;
            }
            await interaction.editReply(this.alreadyHandled(now || flag));
            return;
        }

        const command = this.buildCommand(key, flag, byName);
        let commandError = null;
        if (command) {
            commandError = await this.sendToBifrost(command);
            if (commandError) {
                sessionLogger.error(LOG,
                    `Chat flag ${flag._id} is ${choice.status}, but \`${command}\` did not reach Bifrost:`, commandError);
            }
        }

        await this.closeMessage(interaction, flag, {
            status: choice.status,
            byName: byName,
            at: new Date(),
            command: command,
            commandError: commandError
        });

        sessionLogger.info(LOG, `${byName} set the chat flag on ${flag.username} to ${choice.status}`);
        if (commandError) {
            await interaction.editReply(`⚠️ The flag stays marked **${choice.status}**, but \`${oneLine(command)}\` `
                + `did not reach Bifrost: ${cleanText(commandError)}. Run it on the Bifrost console by hand.`);
            return;
        }
        if (command) {
            await interaction.editReply(`✅ ${DECIDED[choice.status]} **${name}**. Sent \`${oneLine(command)}\` to Bifrost.`);
            return;
        }
        await interaction.editReply(choice.status === 'kept'
            ? `✅ **${name}** stays muted.`
            : `✅ Dismissed the flag on **${name}**.`);
    },

    /**
     * The console line a choice sends to Bifrost. No leading slash: the console matches
     * the first word against command names as it is.
     * @param {string} key The choice ('ban', 'unmute', 'keep', 'mute' or 'dismiss').
     * @param {object} flag The flag doc.
     * @param {string} byName Discord username of whoever clicked.
     * @returns {string|null} The command, or null when the choice sends none.
     */
    buildCommand: function (key, flag, byName) {
        const choice = CHOICES[key];
        if (!choice || !choice.command) return null;
        const target = String(flag.username);
        if (choice.command === 'unmute') return `unmute ${target}`;
        // No duration word, so the punishment is permanent. The reason starts with
        // "chatguard", which Bifrost can never read as a duration.
        return `${choice.command} ${target} chatguard flag ${flag._id} (${oneLine(flag.source)}) by ${oneLine(byName)}`;
    },

    /**
     * Sends one console line to Bifrost's Pterodactyl server.
     * @param {string} command The console line.
     * @returns {Promise<string|null>} Null once Pterodactyl took it, or what went wrong.
     */
    sendToBifrost: async function (command) {
        const { velocityID } = require('../config/config.json').pterodactyl || {};
        if (!velocityID) return 'pterodactyl.velocityID is not set in config.json';
        try {
            const result = await pterodactyl.sendCommand(velocityID, command);
            if (result && result.timeout) return 'Pterodactyl timed out, so the command may not have run';
            return null;
        } catch (error) {
            return (error && error.message) || String(error);
        }
    },

    /**
     * The answer for a clicker who lost the race.
     * @param {object} flag The flag doc as it is now.
     * @returns {string} The reply.
     */
    alreadyHandled: function (flag) {
        const who = flag.decidedName ? cleanText(flag.decidedName) : 'another staff member';
        const what = DECIDED[flag.status] ? ` (${DECIDED[flag.status].toLowerCase()})` : '';
        return `Already handled by **${who}**${what}.`;
    },

    /**
     * May this member decide flags? The configured roles when there are any, Manage
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
     * Rewrites the card with the decision on it and takes the buttons off. Never throws.
     * The decision is already in Mongo.
     * @param {object} interaction The button interaction.
     * @param {object} flag The flag doc.
     * @param {object} decision `{status, byName, at, command, commandError}`.
     * @returns {Promise<void>} Resolves when the edit is done or has failed.
     */
    closeMessage: async function (interaction, flag, decision) {
        try {
            await interaction.message.edit({
                embeds: [this.buildEmbed(flag, decision)],
                components: [],
                allowedMentions: NO_MENTIONS
            });
        } catch (error) {
            sessionLogger.error(LOG, `Could not close the card for chat flag ${flag._id}:`, error.message);
        }
    },

    /**
     * Redraws an open card from the flag as it is now. Never throws.
     * @param {object} message The card message.
     * @param {object} flag The open flag doc.
     * @returns {Promise<void>} Resolves when the edit is done or has failed.
     */
    refreshMessage: async function (message, flag) {
        try {
            await message.edit({
                embeds: [this.buildEmbed(flag)],
                components: this.buildComponents(flag),
                allowedMentions: NO_MENTIONS
            });
            await mongo.setChatFlagCardHash(flag._id, this.cardHash(flag));
        } catch (error) {
            sessionLogger.error(LOG, `Could not redraw the card for chat flag ${flag._id}:`, error.message);
        }
    },

    /**
     * Builds the flag card.
     * @param {object} flag A bifrost.chat_flags doc.
     * @param {object} [decision] `{status, byName, at, command, commandError}` once decided.
     * @returns {EmbedBuilder} The embed.
     */
    buildEmbed: function (flag, decision) {
        const muted = flag.action === 'muted';
        const embed = new EmbedBuilder()
            .setTitle(muted ? 'Chat flag: muted automatically' : 'Chat flag: needs review')
            .setColor(decision ? COLOUR.decided : (muted ? COLOUR.muted : COLOUR.review))
            .setDescription(this.contextText(flag))
            .addFields(
                { name: 'Player', value: fit(cleanText(flag.username || 'unknown'), 256), inline: true },
                { name: 'UUID', value: `\`${fit(oneLine(flag.uuid) || 'unknown', 64)}\``, inline: true },
                { name: 'Server', value: fit(cleanText(flag.server || 'unknown'), 256), inline: true },
                { name: 'Source', value: SOURCE[flag.source] || fit(cleanText(flag.source || 'unknown'), 64), inline: true },
                { name: 'Action', value: muted ? 'Muted for good' : 'Review only, no mute', inline: true },
                { name: 'Scores', value: formatScores(flag.scores), inline: true },
                { name: 'Message', value: fit(cleanText(flag.message), 1024) || 'None' }
            )
            .setFooter({ text: `Flag ${flag._id}` });

        if (flag.createdAt) embed.setTimestamp(new Date(flag.createdAt));
        if (decision) {
            const when = stamp(decision.at, 'f');
            embed.addFields({
                name: 'Decision',
                value: `${DECIDED[decision.status] || cleanText(decision.status)} by `
                    + `${cleanText(decision.byName || 'unknown')}${when ? `, ${when}` : ''}`
            });
            if (decision.commandError) {
                embed.addFields({
                    name: 'Bifrost command failed',
                    value: fit(`\`${oneLine(decision.command)}\` did not reach Bifrost: `
                        + `${cleanText(decision.commandError)}. Run it by hand.`, 500)
                });
            }
        }
        return embed;
    },

    /**
     * The context lines, oldest first, each with its time. Keeps the newest lines when
     * they do not all fit.
     * @param {object} flag The flag doc.
     * @returns {string} The card description.
     */
    contextText: function (flag) {
        const lines = (Array.isArray(flag.context) ? flag.context : []).map(line => {
            const when = stamp(line && line.at, 'T');
            const text = cleanText(String(line && line.text != null ? line.text : '').slice(0, 300));
            return when ? `${when} ${text}` : text;
        });
        if (lines.length === 0) return '**Context**\nNone';

        const kept = [];
        let length = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (length + lines[i].length + 1 > 3400) break;
            kept.unshift(lines[i]);
            length += lines[i].length + 1;
        }
        const cut = lines.length - kept.length;
        return `**Context**\n${cut > 0 ? `(${cut} older line${cut === 1 ? '' : 's'} left out)\n` : ''}${kept.join('\n')}`;
    },

    /**
     * Builds the button row for an open flag.
     * @param {object} flag The flag doc.
     * @returns {ActionRowBuilder[]} One row.
     */
    buildComponents: function (flag) {
        const id = String(flag._id);
        return [new ActionRowBuilder().addComponents(buttonsFor(flag.action).map(key =>
            new ButtonBuilder()
                .setCustomId(`${PREFIX}${key}:${id}`)
                .setLabel(CHOICES[key].label)
                .setStyle(CHOICES[key].style)))];
    },

    /**
     * A fingerprint of the open card. A different one means the proxy changed the flag.
     * @param {object} flag The flag doc.
     * @returns {string} Hex digest.
     */
    cardHash: function (flag) {
        return crypto.createHash('sha1')
            .update(JSON.stringify({ embed: this.buildEmbed(flag).toJSON(), buttons: buttonsFor(flag.action) }))
            .digest('hex');
    },

    /**
     * Gets the bot client. Tests replace it.
     * @returns {Promise<object>} The discord.js client once it is ready.
     */
    getClient: async function () {
        const { getClient } = require('../discord/bot');
        return getClient();
    },

    /**
     * Gets a channel off the bot client.
     * @param {string} channelId Channel snowflake.
     * @returns {Promise<object|null>} The channel, or null when it cannot be reached.
     */
    getChannel: async function (channelId) {
        try {
            const client = await this.getClient();
            return await client.channels.fetch(String(channelId));
        } catch (error) {
            sessionLogger.error(LOG, `Could not fetch channel ${channelId}:`, error.message);
            return null;
        }
    }
};
