/*
 * /reboot <server> <minutes> [reason]
 *
 * Schedules a reboot of a server (ALL its instances) with version-aware player warnings.
 * `minutes` is the time until reboot; the warning countdown spans min(minutes, maxWarnWindow).
 * Terse by design: `/reboot server:PRI minutes:5` = reboot PRI in 5 minutes.
 *
 * Instanced servers share a tag but have distinct serverIds (e.g. pri -> "Project Infinity 0.1"
 * + "Project Innfinity #2"). A tag target reboots every instance; picking a specific instance
 * from autocomplete (value = serverId) reboots just that one.
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
                .setDescription('Server tag (reboots all instances) or a specific instance')
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
        const byTag = new Map();
        for (const s of servers) {
            if (!s.tag) continue;
            if (!byTag.has(s.tag)) byTag.set(s.tag, []);
            byTag.get(s.tag).push(s);
        }
        const choices = [];
        for (const [tag, insts] of byTag) {
            const ver = insts[0].serverVersion || '?';
            if (insts.length > 1) {
                choices.push({ name: `${tag} — all ${insts.length} instances (${ver})`.slice(0, 100), value: tag });
                for (const s of insts) {
                    choices.push({ name: `  ↳ ${tag}: ${s.name}`.slice(0, 100), value: s.serverId });
                }
            } else {
                choices.push({ name: `${tag} — ${insts[0].name} (${ver})`.slice(0, 100), value: tag });
            }
        }
        const filtered = choices.filter(c =>
            c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused));
        await interaction.respond(filtered.slice(0, 25));
    },

    async execute(interaction) {
        await interaction.deferReply();

        const input = interaction.options.getString('server');
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') || null;

        const servers = await yggdrasil.getServers();

        // Resolve target(s): a specific serverId -> one instance; otherwise a tag -> ALL instances.
        let instances = [];
        let instanceServerId = null;
        const byId = servers.find(s => s.serverId === input);
        if (byId) {
            instances = [byId];
            instanceServerId = byId.serverId;
        } else {
            instances = servers.filter(s => s.tag && s.tag.toLowerCase() === input.toLowerCase());
            if (!instances.length) {
                const byName = servers.find(s => s.name && s.name.toLowerCase() === input.toLowerCase());
                if (byName) instances = servers.filter(s => s.tag === byName.tag);
            }
        }
        if (!instances.length) {
            await interaction.editReply(`❌ No server matching \`${input}\`.`);
            return;
        }
        const tag = instances[0].tag;

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

        // One pending reboot per tag at a time.
        const existing = (await mongo.getActiveScheduleJobs('scheduled_reboot'))
            .find(j => j.serverTag === tag);
        if (existing) {
            await interaction.editReply(
                `⚠️ **${tag}** already has a pending reboot <t:${Math.floor(existing.fireAt / 1000)}:R>. ` +
                `Cancel it first with \`/reboot-cancel server:${tag}\`.`);
            return;
        }

        await mongo.createScheduleJob({
            type: 'scheduled_reboot',
            serverTag: tag,
            instanceServerId,            // null => reboot ALL instances of the tag at fire time
            serverId: instances[0].serverId,
            fireAt,
            warnWindow,
            reason,
            requestedBy: interaction.user.tag || interaction.user.username,
            requestedById: interaction.user.id,
        });

        const ver = instances[0].serverVersion;
        const tier = rebootAlerts.tierFor(ver);
        const targetText = instanceServerId
            ? `${instances[0].name} \`(single instance)\``
            : instances.length > 1
                ? `**all ${instances.length} instances** — ${instances.map(s => s.name).join(', ')}`
                : instances[0].name;

        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('⏰ Reboot Scheduled')
            .addFields(
                { name: 'Server', value: `${targetText} (\`${tag}\`)`, inline: false },
                { name: 'Version', value: `${ver || 'unknown'} \`${tier}\``, inline: true },
                { name: 'Reboots', value: `<t:${fireUnix}:R> — <t:${fireUnix}:t>`, inline: true },
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
