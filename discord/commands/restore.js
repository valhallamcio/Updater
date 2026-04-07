/*
 * File: restore.js
 * Project: Valhalla-Updater
 * File Created: Tuesday, 28th May 2024 7:47:30 pm
 * Author: flaasz
 * -----
 * Last Modified: Tuesday, 28th May 2024 8:58:28 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const fs = require('fs').promises; // Use promises with fs for consistency with async/await
const {
    SlashCommandBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const updater = require('../../managers/updateManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('restore')
        .setDescription('Restores an update from the backup!')
        .setDefaultMemberPermissions(0)
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('server')
            .setDescription('Server to restore')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(option =>
            option.setName('backup')
            .setDescription('Backup to restore')
            .setRequired(true)
            .setAutocomplete(true)),
    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused(true);
        const serverList = await yggdrasil.getServers();
        let choices = [];

        if (focusedValue.name === "server") {
            const updates = await fs.readdir("./vault");

            const serverUpdatesList = serverList.filter(obj => {
                return updates.includes(obj.tag);
            });

            for (const server of serverUpdatesList) {
                choices.push(server.name);
            }
        }

        if (focusedValue.name === "backup") {
            const serverName = interaction.options.getString('server');
            if (serverName) {
                let serverTag = serverList.find(obj => obj.name === serverName).tag;
                const backups = await fs.readdir(`./vault/${serverTag}`);
                choices = backups;
            }
        }

        const filtered = choices.filter(choice => choice.startsWith(focusedValue.value));
        await interaction.respond(
            filtered.map(choice => ({
                name: choice,
                value: choice
            })),
        );
    },

    async execute(interaction) {
        await interaction.deferReply();
        const query = interaction.options.getString('server');
        const backup = interaction.options.getString('backup');
        const serverList = await yggdrasil.getServers();
        await interaction.editReply("Update manager is starting...");

        const message = await interaction.fetchReply();

        const server = serverList.find(server => server.name === query || server.tag === query.toLowerCase());
        if (!server) {
            await message.edit(`Server **${query}** not found!`);
            return;
        }

        const backupList = await fs.readdir(`./vault/${server.tag}`);
        if (!backupList.includes(backup)) {
            await message.edit(`Backup **${backup}** not found for server **${server.name}**.`);
            return;
        }

        let time = Date.now();

        await updater.restore(server, backup, message);

        await message.reply(`Done! This restoration took ${((Date.now()-time)/1000/60).toFixed(2)} minutes.`);

    },
};