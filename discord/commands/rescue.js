/*
 * File: rescue.js
 * Project: valhalla-updater
 * -----
 * Crash-on-login rescue via the biforesting link (v2 phase 5): teleport-to-spawn op
 * PLUS an inventory inspect so staff can see what they're carrying while diagnosing.
 * Offline (the usual case — they can't stay logged in) queues durably and fires the
 * moment they next join, yanking them to spawn before the crash area loads them again.
 */

const {
    SlashCommandBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const { buildInventoryEmbed } = require('./util/inventoryEmbed');

/** Best-effort inventory attach — the rescue result stands on its own if this fails. */
async function inventoryEmbeds(server, player) {
    try {
        const data = await yggdrasil.getPlayerInventory(server, player);
        const built = buildInventoryEmbed(data, player, server);
        return built ? [built.embed] : [];
    } catch (err) {
        return [];
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rescue')
        .setDescription('Teleport a player to spawn (crash-on-login rescue) + show their inventory!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
        .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
        .setDMPermission(false),

    async execute(interaction) {
        const player = interaction.options.getString('player');
        const server = interaction.options.getString('server');
        await interaction.deferReply();
        try {
            const doc = await yggdrasil.runOp(server, {
                type: 'teleport',
                params: { mode: 'spawn' },
                target: { name: player }
            }, 12000);
            if (doc.state === 'completed') {
                await interaction.editReply({
                    content: `🛟 **${player}** teleported to spawn on **${server}**.`,
                    embeds: await inventoryEmbeds(server, player)
                });
            } else {
                await interaction.editReply(`Rescue ${doc.state}: ${doc.result?.error ?? 'see /ops'}`);
            }
        } catch (err) {
            if (String(err.message).includes('not terminal')) {
                // parked as waiting_player — show the newest (stale) snapshot alongside
                await interaction.editReply({
                    content: `🛟 **${player}** is offline — rescue armed, fires the moment they join **${server}**.`,
                    embeds: await inventoryEmbeds(server, player)
                });
                return;
            }
            await interaction.editReply(`❌ ${err.response?.data?.error?.message ?? err.message}`);
        }
    }
};
