/*
 * /link [code]
 *
 * The Discord half of the in-game /link flow. With a code it claims it at once; with no
 * code it opens the same code box the [Link account] button on the #link panel opens.
 * Both end in util/linkFlow.js, which holds the claim, the replies and the failure log.
 *
 * One Discord may hold several Minecraft accounts; one Minecraft account holds at most
 * one Discord (a second Discord has to wait for an in-game /unlink). Any member can run
 * it, replies are ephemeral, and the optional Verified role never fails a link.
 */

const { SlashCommandBuilder } = require('discord.js');
const { CODE_LENGTH } = require('./util/linkCode');
const linkFlow = require('./util/linkFlow');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your Discord to your Minecraft account with the code from /link in game')
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('code')
                .setDescription(`The ${CODE_LENGTH}-character code from /link in game. Leave it empty to open the code box.`)
                .setRequired(false)),

    async execute(interaction) {
        const code = interaction.options.getString('code');
        if (code == null || code.trim() === '') {
            // A modal has to be the first answer, so nothing is deferred before it.
            await interaction.showModal(linkFlow.buildModal());
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        const outcome = await linkFlow.claimLink({ rawCode: code, interaction: interaction, via: 'command' });
        await interaction.editReply(linkFlow.replyFor(outcome));
    },
};
