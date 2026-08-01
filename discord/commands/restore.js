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

/**
 * Lists the backups available for a pack tag: the per-instance archives written by
 * updates, plus any legacy shared archive sitting directly in the vault folder.
 * Only .tar.gz entries count - the vault also holds a per-server/ snapshot directory,
 * which used to show up in the picker as if it were a restorable backup.
 * @param {string} tag Pack tag.
 * @returns {Promise<Array>} Sorted, de-duplicated backup file names.
 */
async function listBackups(tag) {
    const names = new Set();

    for (const entry of await fs.readdir(`./vault/${tag}`, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.tar.gz')) names.add(entry.name);
    }

    try {
        const instancesRoot = `./vault/${tag}/instances`;
        for (const serverId of await fs.readdir(instancesRoot)) {
            for (const file of await fs.readdir(`${instancesRoot}/${serverId}`)) {
                if (file.endsWith('.tar.gz')) names.add(file);
            }
        }
    } catch (error) {
        // No per-instance backups for this tag yet
    }

    return [...names].sort();
}

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
            const seen = new Set();

            // One entry per tag - a multi-instance pack restores all of its instances together
            for (const server of serverList) {
                if (updates.includes(server.tag) && !seen.has(server.tag)) {
                    seen.add(server.tag);
                    choices.push({
                        name: `${server.tag.toUpperCase()} | ${server.name}`,
                        value: server.tag
                    });
                }
            }
        }

        if (focusedValue.name === "backup") {
            const query = interaction.options.getString('server');
            const server = serverList.find(obj => obj.name === query || obj.tag === query?.toLowerCase());
            if (server) {
                choices = (await listBackups(server.tag)).map(name => ({
                    name,
                    value: name
                }));
            }
        }

        const filtered = choices.filter(choice => choice.name.toLowerCase().includes(focusedValue.value.toLowerCase()));
        await interaction.respond(filtered.slice(0, 25));
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

        const backupList = await listBackups(server.tag);
        if (!backupList.includes(backup)) {
            await message.edit(`Backup **${backup}** not found for server **${server.name}**.`);
            return;
        }

        // Restore covers every instance sharing the tag, same as /update - the version
        // fields in the database are tag-wide, so instances cannot sit on different ones
        const serverIds = serverList.filter(s => s.tag === server.tag).map(s => s.serverId);
        if (serverIds.length > 1) {
            await message.edit(`Restore manager is starting... (${serverIds.length} instances for ${server.tag.toUpperCase()})`);
        }

        let time = Date.now();

        await updater.restore(server, backup, message, serverIds);

        await message.reply(`Done! This restoration took ${((Date.now()-time)/1000/60).toFixed(2)} minutes.`);

    },
};