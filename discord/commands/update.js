/*
 * File: update.js
 * Project: Valhalla-Updater
 * File Created: Friday, 24th May 2024 2:02:16 pm
 * Author: flaasz
 * -----
 * Last Modified: Tuesday, 28th May 2024 8:56:14 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const {
    SlashCommandBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const updater = require('../../managers/updateManager');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('update')
		.setDescription('Runs an update sequence on a server!')
        .setDefaultMemberPermissions(0)
        .setDMPermission(false)
		.addStringOption(option =>
			option.setName('server')
				.setDescription('Server to update')
                .setRequired(true)
				.setAutocomplete(true))
        .addStringOption(option =>
            option.setName('version')
                .setDescription('Manual overwrite for the version number')
                .setRequired(false)
                .setAutocomplete(true)),

	async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        const serverList = await yggdrasil.getServers();

        // GTO has no update polling, so offer its release tags for the version option
        if (focused.name === 'version') {
            const query = interaction.options.getString('server');
            const server = serverList.find(s => s.name === query || s.tag === query?.toLowerCase());
            if (!server || server.platform !== 'gregtechodyssey') {
                await interaction.respond([]);
                return;
            }
            try {
                const gto = require('../../modules/gregtechodyssey');
                const releases = await gto.getAllReleases();
                const tags = releases.map(r => r.tag_name)
                    .filter(t => t.toLowerCase().includes(focused.value.toLowerCase()))
                    .slice(0, 25)
                    .map(t => ({ name: t, value: t }));
                await interaction.respond(tags);
            } catch (error) {
                await interaction.respond([]);
            }
            return;
        }

        const focusedValue = focused.value.toLowerCase();
		const choices = [];
		const seen = new Set();

        for (const server of serverList) {
            // gregtechodyssey is never flagged by the update poller - always offer it
            if ((server.requiresUpdate === true || server.platform === 'gregtechodyssey') && !seen.has(server.tag)) {
                seen.add(server.tag);
                choices.push({ name: `${server.tag.toUpperCase()} | ${server.name}`, value: server.tag });
            }
        }

		const filtered = choices.filter(c => c.name.toLowerCase().includes(focusedValue) || c.value.includes(focusedValue));
		await interaction.respond(filtered.slice(0, 25));
	},

    async execute(interaction) {
        const query = interaction.options.getString('server');
        const versionOverride = interaction.options.getString('version');
        const serverList = await yggdrasil.getServers();
        await interaction.deferReply();
        await interaction.editReply("Update manager is starting...");

        const message = await interaction.fetchReply();

        const server = serverList.find(s => s.name === query || s.tag === query.toLowerCase());
        // gregtechodyssey is never flagged by the update poller - updates are on-demand
        if (!server || (server.requiresUpdate === false && server.platform !== 'gregtechodyssey')) {
            await message.edit(`Server **${query}** not found or doesn't need an update!`);
            return;
        }

        const allInstances = serverList.filter(s => s.tag === server.tag);
        const serverIds = allInstances.map(s => s.serverId);

        if (serverIds.length > 1) {
            await message.edit(`Update manager is starting... (${serverIds.length} instances for ${server.tag.toUpperCase()})`);
        }

        let time = Date.now();
        switch (server.platform) {
            case "curseforge":
                await updater.updateCF(server, versionOverride, message, serverIds);
                break;
            case "feedthebeast":
                await updater.updateFTB(server, versionOverride, message, serverIds);
                break;
            case "gregtechnewhorizons":
                await updater.updateGTNH(server, versionOverride, message, serverIds);
                break;
            case "gregtechodyssey":
                await updater.updateGTO(server, versionOverride, message, serverIds);
                break;
            default:
                await message.edit('Platform not supported!');
        }

        const timeTaken = Date.now() - time;
        await message.reply(`Done! This update took **${formatTime(timeTaken)}**.`);
	},
};  


/**
 * Formats a time duration in milliseconds into a human-readable string.
 * @param {number} milliseconds - The time duration in milliseconds.
 * @returns {string} - A formatted string (e.g., "2 minutes 30 seconds" or "1 hour 5 minutes").
 */
function formatTime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const remainingSeconds = seconds % 60;
    const remainingMinutes = minutes % 60;

    let formattedTime = '';

    if (hours > 0) {
        formattedTime += `${hours} hour${hours > 1 ? 's' : ''} `;
    }
    if (remainingMinutes > 0) {
        formattedTime += `${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''} `;
    }
    if (remainingSeconds > 0 || formattedTime === '') {
        formattedTime += `${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
    }

    return formattedTime.trim();
}