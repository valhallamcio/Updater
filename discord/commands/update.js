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
                .setRequired(false)),

	async autocomplete(interaction) {
		const focusedValue = interaction.options.getFocused();
        const serverList = await yggdrasil.getServers();
		const choices = [];

        for (const server of serverList) {
            if (server.requiresUpdate === true) {
                choices.push(server.name);
            }
        }

		const filtered = choices.filter(choice => choice.startsWith(focusedValue));
		await interaction.respond(
			filtered.map(choice => ({ name: choice, value: choice })),
		);
	},

    async execute(interaction) {
        const query = interaction.options.getString('server');
        const versionOverride = interaction.options.getString('version');
        const serverList = await yggdrasil.getServers();
        await interaction.deferReply();
        await interaction.editReply("Update manager is starting...");

        const message = await interaction.fetchReply();

        const server = serverList.find(server => server.name === query || server.tag === query.toLowerCase());
        if (!server || server.requiresUpdate === false) {
            await message.edit(`Server **${query}** not found or doesn't need an update!`);
            return;
        }

        let time = Date.now();
        switch (server.platform) {
            case "curseforge": 
                await updater.updateCF(server, versionOverride, message);
                break;
            case "feedthebeast":
                await updater.updateFTB(server, versionOverride, message);
                break;
            case "gregtechnewhorizons":
                await updater.updateGTNH(server, versionOverride, message);
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