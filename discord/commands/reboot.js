/*
 * /reboot <server> <minutes> [reason]
 *
 * Schedules a reboot of one server with version-aware player warnings. `minutes` is the
 * time until reboot; the warning countdown spans min(minutes, maxWarnWindow). Terse by design:
 * `/reboot server:PRI minutes:5` = reboot PRI in 5 minutes.
 *
 * Writes a one-shot job to schedule_jobs (type: scheduled_reboot); scheduledRebootScheduler
 * fires it and rebootScheduler renders the alerts. Staff-only.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const rebootAlerts = require('../../modules/rebootAlerts');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reboot')
        .setDescription('Schedule a server reboot with player warnings (e.g. /reboot PRI 5)')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('server')
                .setDescription('Server tag to reboot')
                .setRequired(true)
                .setAutocomplete(true))
        .addIntegerOption(option =>
            option.setName('minutes')
                .setDescription('Minutes until reboot (0 = now). Players are warned over this window.')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(1440))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Optional reason (shown to staff)')
                .setRequired(false)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const servers = await yggdrasil.getServers();
        const choices = servers
            .filter(s => s.tag && !s.excludeFromServerList)
            .map(s => ({
                name: `${s.tag} — ${s.name} (${s.serverVersion || '?'})`.slice(0, 100),
                value: s.tag,
            }))
            .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused));
        await interaction.respond(choices.slice(0, 25));
    },

    async execute(interaction) {
        await interaction.deferReply();

        const tag = interaction.options.getString('server');
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') || null;

        const servers = await yggdrasil.getServers();
        const server = servers.find(s => s.tag && s.tag.toLowerCase() === tag.toLowerCase())
            || servers.find(s => s.name && s.name.toLowerCase() === tag.toLowerCase());

        if (!server) {
            await interaction.editReply(`❌ No server matching \`${tag}\`.`);
            return;
        }

        // The warning countdown can't exceed the configured max window; longer waits just idle
        // until the last `warnWindow` minutes.
        let maxWin = 15;
        try {
            const config = require('../../config/config.json');
            const ac = config.scheduler && config.scheduler.rebootScheduler && config.scheduler.rebootScheduler.playerAlerts;
            if (ac && ac.maxWarnWindowMinutes != null) maxWin = ac.maxWarnWindowMinutes;
        } catch (_) { /* use default */ }
        const warnWindow = Math.min(minutes, maxWin);
        const fireAt = Date.now() + minutes * 60000;
        const fireUnix = Math.floor(fireAt / 1000);

        // One pending reboot per server at a time.
        const existing = (await mongo.getActiveScheduleJobs('scheduled_reboot'))
            .find(j => j.serverTag === server.tag);
        if (existing) {
            await interaction.editReply(
                `⚠️ **${server.tag}** already has a pending reboot <t:${Math.floor(existing.fireAt / 1000)}:R>. ` +
                `Cancel it first with \`/reboot-cancel server:${server.tag}\`.`);
            return;
        }

        await mongo.createScheduleJob({
            type: 'scheduled_reboot',
            serverTag: server.tag,
            serverId: server.serverId,
            fireAt,
            warnWindow,
            reason,
            requestedBy: interaction.user.tag || interaction.user.username,
            requestedById: interaction.user.id,
        });

        const tier = rebootAlerts.tierFor(server.serverVersion);
        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('⏰ Reboot Scheduled')
            .addFields(
                { name: 'Server', value: `${server.name || server.tag} (\`${server.tag}\`)`, inline: true },
                { name: 'Version', value: `${server.serverVersion || 'unknown'} \`${tier}\``, inline: true },
                { name: 'Reboots', value: `<t:${fireUnix}:R> — <t:${fireUnix}:t>`, inline: false },
                { name: 'Warning window', value: `${warnWindow} min`, inline: true },
            )
            .setFooter({ text: `Scheduled by ${interaction.user.username}` })
            .setTimestamp();
        if (reason) embed.addFields({ name: 'Reason', value: reason, inline: false });
        if (minutes > warnWindow) {
            embed.addFields({ name: 'Note', value: `Players are warned only for the final ${warnWindow} min.`, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
    },
};
