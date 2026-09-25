/*
 * File: reloadCommands.js
 * Project: Valhalla-Updater
 * File Created: Friday, 17th May 2024 1:03:42 am
 * Author: flaasz
 * -----
 * Last Modified: Tuesday, 28th May 2024 12:05:29 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const {
    SlashCommandBuilder
} = require('discord.js');
const { loadCommandFiles } = require('../commands');

module.exports = {

    data: new SlashCommandBuilder()
        .setName('reloadcommands')
        .setDescription('Reloads all commands on the bot!')
        .setDMPermission(false)
        .setDefaultMemberPermissions(0),
    async execute(interaction) {
        const {
            deployCommands
        } = require('../deploy');

        // The deploy takes longer than Discord's 3 s reply window.
        await interaction.deferReply();
        await loadCommandFiles(interaction.client);
        await deployCommands(interaction.client.user.id);
        await interaction.editReply('Reloaded all commands!');
    },
};