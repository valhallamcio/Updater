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
        .setDescription('Banks cake for every online player!')
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
        await interaction.editReply(`Banking ${cakeAmount} cake! 🍰`);

        const by = interaction.user.tag || interaction.user.username;
        const cakes = await dropCakeManual(cakeAmount, by);
        await interaction.editReply(cakes);
    },
};