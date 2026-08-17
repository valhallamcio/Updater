/*
 * /unlink [player]
 *
 * Drops a Discord <-> Minecraft link from the Discord side (the in-game /unlink does the
 * same from the other end). Players only ever unlink their own accounts; a member with
 * Manage Guild may unlink anyone's, which is how staff undo a mislink.
 *
 * The Verified role comes off once that Discord user has no linked accounts left.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const mongo = require('../../modules/mongo');
const sessionLogger = require('../../modules/sessionLogger');
const verifiedRole = require('./util/verifiedRole');
const { buildLinkAudit } = require('./util/linkCode');

/** Manage Guild is the staff bar - the same permission that edits the server itself. */
function isStaff(interaction) {
    try {
        const perms = interaction.memberPermissions || (interaction.member && interaction.member.permissions);
        return Boolean(perms && perms.has(PermissionFlagsBits.ManageGuild));
    } catch (_) {
        return false;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unlink')
        .setDescription('Unlink a Minecraft account from your Discord')
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('player')
                .setDescription('Which account (only needed when you have more than one linked)')
                .setRequired(false)
                .setAutocomplete(true)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'player') return;

        const mine = await mongo.findBifrostPlayersByDiscordId(interaction.user.id);
        const typed = String(focused.value || '').toLowerCase();
        const names = mine
            .map(p => p.username)
            .filter(Boolean)
            .filter(name => name.toLowerCase().startsWith(typed))
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 25);
        await interaction.respond(names.map(name => ({ name: name, value: name })));
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const wanted = interaction.options.getString('player');
        const mine = await mongo.findBifrostPlayersByDiscordId(interaction.user.id);

        let target = null;
        if (wanted) {
            target = mine.find(p => String(p.username || '').toLowerCase() === wanted.toLowerCase()) || null;
            if (!target && isStaff(interaction)) {
                const identity = await mongo.getPlayerIdentity(wanted);
                if (identity && identity.uuid && identity.discord_id != null) target = identity;
            }
            if (!target) {
                await interaction.editReply(`❌ **${wanted}** is not linked to your Discord account.`);
                return;
            }
        } else {
            if (mine.length === 0) {
                await interaction.editReply(
                    '❌ You have no linked Minecraft accounts — run `/link` in game to get a code.');
                return;
            }
            if (mine.length > 1) {
                const names = mine.map(p => `\`${p.username}\``).join(', ');
                await interaction.editReply(`❓ You have several accounts linked (${names}) — say which one: \`/unlink player:<name>\`.`);
                return;
            }
            target = mine[0];
        }

        const ownerId = String(target.discord_id);
        await mongo.unsetBifrostDiscordLink(target.uuid);

        try {
            // `actor` only lands when staff undid someone else's link (buildLinkAudit drops it otherwise).
            await mongo.insertLinkAudit(buildLinkAudit({
                uuid: target.uuid,
                discordId: ownerId,
                action: 'unlink',
                discordName: target.discord_name || null,
                actor: interaction.user.id
            }));
        } catch (error) {
            sessionLogger.error('DiscordLink', `Could not audit the unlink for ${target.uuid}`, error.message);
        }

        const remaining = await mongo.findBifrostPlayersByDiscordId(ownerId);
        if (remaining.length === 0) await verifiedRole.removeVerifiedRole(interaction, ownerId);

        sessionLogger.info('DiscordLink',
            `${interaction.user.username} unlinked ${target.username} (${target.uuid}) from ${ownerId}`);
        await interaction.editReply(`✅ **${target.username}** is no longer linked${ownerId === interaction.user.id ? '' : ` to <@${ownerId}>`}.`);
    },
};
