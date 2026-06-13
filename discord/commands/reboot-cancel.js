/*
 * /reboot-cancel <server>
 *
 * Cancels a pending scheduled reboot (deactivates the schedule_jobs doc) and, if the warning
 * window is already running, signals rebootScheduler to abort before the server is stopped.
 * Staff-only.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const rebootScheduler = require('../../schedulers/rebootScheduler');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reboot-cancel')
        .setDescription('Cancel a pending or in-progress scheduled reboot')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('server')
                .setDescription('Server tag')
                .setRequired(true)
                .setAutocomplete(true)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const jobs = await mongo.getActiveScheduleJobs('scheduled_reboot');
        const now = Date.now();
        const choices = jobs.map(j => ({
            name: `${j.serverTag} (~${Math.max(0, Math.round((j.fireAt - now) / 60000))}m left)`.slice(0, 100),
            value: j.serverTag,
        })).filter(c => c.value.toLowerCase().includes(focused));
        await interaction.respond(choices.slice(0, 25));
    },

    async execute(interaction) {
        await interaction.deferReply();
        const tag = interaction.options.getString('server');

        const jobs = await mongo.getActiveScheduleJobs('scheduled_reboot');
        const job = jobs.find(j => j.serverTag && j.serverTag.toLowerCase() === tag.toLowerCase());

        // Resolve serverId for an in-progress abort even if the pending job was already consumed.
        let serverId = job ? job.serverId : null;
        if (!serverId) {
            const servers = await yggdrasil.getServers();
            const s = servers.find(sv => sv.tag && sv.tag.toLowerCase() === tag.toLowerCase());
            serverId = s ? s.serverId : null;
        }

        let cancelledPending = false;
        let abortedRunning = false;
        if (job) {
            await mongo.deactivateScheduleJob(job._id);
            cancelledPending = true;
        }
        if (serverId) {
            abortedRunning = rebootScheduler.cancelServerReboot(serverId);
        }

        if (!cancelledPending && !abortedRunning) {
            await interaction.editReply(`No pending or in-progress reboot found for \`${tag}\`.`);
            return;
        }

        const parts = [];
        if (cancelledPending) parts.push('pending schedule removed');
        if (abortedRunning) parts.push('in-progress countdown aborted');

        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle('🛑 Reboot Cancelled')
            .setDescription(`**${tag}** — ${parts.join(' + ')}.`)
            .setFooter({ text: `Cancelled by ${interaction.user.username}` })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    },
};
