/*
 * File: servers.js
 * Project: valhalla-updater
 * File Created: Thursday, 13th June 2024 3:52:51 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 13th June 2024 4:28:21 pm
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
        .setName('servers')
        .setDescription('Shows online servers!'),
    async execute(interaction) {
        const serverList = await yggdrasil.getServers();

        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle('Server List')
            .setTimestamp()
            .setFooter({
                text: "To see players online use /online"
            });

        let onlineCount = 0;

        let versionObj = {};

        const seen = new Set();
        for (let server of serverList) {
            // Skip hidden AND early-access copies before claiming the tag — otherwise
            // an early-access copy ordered first would claim the tag in `seen`, then get
            // filtered out at display time, taking the whole pack down with it.
            if (server.excludeFromServerList || server.earlyAccess) continue;
            if (seen.has(server.tag)) continue;
            seen.add(server.tag);

            if (!versionObj[server.serverVersion]) versionObj[server.serverVersion] = [];

            versionObj[server.serverVersion].push(server);
        }

        // Sort the versions in descending order
        const sortedVersions = Object.keys(versionObj).sort((a, b) => compareVersions(b, a));
        const excludedTags = ["BINGO", "ALP"];
        for (const key of sortedVersions) {
            let str = "";

            for (let s of versionObj[key]) {
                var statusEmoji = "<:c:1389899748370157609>";

                if (s.status === 'running') {
                    onlineCount++;
                    statusEmoji = "<:u:1389899745866027090>";
                }

                if (s.tag == "PLUS") statusEmoji = "";
                if (!excludedTags.includes(s.tag) && !s.earlyAccess) {
                    str += `- **${s.tag.toUpperCase()} | ${s.name}** ${statusEmoji}\n ${s.tag.toLowerCase()}.valhallamc.io *(v.${s.modpackVersion})*\n`;
                }
            }

            if (str) {
                embed.addFields({
                    name: `Minecraft ${key}`,
                    value: str
                });
            }
        }

        embed.setDescription(`Servers online: ${onlineCount}`);

        return interaction.reply({
            embeds: [embed]
        });
    },
};

function compareVersions(a, b) {
    const versionA = a.split('.').map(Number);
    const versionB = b.split('.').map(Number);

    for (let i = 0; i < Math.max(versionA.length, versionB.length); i++) {
        if (versionA[i] === undefined) return -1;
        if (versionB[i] === undefined) return 1;

        if (versionA[i] < versionB[i]) return -1;
        if (versionA[i] > versionB[i]) return 1;
    }

    return 0;
}