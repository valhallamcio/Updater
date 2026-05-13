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

        let data = await yggdrasil.getPlayers();

        //console.log(data);

        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTimestamp()
            .setFooter({
                text: "To see all available servers use /servers"
            });

        let onlineCount = 0;



        for (let server in data) {
            const fullName = server;
            let serv = servers.find(s => s.tag === server || s.name.trim() === server);
            let onlinePlayerCount = data[server].length;
            onlineCount += onlinePlayerCount;

            if (onlinePlayerCount > 0) {
                if (serv && serv.tag && !serv.earlyAccess) {
                    let tag = serv.tag;
                    embed.addFields({
                        name: `**[${tag.toUpperCase()}]** ${fullName} - **${onlinePlayerCount}**`,
                        value: `${data[server].toString().replace(/,/g, ", ").replace(/_/g, "\\_")}\n*${tag.toLowerCase()}.valhallamc.io*`
                    });
                } else {
                    embed.addFields({
                        name: `${fullName} - **${onlinePlayerCount}**`,
                        value: `${data[server].toString().replace(/,/g, ", ").replace(/_/g, "\\_")}`
                    });
                }
            }
        }


        if (onlineCount == 0) {
            embed.addFields({
                name: `**Oops**`,
                value: `Looks like the servers are empty :c`
            });
        }

        embed.setTitle(`Players online: ${onlineCount}`);
        //embed.setDescription(`Servers online: ${serverCount}`);

        return await interaction.editReply({
            embeds: [embed]
        });

    },
};