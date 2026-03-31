/*
 * File: stats.js
 * Project: valhalla-updater
 * File Created: Thursday, 13th June 2024 4:33:34 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 13th June 2024 7:47:54 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */


const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');


module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Shows server stats!')
        .setDefaultMemberPermissions(8192),
    async execute(interaction) {
        const servers = await yggdrasil.getServers();

        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle('Server Stats')
            .setTimestamp()
            .setFooter({
                text: "Issues? Create a ticket!"
            });

        for (let s of servers) {
            if (s.status !== 'running') continue;

            const memMB = Math.round(s.memoryBytes / 1024 / 1024);
            const memLimitMB = Math.round(s.memoryLimitBytes / 1024 / 1024);
            const uptime = formatUptime(s.uptimeMs);

            embed.addFields({
                name: s.name,
                value: `**Uptime:** ${uptime}\n**Players:** ${s.players}\n**TPS:** ${Math.round(s.tps * 100) / 100}\n**Memory:** ${memMB}/${memLimitMB} MB`,
            });
        }

        return interaction.reply({
            embeds: [embed]
        });
    },
};

function formatUptime(ms) {
    if (!ms) return '0s';
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    let str = '';
    if (days) str += `${days}d `;
    if (hours) str += `${hours}h `;
    if (minutes) str += `${minutes}m `;
    if (secs || !str) str += `${secs}s`;
    return str.trim();
}
