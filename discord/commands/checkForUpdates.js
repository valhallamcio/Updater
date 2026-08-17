/*
 * File: checkForUpdates.js
 * Project: valhalla-updater
 * File Created: Thursday, 13th June 2024 11:08:20 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 13th June 2024 11:17:37 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const {
    SlashCommandBuilder
} = require('discord.js');
const { updateCheck } = require('../../schedulers/checkForUpdates');

module.exports = {

    data: new SlashCommandBuilder()
        .setName('checkupdates')
        .setDescription('Manually check for updates!')
        .setDMPermission(false)
        .setDefaultMemberPermissions(0),
    async execute(interaction) {
        await interaction.deferReply();
        await interaction.editReply('Checking for updates...');

        let updates;
        try {
            updates = await updateCheck();
        } catch (error) {
            await interaction.editReply(`Checking for updates... Failed: ${error.message}`);
            throw error;
        }

        await interaction.editReply(`Checking for updates... Done! Found **${updates}** updates! 🎉`);
    },
};