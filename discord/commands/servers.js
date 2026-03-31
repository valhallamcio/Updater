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
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');



module.exports = {
    data: new SlashCommandBuilder()
        .setName('servers')
        .setDescription('Shows online servers!'),
    async execute(interaction) {
        const serverList = await mongo.getServers();
        const yggdrasilServers = await yggdrasil.getServers();

        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle('Server List')
            .setTimestamp()
            .setFooter({
                text: "To see players online use /online"
            });

        let onlineCount = 0;
        let serverCount = 0;

        let versionObj = {};

        for (let server of serverList) {
            if (server.excludeFromServerList) continue;
            serverCount++;

            if (!versionObj[server.server_version]) versionObj[server.server_version] = [];

            versionObj[server.server_version].push(server);
        }

        // Sort the versions in descending order
        const sortedVersions = Object.keys(versionObj).sort((a, b) => compareVersions(b, a));
        const excludedTags = ["BINGO", "ALP"];
        for (const key of sortedVersions) {
            let str = "";

            for (let s of versionObj[key]) {
                var statusEmoji = "<:c:1389899748370157609>";

                const ygServer = yggdrasilServers.find(y => y.name.trim() === s.name.trim());
                if (ygServer && ygServer.status === 'running') {
                    onlineCount++;
                    statusEmoji = "<:u:1389899745866027090>";
                }

                if (s.tag == "PLUS") statusEmoji = "";
                if (!excludedTags.includes(s.tag) && !s.early_access) {
                    str += `- **${s.tag.toUpperCase()} | ${s.name}** ${statusEmoji}\n ${s.tag.toLowerCase()}.valhallamc.io *(v.${s.modpack_version})*\n`;
                }
            }

            embed.addFields({
                name: `Minecraft ${key}`,
                value: str
            });
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