/*
 * /reply <player> <text>
 *
 * Answers a player in game from Discord. Inserts a bifrost.mail doc; the proxy's change
 * stream delivers it inline when they are online, otherwise it waits in their inbox and
 * they read it with /mail on their next login. Staff-only.
 */

const { SlashCommandBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const { BODY_CAP, buildMailDoc } = require('./util/mailDoc');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reply')
        .setDescription('Send a player an in-game message from staff (delivered now or at their next login)')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('player')
                .setDescription('Player username')
                .setRequired(true)
                .setAutocomplete(true))
        .addStringOption(option =>
            option.setName('text')
                .setDescription(`What to tell them (max ${BODY_CAP} chars)`)
                .setRequired(true)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'player') return;
        const usernames = await mongo.searchPlayerUsernames(focused.value, 25);
        usernames.sort((a, b) => a.localeCompare(b));
        await interaction.respond(usernames.map(u => ({ name: u, value: u })));
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const player = interaction.options.getString('player');
        const text = interaction.options.getString('text');

        const identity = await mongo.getPlayerIdentity(player);
        if (!identity || !identity.uuid) {
            await interaction.editReply(`❌ No player named \`${player}\` — pick one from the autocomplete.`);
            return;
        }

        const built = buildMailDoc({
            toUuid: identity.uuid,
            toName: identity.username || player,
            fromName: interaction.user.username,
            discordId: interaction.user.id,
            text: text,
            now: new Date()
        });
        if (!built.ok) {
            await interaction.editReply(`❌ ${built.error}`);
            return;
        }

        await mongo.insertMail(built.doc);
        await interaction.editReply(
            `✅ Sent — **${built.doc.toName}** sees it in game (now if online, else at next login).`);
    },
};
