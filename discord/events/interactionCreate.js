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
const linkFlow = require('../commands/util/linkFlow');

/**
 * Whether a command is staff-only but was invoked outside a guild.
 * default_member_permissions is only enforced inside a guild, so in a DM with the bot any
 * member could run /cake, /stats or /tickets. Commands with no default permissions stay usable.
 * @param {object} command The loaded command module.
 * @param {object} interaction The interaction.
 * @returns {boolean} True when the call must be refused.
 */
function staffCommandOutsideGuild(command, interaction) {
    const perms = command.data && command.data.default_member_permissions;
    return perms !== undefined && perms !== null && !interaction.inGuild();
}

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {

        // The link buttons and the code box live here, not in the #link panel scheduler:
        // /link with no code and the /wrapped reply need them with the panel switched off.
        if (linkFlow.owns(interaction)) {
            try {
                await linkFlow.handleInteraction(interaction);
            } catch (error) {
                sessionLogger.error('InteractionHandler', 'A link button or the code box failed:', error.message);
            }
            return;
        }

        if (interaction.isAutocomplete()) {
            const command = interaction.client.commands.get(interaction.commandName);
    
            if (!command) {
                sessionLogger.error('InteractionHandler', `No autocomplete command matching ${interaction.commandName} was found.`);
                return;
            }
            if (staffCommandOutsideGuild(command, interaction)) {
                await interaction.respond([]).catch(() => {});
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
        if (staffCommandOutsideGuild(command, interaction)) {
            await interaction.reply({
                content: 'This command only works in the server.',
                ephemeral: true
            }).catch(() => {});
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