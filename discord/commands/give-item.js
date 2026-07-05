/*
 * File: give-item.js
 * Project: valhalla-updater
 * -----
 * Give items to a player via the biforesting link (v2 phase 5). Offline targets
 * queue durably and fire on the player's next login. NBT items: use /execute /give
 * until the typed path lands with the item registry (phase 8).
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('give-item')
        .setDescription('Give items to a player via the server link!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
        .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
        .addStringOption(o => o.setName('id').setDescription('Item id (legacy meta as id@meta)').setRequired(true))
        .addIntegerOption(o => o.setName('count').setDescription('How many (default 1)'))
        .addStringOption(o => o.setName('overflow').setDescription('When inventory is full')
            .addChoices({ name: 'fail (default)', value: 'fail' }, { name: 'drop at feet', value: 'drop' }))
        .setDMPermission(false),

    async execute(interaction) {
        const player = interaction.options.getString('player');
        const server = interaction.options.getString('server');
        const params = { id: interaction.options.getString('id') };
        const count = interaction.options.getInteger('count');
        const overflow = interaction.options.getString('overflow');
        if (count) params.count = count;
        if (overflow) params.overflow = overflow;

        await interaction.deferReply();
        try {
            const doc = await yggdrasil.runOp(server, {
                type: 'give_item',
                params,
                target: { name: player }
            }, 15000);
            const res = doc.result?.data;
            if (doc.state === 'completed') {
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(0x2ecc71)
                        .setTitle(`Gave ${res?.given ?? '?'}× ${params.id} to ${res?.player ?? player}`)
                        .setDescription(res?.full ? '⚠️ Inventory filled up — gave a partial amount.' : null)]
                });
            } else if (doc.state === 'waiting_player') {
                await interaction.editReply(`📬 **${player}** is offline — queued, delivers on their next login (op \`${doc._id}\`).`);
            } else {
                await interaction.editReply(`Give ${doc.state}: ${doc.result?.error ?? 'see /ops'}`);
            }
        } catch (err) {
            // runOp times out while the op is parked waiting_player — that's the queued case
            if (String(err.message).includes('not terminal')) {
                await interaction.editReply(`📬 **${player}** is offline — queued, delivers on their next login.`);
                return;
            }
            await interaction.editReply(`❌ ${err.response?.data?.error?.message ?? err.message}`);
        }
    }
};
