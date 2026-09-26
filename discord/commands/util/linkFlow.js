/*
 * File: linkFlow.js
 * Project: valhalla-updater
 * -----
 * The one claim path behind every way to link: `/link code:`, `/link` with no code (it
 * opens the code box), the [Link account] button on the #link panel, and the [Try again]
 * and [Link account] buttons other replies carry. They all end in claimLink() and
 * replyFor(), so a reply means the same thing whichever door the player used.
 *
 * The proxy mints the code in game, this writes `discord_id` onto the player's
 * bifrost.players doc, and the proxy's change stream puts "Discord linked" on their
 * screen about a second later. The proxy's link gate listens to that same event and
 * makes them a Member on the spot, which is why the success reply can say no relog.
 *
 * The code is CLAIMED before anything else: reading it first and burning it after let
 * two Discords redeeming the same code both pass the check and both write the player.
 * The write is guarded the same way, so an in-game link landing in between loses the
 * race instead of being overwritten.
 *
 * A failed claim reads the code back to say WHY: a typo, a code that never existed, one
 * that expired, one already spent (by this Discord or by another), or an account that
 * belongs to another Discord. Every failure gets a row in bifrost.discord_link_failures
 * with the first two characters of the code and never the whole code.
 * (The commands/ loader only picks up top-level files, so this util is never a command.)
 */

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const mongo = require('../../../modules/mongo');
const sessionLogger = require('../../../modules/sessionLogger');
const {
    CODE_LENGTH,
    CODE_TTL_MINUTES,
    normalizeCode,
    isValidCode,
    buildLinkAudit,
    buildLinkFailure
} = require('./linkCode');
const verifiedRole = require('./verifiedRole');

const LOG = 'DiscordLink';
const GUILD_ID = '932251649379016714';
const LINK_CHANNEL_ID = '1552762887276335294';

// Every component this flow owns starts with it. `linkreq:` (the staff request cards)
// does not, so the two never catch each other's clicks.
const PREFIX = 'link:';
const OPEN_ID = 'link:open';
const MINE_ID = 'link:mine';
const MODAL_ID = 'link:modal';
const CODE_FIELD = 'code';
// What a reply echoes back of a malformed entry. It only needs to show the typo.
const ECHO_MAX = 20;

/** Outcomes that wrote nothing. Each one is logged, and each one offers [Try again]. */
const FAILURES = new Set(['format', 'unknown', 'expired', 'used_self', 'used_other', 'revoked', 'taken', 'no_player']);

/**
 * The #link channel id. The panel scheduler's config may move it; the default is the
 * channel the proxy's [Open #link] button opens.
 * @returns {string} Channel snowflake.
 */
function linkChannelId() {
    try {
        const config = require('../../../config/config.json');
        const id = config.scheduler && config.scheduler.linkPanel && config.scheduler.linkPanel.channelId;
        return typeof id === 'string' && id ? id : LINK_CHANNEL_ID;
    } catch (_) {
        return LINK_CHANNEL_ID;
    }
}

/**
 * The code box. Discord modals carry text inputs only, so the "no code yet" line rides
 * the placeholder.
 * @returns {ModalBuilder} The modal.
 */
function buildModal() {
    return new ModalBuilder()
        .setCustomId(MODAL_ID)
        .setTitle('Link your Minecraft account')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId(CODE_FIELD)
                .setLabel('Code from /link in game')
                .setPlaceholder('No code yet? Join the server and type /link in game.')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(32)
        ));
}

/**
 * The [Link account] button, for a reply that sends the player into the flow.
 * @param {string} [label] Button text.
 * @returns {ActionRowBuilder} One row, one button.
 */
function buildOpenRow(label) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(OPEN_ID)
            .setLabel(label || 'Link account')
            .setStyle(ButtonStyle.Primary)
    );
}

/**
 * The panel message Fenrir keeps in #link.
 * @returns {object} `{embeds, components}` for send or edit.
 */
function buildPanel() {
    const embed = new EmbedBuilder()
        .setTitle('Link your Minecraft account')
        .setColor(0x5865f2)
        .setDescription(
            '1. Join the server and type `/link` in game. You get a short code.\n' +
            '2. Press **Link account** below and type the code.\n\n' +
            `The code works for ${CODE_TTL_MINUTES} minutes. Only you see the answer. ` +
            'The link shows in game within seconds. You do not need to relog.\n\n' +
            'One Discord can hold several Minecraft accounts. **My accounts** lists yours.'
        );
    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(OPEN_ID).setLabel('Link account').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(MINE_ID).setLabel('My accounts').setStyle(ButtonStyle.Secondary)
        )]
    };
}

/**
 * Is this one of Fenrir's own panel messages? Bots always see their own components, so
 * this needs no MessageContent intent.
 * @param {object} message A discord.js message.
 * @param {string} botId The bot's user id.
 * @returns {boolean} True for a panel this bot posted.
 */
function isPanelMessage(message, botId) {
    if (!message || !message.author || String(message.author.id) !== String(botId)) return false;
    for (const row of message.components || []) {
        for (const component of row.components || []) {
            const id = component.customId || (component.data && component.data.custom_id);
            if (id === OPEN_ID) return true;
        }
    }
    return false;
}

/**
 * Does this interaction belong to the link flow?
 * @param {object} interaction Any interaction.
 * @returns {boolean} True for our buttons and our modal.
 */
function owns(interaction) {
    if (!interaction || typeof interaction.customId !== 'string') return false;
    if (!interaction.customId.startsWith(PREFIX)) return false;
    const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
    const isModal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
    return isButton || isModal;
}

/**
 * Why a claim found nothing. Reads the code back; the claim filter only knows that it
 * did not match.
 * @param {string} code Normalised, valid code.
 * @param {string} discordId Who tried.
 * @returns {Promise<object>} `{reason, uuid, username}`.
 */
async function classifyMiss(code, discordId) {
    let doc = null;
    try {
        doc = await mongo.findLinkCode(code);
    } catch (error) {
        sessionLogger.warn(LOG, `Could not read back code ${code.slice(0, 2)}... after a failed claim`, error.message);
    }
    if (!doc) return { reason: 'unknown' };

    const username = doc.username || null;
    if (doc.usedAt) {
        const usedBy = doc.usedBy == null ? '' : String(doc.usedBy);
        if (usedBy === 'unlink') return { reason: 'revoked', username };
        if (usedBy !== String(discordId)) return { reason: 'used_other', username };
        // Their own code, a second time. Say "already linked" only when it is true.
        const player = doc.uuid ? await mongo.getBifrostPlayerByUuid(doc.uuid) : null;
        if (player && player.discord_id != null && String(player.discord_id) === String(discordId)) {
            return { reason: 'already', username: player.username || username };
        }
        return { reason: 'used_self', username };
    }
    const expiresAt = doc.expiresAt instanceof Date ? doc.expiresAt.getTime() : Date.parse(doc.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return { reason: 'expired', username };
    return { reason: 'unknown' };
}

/**
 * Writes one failure row. Never throws: a lost row must not cost the player the reply.
 * @param {object} input `{discordId, reason, code, via}`.
 * @returns {Promise<void>} Resolves when the write is done or has failed.
 */
async function logFailure(input) {
    sessionLogger.info(LOG, `Link failed for ${input.discordId}: ${input.reason} (via ${input.via || 'unknown'})`);
    try {
        await mongo.insertLinkFailure(buildLinkFailure(input));
    } catch (error) {
        sessionLogger.error(LOG, `Could not log a ${input.reason} link failure`, error.message);
    }
}

/**
 * The claim every door shares.
 * @param {object} input `{rawCode, interaction, via}`. `via` is 'command', 'modal' or a test name.
 * @returns {Promise<object>} `{reason, username, input}`; reason is 'linked', 'already' or
 *     one of FAILURES.
 */
async function claimLink(input) {
    const interaction = input.interaction;
    const user = interaction.user;
    const raw = input.rawCode == null ? '' : String(input.rawCode);
    const code = normalizeCode(raw);
    const via = input.via || null;

    let outcome;
    if (!isValidCode(code)) {
        outcome = { reason: 'format' };
    } else {
        outcome = await redeem(code, interaction, user);
    }

    outcome.input = raw;
    outcome.code = code;
    if (outcome.reason !== 'linked') {
        await logFailure({ discordId: user.id, reason: outcome.reason, code: code, via: via });
    }
    return outcome;
}

/**
 * Claim, check, write. Only called with a valid code.
 * @param {string} code Normalised code.
 * @param {object} interaction The guild interaction (the Verified role needs its guild).
 * @param {object} user `interaction.user`.
 * @returns {Promise<object>} `{reason, username}`.
 */
async function redeem(code, interaction, user) {
    // Claim first - one atomic write decides who holds this code.
    const codeDoc = await mongo.claimLinkCode(code, user.id);
    if (!codeDoc || !codeDoc.uuid) return classifyMiss(code, user.id);

    const player = await mongo.getBifrostPlayerByUuid(codeDoc.uuid);
    if (!player) return { reason: 'no_player', username: codeDoc.username || null };

    const username = player.username || codeDoc.username || 'your account';
    const result = await mongo.setBifrostDiscordLink(codeDoc.uuid, {
        discordId: user.id,
        discordName: user.username
    });

    if (result && result.matchedCount === 0) {
        // The account was linked between the claim and the write. Never overwrite it.
        const current = await mongo.getBifrostPlayerByUuid(codeDoc.uuid);
        const linkedTo = !current || current.discord_id == null ? null : String(current.discord_id);
        return { reason: linkedTo === String(user.id) ? 'already' : 'taken', username };
    }

    try {
        await mongo.insertLinkAudit(buildLinkAudit({
            uuid: codeDoc.uuid,
            discordId: user.id,
            action: 'link',
            discordName: user.username
        }));
    } catch (error) {
        // The link itself is already written - an audit row is not worth failing it.
        sessionLogger.error(LOG, `Could not audit the link for ${codeDoc.uuid}`, error.message);
    }

    await verifiedRole.addVerifiedRole(interaction, user.id);

    sessionLogger.info(LOG, `${user.username} linked ${username} (${codeDoc.uuid})`);
    return { reason: 'linked', username };
}

/**
 * What the player typed, safe to put inside a code span.
 * @param {string} raw Their entry.
 * @returns {string} Trimmed, backticks gone, cut short.
 */
function echo(raw) {
    const text = String(raw == null ? '' : raw).replace(/`/g, '').replace(/\s+/g, ' ').trim();
    return text.length > ECHO_MAX ? `${text.slice(0, ECHO_MAX)}...` : text;
}

/**
 * The reply for one outcome.
 * @param {object} outcome From claimLink.
 * @returns {object} `{content, components}` for editReply.
 */
function replyFor(outcome) {
    const name = outcome.username ? `**${outcome.username}**` : 'That account';
    const newCode = `Type \`/link\` in game for a new one.`;
    let content;
    switch (outcome.reason) {
        case 'linked':
            content = `✅ Linked to ${name}. No relog needed.`;
            break;
        case 'already':
            content = `✅ ${name} is already linked to this Discord.`;
            break;
        case 'format': {
            const shown = echo(outcome.input);
            content = `❌ ${shown ? `\`${shown}\` is` : 'That is'} not a link code. ` +
                `A code has ${CODE_LENGTH} letters and digits, like \`7KQ2MX\`. Check it and try again.`;
            break;
        }
        case 'unknown':
            content = `❌ No code \`${outcome.code}\` exists. Check the code in game and try again. ` +
                `Codes work for ${CODE_TTL_MINUTES} minutes. For an older code, type \`/link\` in game for a new one.`;
            break;
        case 'expired':
            content = `❌ That code expired. Codes work for ${CODE_TTL_MINUTES} minutes. ${newCode}`;
            break;
        case 'used_self':
            content = `❌ You already used this code. ${newCode}`;
            break;
        case 'used_other':
            content = `❌ Someone else already used this code. ${newCode} ` +
                'Do not post your code in a channel. Type it only in the Link account box.';
            break;
        case 'revoked':
            content = `❌ That code stopped working when the account was unlinked. ${newCode}`;
            break;
        case 'taken':
            content = `❌ ${name} is linked to another Discord account. Type \`/unlink\` in game first. ` +
                'Then type `/link` for a new code.';
            break;
        case 'no_player':
            content = '❌ That code points at an account the server no longer knows. Type `/link` in game again.';
            break;
        default:
            content = '❌ That did not work. Try again.';
    }
    return {
        content: content,
        components: FAILURES.has(outcome.reason) ? [buildOpenRow('Try again')] : []
    };
}

/**
 * The accounts one Discord holds, as a reply line. `/linked` and [My accounts] share it.
 * @param {string} discordId Discord snowflake.
 * @returns {Promise<string>} The reply text.
 */
async function accountsReply(discordId) {
    const mine = await mongo.findBifrostPlayersByDiscordId(discordId);
    if (mine.length === 0) {
        return 'No Minecraft accounts are linked to this Discord. Type `/link` in game to get a code. ' +
            `Then press **Link account** in <#${linkChannelId()}>.`;
    }

    const lines = mine
        .sort((a, b) => String(a.username || '').localeCompare(String(b.username || '')))
        .map(p => {
            const since = p.discord_linked_at
                ? ` — linked <t:${Math.floor(new Date(p.discord_linked_at).getTime() / 1000)}:R>`
                : '';
            return `• **${p.username || p.uuid}**${since}`;
        });

    return `Linked to this Discord:\n${lines.join('\n')}\n\nUse \`/unlink\` to remove one.`;
}

/**
 * Answers one of our buttons or the modal. The caller catches.
 * @param {object} interaction A button or modal-submit interaction that owns() said yes to.
 * @returns {Promise<void>} Resolves once the player has an answer.
 */
async function handleInteraction(interaction) {
    const id = interaction.customId;
    if (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit()) {
        if (id !== MODAL_ID) return;
        await interaction.deferReply({ ephemeral: true });
        const outcome = await claimLink({
            rawCode: interaction.fields.getTextInputValue(CODE_FIELD),
            interaction: interaction,
            via: 'modal'
        });
        await interaction.editReply(replyFor(outcome));
        return;
    }
    if (id === OPEN_ID) {
        // A modal has to be the first answer, so nothing is deferred before it.
        await interaction.showModal(buildModal());
        return;
    }
    if (id === MINE_ID) {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(await accountsReply(interaction.user.id));
    }
}

module.exports = {
    GUILD_ID,
    LINK_CHANNEL_ID,
    OPEN_ID,
    MINE_ID,
    MODAL_ID,
    CODE_FIELD,
    linkChannelId,
    buildModal,
    buildOpenRow,
    buildPanel,
    isPanelMessage,
    owns,
    claimLink,
    replyFor,
    accountsReply,
    handleInteraction
};
