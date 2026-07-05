/*
 * File: rescue.js
 * Project: valhalla-updater
 * -----
 * Crash-on-login rescue via the biforesting link (v2 phase 5): teleport-to-spawn op.
 * Offline (the usual case — they can't stay logged in) queues durably and fires the
 * moment they next join, yanking them to spawn before the crash area loads them again.
 */

const {
    SlashCommandBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rescue')
        .setDescription('Teleport a player to spawn (crash-on-login rescue)!')
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
                await interaction.editReply(`🛟 **${player}** teleported to spawn on **${server}**.`);
            } else if (doc.state === 'waiting_player') {
                await interaction.editReply(`🛟 **${player}** is offline — rescue armed, fires the moment they join **${server}** (op \`${doc._id}\`).`);
            } else {
                await interaction.editReply(`Rescue ${doc.state}: ${doc.result?.error ?? 'see /ops'}`);
            }
        } catch (err) {
            if (String(err.message).includes('not terminal')) {
                await interaction.editReply(`🛟 **${player}** is offline — rescue armed, fires the moment they join **${server}**.`);
                return;
            }
            await interaction.editReply(`❌ ${err.response?.data?.error?.message ?? err.message}`);
        }
    }
};
