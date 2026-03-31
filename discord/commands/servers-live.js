const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const liveEmbedManager = require('../../modules/liveEmbedManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('servers-live')
        .setDescription('Creates an auto-updating server status embed (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        // Double-check permissions
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You need Administrator permissions to use this command.',
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            const serverList = await mongo.getServers();
            const yggdrasilServers = await yggdrasil.getServers();

            const embed = liveEmbedManager.generateServerEmbed(serverList, yggdrasilServers);

            // Send the embed
            const message = await interaction.editReply({
                embeds: [embed]
            });

            // Register the live embed for automatic updates
            await liveEmbedManager.registerEmbed(
                message.id,
                interaction.channel.id,
                interaction.guild.id,
                interaction.user.id
            );

            console.log(`Live embed created: ${message.id} by ${interaction.user.tag}`);

        } catch (error) {
            console.error('Error creating live embed:', error);
            const errorEmbed = new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle('❌ Error')
                .setDescription('Failed to create live server status embed. Please try again.')
                .setTimestamp();

            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    },
};
