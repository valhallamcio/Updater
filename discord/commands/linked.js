/*
 * /linked
 *
 * Shows which Minecraft accounts this Discord holds. One Discord may hold several, so
 * this is also how someone finds the name to pass to /unlink.
 */

const { SlashCommandBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('linked')
        .setDescription('Show the Minecraft accounts linked to your Discord')
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const mine = await mongo.findBifrostPlayersByDiscordId(interaction.user.id);
        if (mine.length === 0) {
            await interaction.editReply(
                'No Minecraft accounts are linked to this Discord — run `/link` in game to get a code.');
            return;
        }

        const lines = mine
            .sort((a, b) => String(a.username || '').localeCompare(String(b.username || '')))
            .map(p => {
                const since = p.discord_linked_at
                    ? ` — linked <t:${Math.floor(new Date(p.discord_linked_at).getTime() / 1000)}:R>`
                    : '';
                return `• **${p.username || p.uuid}**${since}`;
            });

        await interaction.editReply(
            `Linked to this Discord:\n${lines.join('\n')}\n\nUse \`/unlink\` to remove one.`);
    },
};
