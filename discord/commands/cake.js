/*
 * File: cake.js
 * Project: valhalla-updater
 * File Created: Thursday, 13th June 2024 9:27:32 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 13th June 2024 11:18:09 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const {
    SlashCommandBuilder
} = require('discord.js');
const {
    dropCakeManual
} = require('../../schedulers/cakeDrop');
module.exports = {
    data: new SlashCommandBuilder()
        .setName('cake')
        .setDescription('Drops cakes to players!')
        .setDefaultMemberPermissions(8192)
        .addIntegerOption(option =>
            option
            .setName('amount')
            .setDescription('Amount to drop')
            .setRequired(false)),
    async execute(interaction) {
        await interaction.deferReply();
        let cakeAmount = interaction.options.getInteger('amount');
        if (cakeAmount === null) cakeAmount = 1;
        await interaction.editReply(`Dropping ${cakeAmount} cakes! 🍰`);

        const cakes = await dropCakeManual(cakeAmount);
        await interaction.editReply(cakes);
    },
};