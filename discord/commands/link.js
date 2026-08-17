/*
 * /link code:<code>
 *
 * The Discord half of the in-game /link flow: the proxy mints a 6-character code and
 * shows it on a card, the player brings it here, and this writes the link onto their
 * bifrost.players doc. The proxy watches that collection, so the confirmation card
 * lands in game about a second later.
 *
 * One Discord may hold several Minecraft accounts; one Minecraft account holds at most
 * one Discord (a second Discord has to wait for an in-game /unlink). Any member can run
 * it, replies are ephemeral, and the optional Verified role never fails a link.
 *
 * The code is CLAIMED before anything else: reading it first and burning it after let two
 * Discords redeeming the same code both pass the check and both write the player. The
 * write is guarded the same way, so an in-game link landing in between loses the race
 * rather than getting overwritten - a refusal spends the code, and the player just runs
 * /link in game again.
 */

const { SlashCommandBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const sessionLogger = require('../../modules/sessionLogger');
const { CODE_LENGTH, normalizeCode, isValidCode, buildLinkAudit } = require('./util/linkCode');
const verifiedRole = require('./util/verifiedRole');

const BAD_CODE = '❌ That code is not valid or has expired — run `/link` in game for a fresh one.';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your Discord to your Minecraft account with the code from /link in game')
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('code')
                .setDescription(`The ${CODE_LENGTH}-character code the proxy showed you in game`)
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const code = normalizeCode(interaction.options.getString('code'));
        if (!isValidCode(code)) {
            await interaction.editReply(BAD_CODE);
            return;
        }

        // Claim first - one atomic write decides who holds this code.
        const codeDoc = await mongo.claimLinkCode(code, interaction.user.id);
        if (!codeDoc || !codeDoc.uuid) {
            await interaction.editReply(BAD_CODE);
            return;
        }

        const player = await mongo.getBifrostPlayerByUuid(codeDoc.uuid);
        if (!player) {
            await interaction.editReply(
                '❌ That code points at an account the proxy no longer knows — run `/link` in game again.');
            return;
        }

        const username = player.username || codeDoc.username || 'your account';

        const result = await mongo.setBifrostDiscordLink(codeDoc.uuid, {
            discordId: interaction.user.id,
            discordName: interaction.user.username
        });

        if (result && result.matchedCount === 0) {
            // The account was linked between the claim and the write. Never overwrite it -
            // the code is spent either way, so say what to do about it.
            const current = await mongo.getBifrostPlayerByUuid(codeDoc.uuid);
            const linkedTo = !current || current.discord_id == null ? null : String(current.discord_id);
            if (linkedTo === interaction.user.id) {
                await interaction.editReply(`✅ **${username}** is already linked to this Discord account.`);
                return;
            }
            await interaction.editReply(
                `❌ **${username}** is linked to another Discord account — run \`/unlink\` in game first, then \`/link\` again for a fresh code.`);
            return;
        }

        try {
            await mongo.insertLinkAudit(buildLinkAudit({
                uuid: codeDoc.uuid,
                discordId: interaction.user.id,
                action: 'link',
                discordName: interaction.user.username
            }));
        } catch (error) {
            // The link itself is already written - an audit row is not worth failing it.
            sessionLogger.error('DiscordLink', `Could not audit the link for ${codeDoc.uuid}`, error.message);
        }

        await verifiedRole.addVerifiedRole(interaction, interaction.user.id);

        sessionLogger.info('DiscordLink', `${interaction.user.username} linked ${username} (${codeDoc.uuid})`);
        await interaction.editReply(`✅ Linked to **${username}** — you'll see it in game.`);
    },
};
