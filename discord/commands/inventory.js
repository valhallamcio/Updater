/*
 * File: inventory.js
 * Project: valhalla-updater
 * -----
 * Player inventory via the biforesting link (v2 phase 4): live inspect op when the
 * server is linked, newest stored snapshot (marked stale) when it isn't.
 */

const {
    SlashCommandBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const sessionLogger = require('../../modules/sessionLogger');
const { buildInventoryEmbed } = require('./util/inventoryEmbed');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inventory')
        .setDescription('Show a player\'s inventory via the server link!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(option =>
            option.setName('player')
            .setDescription('Player name or UUID')
            .setRequired(true))
        .addStringOption(option =>
            option.setName('server')
            .setDescription('Server tag or id')
            .setRequired(true))
        .setDMPermission(false),

    async execute(interaction) {
        const player = interaction.options.getString('player');
        const server = interaction.options.getString('server');
        await interaction.deferReply();

        let data;
        try {
            data = await yggdrasil.getPlayerInventory(server, player);
        } catch (err) {
            const msg = err.response?.status === 404
                ? `No inventory found for **${player}** on **${server}** (never linked/snapshotted).`
                : `❌ ${err.message}`;
            await interaction.editReply(msg);
            return;
        }

        const built = buildInventoryEmbed(data, player, server);
        if (!built) {
            await interaction.editReply(`❌ Empty response for **${player}** on **${server}**.`);
            return;
        }

        try {
            await interaction.editReply({ embeds: [built.embed] });
        } catch (err) {
            sessionLogger.error('Inventory', 'Failed to send embed:', err.message);
            await interaction.editReply(`❌ Embed too large — ${built.itemCount} items. (${err.message})`);
        }
    }
};
