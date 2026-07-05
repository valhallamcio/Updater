/*
 * File: remove-item.js
 * Project: valhalla-updater
 * -----
 * Remove items from a player via the biforesting link (v2 phase 5): dry-run first,
 * staff confirms the exact plan, apply cites the dry-run (server-side enforced).
 * Identical UX online/offline — an offline dry-run queues for the next login.
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const sessionLogger = require('../../modules/sessionLogger');

function planLines(result) {
    const removed = result?.removed || [];
    return removed.map(r => `\`${String(r.slot).padStart(3)}\` ${r.id} ×${r.removed}`).join('\n') || '*no matches*';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remove-item')
        .setDescription('Remove items from a player (dry-run + confirm)!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
        .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
        .addStringOption(o => o.setName('id').setDescription('Item id (legacy meta as id@meta)').setRequired(true))
        .addIntegerOption(o => o.setName('count').setDescription('How many (with mode exact/atMost)'))
        .addStringOption(o => o.setName('mode').setDescription('all (default) | exact | atMost')
            .addChoices({ name: 'all', value: 'all' }, { name: 'exact', value: 'exact' }, { name: 'atMost', value: 'atMost' }))
        .addStringOption(o => o.setName('slots').setDescription('main | armor | offhand | ender | all (default)'))
        .setDMPermission(false),

    async execute(interaction) {
        const player = interaction.options.getString('player');
        const server = interaction.options.getString('server');
        const params = { id: interaction.options.getString('id') };
        const count = interaction.options.getInteger('count');
        const mode = interaction.options.getString('mode');
        const slots = interaction.options.getString('slots');
        if (count) params.count = count;
        if (mode) params.countMode = mode;
        if (slots) params.slots = slots;

        await interaction.deferReply();

        let dryDoc;
        try {
            dryDoc = await yggdrasil.runOp(server, {
                type: 'remove_item',
                params,
                target: { name: player },
                flags: { dryRun: true }
            }, 15000);
        } catch (err) {
            await interaction.editReply(`⏳ Dry-run didn't finish (${err.message}) — player likely offline; it queued for their next login. Re-run once they're on.`);
            return;
        }
        if (dryDoc.state !== 'completed') {
            await interaction.editReply(`Dry-run ${dryDoc.state}${dryDoc.result?.error ? `: ${dryDoc.result.error}` : ''} — player offline queues for next login.`);
            return;
        }

        const plan = dryDoc.result?.data;
        const embed = new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle(`remove_item plan — ${plan?.player ?? player} on ${server}`)
            .setDescription(`Would remove **${plan?.totalRemoved ?? 0}** item(s):\n${planLines(plan)}`)
            .setFooter({ text: `dry-run ${dryDoc._id} — confirm within 15 min` });

        if (!plan || plan.totalRemoved === 0) {
            await interaction.editReply({ embeds: [embed.setColor(0x95a5a6)], components: [] });
            return;
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm').setLabel('Remove them').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        const msg = await interaction.editReply({ embeds: [embed], components: [row] });

        let press;
        try {
            press = await msg.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 120000
            });
        } catch {
            await interaction.editReply({ components: [] });
            return;
        }
        if (press.customId !== 'confirm') {
            await press.update({ embeds: [embed.setColor(0x95a5a6).setTitle('Cancelled')], components: [] });
            return;
        }
        await press.update({ components: [] });

        try {
            const applied = await yggdrasil.runOp(server, {
                type: 'remove_item',
                params,
                target: { name: player },
                confirmedFromDryRun: dryDoc._id
            }, 15000);
            const res = applied.result?.data;
            if (applied.state === 'completed') {
                await interaction.followUp({
                    embeds: [new EmbedBuilder().setColor(0x2ecc71)
                        .setTitle(`Removed ${res?.totalRemoved ?? '?'} item(s) from ${res?.player ?? player}`)
                        .setDescription(planLines(res))]
                });
            } else {
                await interaction.followUp(`Apply ${applied.state}: ${applied.result?.error ?? 'see /ops'}`);
            }
        } catch (err) {
            sessionLogger.error('RemoveItem', 'apply failed:', err.message);
            await interaction.followUp(`❌ Apply failed: ${err.response?.data?.error?.message ?? err.message}`);
        }
    }
};
