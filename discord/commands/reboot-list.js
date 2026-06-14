/*
 * /reboot-list
 *
 * Lists pending scheduled reboots (schedule_jobs, type scheduled_reboot). Staff-only.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reboot-list')
        .setDescription('List pending scheduled reboots')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply();

        const jobs = (await mongo.getActiveScheduleJobs('scheduled_reboot'))
            .sort((a, b) => a.fireAt - b.fireAt);

        if (jobs.length === 0) {
            await interaction.editReply('No pending scheduled reboots.');
            return;
        }

        const servers = await yggdrasil.getServers().catch(() => []);
        const instanceCount = (tag) => servers.filter(s => s.tag === tag).length;

        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle(`⏰ Pending Reboots (${jobs.length})`)
            .setTimestamp();

        for (const job of jobs.slice(0, 25)) {
            const unix = Math.floor(job.fireAt / 1000);
            const n = instanceCount(job.serverTag);
            const target = job.instanceServerId ? 'single instance' : (n > 1 ? `all ${n} instances` : 'whole server');
            const lines = [
                `Reboots <t:${unix}:R> (<t:${unix}:t>)`,
                `Target: ${target}`,
                `Warning window: ${job.warnWindow} min`,
                `By: ${job.requestedBy || 'unknown'}`,
            ];
            if (job.reason) lines.push(`Reason: ${job.reason}`);
            embed.addFields({ name: job.serverTag, value: lines.join('\n'), inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
    },
};
