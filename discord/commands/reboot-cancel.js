/*
 * /reboot-cancel <server>
 *
 * Cancels a pending scheduled reboot (deactivates the schedule_jobs doc) and, if the warning
 * window is already running, signals rebootScheduler to abort before the server is stopped.
 * Handles instanced servers: a tag aborts every instance's countdown. Staff-only.
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
        const input = interaction.options.getString('server');

        const servers = await yggdrasil.getServers();
        // Accept a tag or a specific serverId; normalize to a tag.
        const byId = servers.find(s => s.serverId === input);
        const tag = byId ? byId.tag : input;

        const jobs = await mongo.getActiveScheduleJobs('scheduled_reboot');
        const job = jobs.find(j => j.serverTag && j.serverTag.toLowerCase() === tag.toLowerCase());

        // serverIds whose in-progress countdowns we must abort: the specific instance if the job
        // targeted one, else every instance of the tag.
        let instanceIds;
        if (job && job.instanceServerId) {
            instanceIds = [job.instanceServerId];
        } else {
            instanceIds = servers
                .filter(s => s.tag && s.tag.toLowerCase() === tag.toLowerCase())
                .map(s => s.serverId);
        }
        if (byId && !instanceIds.includes(byId.serverId)) instanceIds.push(byId.serverId);

        let cancelledPending = false;
        let abortedRunning = 0;
        let stampedDocs = 0;
        if (job) {
            await mongo.deactivateScheduleJob(job._id);
            cancelledPending = true;
        }
        for (const id of instanceIds) {
            // Belt and braces: the proxy shows a countdown for any open reboot_events doc, and one
            // can outlive this process' warning window (a VU restart mid-countdown). Stamp it even
            // when nothing is running here — and stamp it BEFORE cancelServerReboot, which fires the
            // same updateMany without awaiting it and would leave this count at 0 for a doc it won.
            stampedDocs += await mongo.cancelRebootEvents(id)
                .then(r => (r && r.modifiedCount) || 0)
                .catch(() => 0);
            if (rebootScheduler.cancelServerReboot(id)) abortedRunning++;
        }

        if (!cancelledPending && abortedRunning === 0 && stampedDocs === 0) {
            await interaction.editReply(`No pending or in-progress reboot found for \`${tag}\`.`);
            return;
        }

        const parts = [];
        if (cancelledPending) parts.push('pending schedule removed');
        if (abortedRunning > 0) parts.push(`${abortedRunning} in-progress countdown(s) aborted`);
        // Nothing in this process' memory, but the proxy was rendering a bar for the doc we just
        // stamped — telling staff "nothing found" while cancelling it is the report that lies.
        if (abortedRunning === 0 && stampedDocs > 0) parts.push(`${stampedDocs} proxy countdown(s) cancelled`);

        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle('🛑 Reboot Cancelled')
            .setDescription(`**${tag}** — ${parts.join(' + ')}.`)
            .setFooter({ text: `Cancelled by ${interaction.user.username}` })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    },
};
