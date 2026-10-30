/*
 * /quiet-slots
 *
 * Dry run of the quietest-moment daily reboots (modules/quietSlots): the stop slot each server
 * would get today and why, read from Prometheus player history. Changes nothing, also when
 * the feature is off. Staff-only.
 */

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const quietSlots = require('../../modules/quietSlots');
const rebootScheduler = require('../../schedulers/rebootScheduler');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('quiet-slots')
        .setDescription('Dry run: the quietest reboot slot per server from player history')
        .addStringOption(option =>
            option.setName('window')
                .setDescription('Allowed stop window in GMT+3, e.g. 05:00-12:00 (default: the config window)')
                .setRequired(false))
        .setDefaultMemberPermissions(16)
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const raw = { ...((rebootScheduler.runtimeConfig && rebootScheduler.runtimeConfig.quietSlots) || {}) };
        const window = interaction.options.getString('window');
        if (window) raw.window = window;
        const cfg = quietSlots.config(raw);

        const servers = (await yggdrasil.getServers()).filter(s => s && s.serverId && rebootScheduler.shouldRebootServer(s));
        let history = null;
        let error = null;
        try {
            history = await quietSlots.fetchHistory(cfg);
        } catch (e) {
            error = e.message;
        }
        const text = quietSlots.format(quietSlots.plan(servers, history, cfg, error), cfg);
        const planned = text.split('\n').filter(line => / stop \d\d:\d\d,/.test(line)).length;
        const state = cfg.enabled ? 'on' : 'off (dry run only)';
        const file = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: 'quiet-slots.txt' });
        await interaction.editReply({
            content: `Quiet slots are ${state}. ${planned} of ${servers.length} servers get a slot; the rest keep the fixed batch.` +
                (error ? `\nPrometheus: ${error}` : ''),
            files: [file],
        });
    },
};
