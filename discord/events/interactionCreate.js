/*
 * File: interactionCreate.js
 * Project: valhalla-updater
 * File Created: Friday, 17th May 2024 12:58:32 am
 * Author: flaasz
 * -----
 * Last Modified: Wednesday, 29th May 2024 9:23:27 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const { Events } = require('discord.js');
const sessionLogger = require('../../modules/sessionLogger');

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {

        if (interaction.isAutocomplete()) {
            const command = interaction.client.commands.get(interaction.commandName);
    
            if (!command) {
                sessionLogger.error('InteractionHandler', `No autocomplete command matching ${interaction.commandName} was found.`);
                return;
            }
    
            try {
                await command.autocomplete(interaction);
            } catch (error) {
                sessionLogger.error('InteractionHandler', 'Error in autocomplete:', error);
            }

        }

        if (!interaction.isChatInputCommand()) return;

        const command = interaction.client.commands.get(interaction.commandName);
    
        if (!command) {
            sessionLogger.error('InteractionHandler', `No chat command matching ${interaction.commandName} was found.`);
            return;
        }
    
        try {
            await command.execute(interaction);
        } catch (error) {
            sessionLogger.error('InteractionHandler', 'Error executing command:', error);
            // The error notice can fail too (an expired interaction), and an uncaught throw here stops the bot.
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({
                        content: 'There was an error while executing this command!',
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: 'There was an error while executing this command!',
                        ephemeral: true
                    });
                }
            } catch (replyError) {
                sessionLogger.error('InteractionHandler', 'Could not send the error notice:', replyError.message);
            }
        }
	},
};