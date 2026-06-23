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
            // A tag can have several docs (supporter-split packs ship a hidden
            // `...SUP` early-access copy alongside the public copy). Pick the
            // PUBLIC copy as the tag's face — never let an early-access/excluded
            // copy represent the tag, or `find()` ordering would drop the whole
            // pack (and every player on it) from /online.
            const tagServers = servers.filter(s => s.tag === tag);
            // Prefer a fully-public copy as the pack's face; fall back to any
            // non-supporter copy (so an `excludeFromServerList`-only pack like gtff
            // stays visible on /online, matching prior behavior). Only a pack whose
            // every copy is early-access has no public face and is skipped.
            const serv = tagServers.find(s => !s.earlyAccess && !s.excludeFromServerList)
                || tagServers.find(s => !s.earlyAccess);
            if (!serv) continue; // every copy is early-access — genuinely hidden pack

            const domain = `${tag.toLowerCase()}.valhallamc.io`;

            // Group players by instance, but fold early-access / excluded instances
            // into the public pack name: supporter players still count as online,
            // the supporter instance name stays hidden on Discord.
            const instanceMap = {};
            for (const player of players) {
                const key = player.instance || '_default';
                const doc = tagServers.find(s =>
                    s.name === key || s.id === key || s.serverId === key
                );
                const displayName = (!doc || doc.earlyAccess || doc.excludeFromServerList)
                    ? serv.name
                    : doc.name;
                if (!instanceMap[displayName]) instanceMap[displayName] = [];
                instanceMap[displayName].push(player.username);
            }

            const instances = Object.entries(instanceMap).map(([name, usernames]) => ({
                name,
                players: usernames,
                domain
            }));

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