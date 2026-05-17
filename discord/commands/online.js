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

            const instances = Object.entries(instanceMap).map(([instanceKey, usernames]) => {
                const matched = allTagServers.find(s =>
                    s.name === instanceKey || s.id === instanceKey || s.serverId === instanceKey
                );
                return {
                    name: matched ? matched.name : (instanceKey === '_default' ? serv.name : instanceKey),
                    players: usernames
                };
            });

            tagGroups[tag] = { mainName: serv.name, instances, domain: `*${tag.toLowerCase()}.valhallamc.io*` };
            onlineCount += players.length;
        }

        const platformGroupKeys = ['gregtechnewhorizons'];
        for (const platform of platformGroupKeys) {
            const matchingTags = Object.keys(tagGroups).filter(tag => {
                const serv = servers.find(s => s.tag === tag);
                return serv && serv.platform === platform;
            });
            if (matchingTags.length <= 1) continue;

            const mergedInstances = [];
            const domains = [];
            let mainName = null;
            for (const tag of matchingTags) {
                if (!mainName) mainName = tagGroups[tag].mainName;
                mergedInstances.push(...tagGroups[tag].instances);
                domains.push(tagGroups[tag].domain);
                delete tagGroups[tag];
            }
            tagGroups[`__platform_${platform}`] = {
                mainName,
                instances: mergedInstances,
                domain: domains.join(' · ')
            };
        }

        for (const [key, group] of Object.entries(tagGroups)) {
            const totalPlayers = group.instances.reduce((sum, i) => sum + i.players.length, 0);
            const domain = group.domain;

            if (group.instances.length === 1) {
                const inst = group.instances[0];
                embed.addFields({
                    name: `${inst.name} - **${inst.players.length}**`,
                    value: `${formatPlayers(inst.players)}\n${domain}`
                });
            } else {
                const mainInst = group.instances.find(i => i.name === group.mainName);
                const otherInsts = group.instances.filter(i => i !== mainInst);

                let value = '';
                if (mainInst) {
                    value += `${formatPlayers(mainInst.players)}\n`;
                }
                for (const inst of otherInsts) {
                    value += `-# ${inst.name} - ${inst.players.length}\n`;
                    value += `${formatPlayers(inst.players)}\n`;
                }
                value += domain;

                embed.addFields({
                    name: `${group.mainName} - **${totalPlayers}**`,
                    value: value
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