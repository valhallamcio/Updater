/*
 * File: online.js
 * Project: valhalla-updater
 * File Created: Thursday, 13th June 2024 3:22:15 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 13th June 2024 10:40:52 pm
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
        .setName('online')
        .setDescription('Shows online players!'),
    async execute(interaction) {
        await interaction.deferReply();
        const servers = await yggdrasil.getServers();
        const rawData = await yggdrasil.getPlayersDetailed();

        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTimestamp()
            .setFooter({ text: "To see all available servers use /servers" });

        let onlineCount = 0;

        const tagGroups = {};
        for (const [tag, players] of Object.entries(rawData)) {
            if (players.length === 0) continue;
            const serv = servers.find(s => s.tag === tag);
            if (!serv || serv.earlyAccess) continue;

            const instanceMap = {};
            for (const player of players) {
                const key = player.instance || '_default';
                if (!instanceMap[key]) instanceMap[key] = [];
                instanceMap[key].push(player.username);
            }

            const allTagServers = servers.filter(s => s.tag === tag && !s.earlyAccess);

            const domain = `${tag.toLowerCase()}.valhallamc.io`;
            const instances = Object.entries(instanceMap).map(([instanceKey, usernames]) => {
                const matched = allTagServers.find(s =>
                    s.name === instanceKey || s.id === instanceKey || s.serverId === instanceKey
                );
                return {
                    name: matched ? matched.name : (instanceKey === '_default' ? serv.name : instanceKey),
                    players: usernames,
                    domain
                };
            });

            tagGroups[tag] = { mainName: serv.name, instances };
            onlineCount += players.length;
        }

        const platformGroups = {
            'gregtechnewhorizons': 'GregTech: New Horizons'
        };
        for (const [platform, displayName] of Object.entries(platformGroups)) {
            const matchingTags = Object.keys(tagGroups).filter(tag => {
                const serv = servers.find(s => s.tag === tag);
                return serv && serv.platform === platform;
            });
            if (matchingTags.length <= 1) continue;

            const mergedInstances = [];
            for (const tag of matchingTags) {
                mergedInstances.push(...tagGroups[tag].instances);
                delete tagGroups[tag];
            }
            tagGroups[`__platform_${platform}`] = {
                mainName: displayName,
                instances: mergedInstances
            };
        }

        for (const group of Object.values(tagGroups)) {
            const totalPlayers = group.instances.reduce((sum, i) => sum + i.players.length, 0);

            if (group.instances.length === 1) {
                const inst = group.instances[0];
                embed.addFields({
                    name: `${inst.name} - **${inst.players.length}**`,
                    value: `-# ${formatPlayers(inst.players)}\n*${inst.domain}*`
                });
            } else {
                let value = '';
                for (const inst of group.instances) {
                    value += `${inst.name} · ${inst.players.length} · ${inst.domain}\n`;
                    value += `-# ${formatPlayers(inst.players)}\n`;
                }

                embed.addFields({
                    name: `${group.mainName} - **${totalPlayers}**`,
                    value: value.trimEnd()
                });
            }
        }

        if (onlineCount === 0) {
            embed.addFields({
                name: `**Oops**`,
                value: `Looks like the servers are empty :c`
            });
        }

        embed.setTitle(`Players online: ${onlineCount}`);
        return await interaction.editReply({ embeds: [embed] });
    },
};

function formatPlayers(players) {
    return players.join(', ').replace(/_/g, '\\_');
}