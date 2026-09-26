/*
 * /linked
 *
 * Shows which Minecraft accounts this Discord holds. One Discord may hold several, so
 * this is also how someone finds the name to pass to /unlink. The [My accounts] button
 * on the #link panel gives the same answer.
 */

const { SlashCommandBuilder } = require('discord.js');
const linkFlow = require('./util/linkFlow');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('linked')
        .setDescription('Show the Minecraft accounts linked to your Discord')
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(await linkFlow.accountsReply(interaction.user.id));
    },
};
