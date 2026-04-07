/*
 * File: roleAssigner.js
 * Project: valhalla-updater
 * File Created: Wednesday, 29th May 2024 7:30:52 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 30th May 2024 1:26:06 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */
const {
    rmSync
} = require("fs-extra");
const sharp = require('sharp');
const axios = require('axios');
const sessionLogger = require("../modules/sessionLogger");
const {
    getClient
} = require("../discord/bot");
const {
    getWebhook
} = require("../discord/webhook");
const {
    getPackData
} = require("../modules/curseforge");
const {
    download
} = require("../modules/downloader");
const {
    sleep
} = require("../modules/functions");
const {
    getFTBPackData
} = require("../modules/modpacksch");
const yggdrasil = require("../modules/yggdrasil");
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

module.exports = {
    name: "roleAssigner",
    defaultConfig: {
        "active": true,
        "interval": 1,
        "roleChannelId": "",
        "MentionRoleId": "",
        "defaultEmojiId": "",
    },

    /**
     * Starts a scheduler that hooks to a message on discord and adds buttons for role assignemnt.
     * @param {object} options Object containing options for the scheduler.
     */
    start: async function (options) {

        if (!options.roleChannelId) return sessionLogger.warn('RoleAssigner', "Set role assigner up in /config/config.json!");

        const client = await getClient();

        client.on("interactionCreate", async interaction => {
            if (interaction.isButton() && interaction.message.channelId === options.roleChannelId) {
                try {
                    let serverList = await yggdrasil.getServers();
                    serverList = await addMentionButton(serverList);
                    let server = serverList.find(server => server.tag === interaction.customId);
                    let replyMessage = "Something went wrong!";
                    //console.log(interaction);
                    const guildMember = await interaction.guild.members.fetch(interaction.user.id);
                    const role = interaction.guild.roles.cache.find(role => role.id === server.discordRoleId);

                    if (guildMember.roles.cache.has(role.id)) {
                        await guildMember.roles.remove(role);
                        sessionLogger.info('RoleAssigner', `${interaction.user.globalName} disabled role for ${server.name}`);
                        replyMessage = `Role for ${server.name} **removed**!`;
                    } else {
                        await guildMember.roles.add(role);
                        sessionLogger.info('RoleAssigner', `${interaction.user.globalName} enabled role for ${server.name}`);
                        replyMessage = `Role for ${server.name} **enabled**!`;
                    }

                    let response = await interaction.reply({
                        content: replyMessage,
                        ephemeral: true
                    });
                    await sleep(2000);
                    await response.delete();
                } catch (error) {
                    sessionLogger.error('RoleAssigner', 'Error during role assignment:', error);
                }
            }
        });

        async function buildButtons() {
            let serverList = await yggdrasil.getServers();
            serverListFull = await addMentionButton(serverList);
        
            serverList = serverListFull.filter(server => server.discordRoleId != "" && server.discordRoleId);
            serverListMissing = serverListFull.filter(server => (!server.discordRoleId || server.discordRoleId === "") && server.modpackID);
            await generateNewRoles(serverListMissing);
        
            const webhook = await getWebhook(options.roleChannelId);
        
            const channel = await client.channels.fetch(options.roleChannelId);
            const messages = (await channel.messages.fetch({ limit: 10 }))
                .filter(msg => msg.webhookId === webhook.id)
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp); 
        
            let buttonList = [];
            for (let server of serverList) {
                const channel = await client.channels.fetch(options.roleChannelId);
        
                let emoji = channel.guild.emojis.cache.find(emoji => emoji.name === server.tag);
                if (!emoji) {
                    await generateEmoji(server);
                    emoji = {};
                    emoji.id = options.defaultEmojiId;
                }
                let button = new ButtonBuilder()
                    .setCustomId(server.tag)
                    .setLabel(server.name)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji(emoji.id);
                buttonList.push(button);
            }
        
            const chunkSize = 25;
            const buttonChunks = [];
            for (let i = 0; i < buttonList.length; i += chunkSize) {
                buttonChunks.push(buttonList.slice(i, i + chunkSize));
            }
        
            const actionRowsChunks = buttonChunks.map(chunk => {
                let actionRows = [];
                let buttonListChunk = [...chunk];
                while (buttonListChunk.length > 0) {
                    actionRows.push(new ActionRowBuilder().addComponents(buttonListChunk.splice(0, 5)));
                }
                return actionRows;
            });
        
            for (let i = 0; i < actionRowsChunks.length; i++) {
                const message = messages.at(i); 
                if (message) {
                    await webhook.editMessage(message.id, {
                        content: i === 0 ? "### Click on buttons below to toggle the roles!" : "More roles to assign!",
                        components: actionRowsChunks[i]
                    });
                } else {
                    await webhook.send({
                        username: "ValhallaMC Role Assignment",
                        content: i === 0 ? "### Click on buttons below to toggle the roles!" : "More roles to assign!",
                        components: actionRowsChunks[i]
                    });
                }
            }
        
            for (let i = actionRowsChunks.length; i < messages.size; i++) {
                const message = messages.at(i);
                if (message) {
                    await message.delete();
                }
            }
        }

        async function generateNewRoles(serverList) {
            for (let server of serverList) {
                sessionLogger.info('RoleAssigner', `Generating new role for ${server.name}`);
                const channel = await client.channels.fetch(options.roleChannelId);

                const newRole = await channel.guild.roles.create({
                    name: `[${server.tag.toUpperCase()}] ${server.name}`,
                    reason: 'Automated role generation for role assigner.'
                });

                await yggdrasil.updateServer(server.tag, {
                    discord_role_id: newRole.id
                });
            }
        }

        async function generateEmoji(server) {
            if (!server.hostname || !server.modpackID) return;
            const channel = await client.channels.fetch(options.roleChannelId);
            sessionLogger.info('RoleAssigner', `Creating new emoji for ${server.name}!`);
            let emojiURL = "";

            try {
                if (server.platform === 'feedthebeast') {
                    const packData = await getFTBPackData(server.modpackID);
                    emojiURL = packData.art[0].url;
                } else {
                    const packData = await getPackData(server.modpackID);
                    emojiURL = packData.logo.url;
                }
            } catch (error) {
                sessionLogger.warn('RoleAssigner', `Failed to get pack data for ${server.name}: ${error.message}`);
                return;
            }

            const response = await axios.get(emojiURL, {
                responseType: 'arraybuffer'
            });
            const buffer = response.data;

            resizedBuffer = await sharp(buffer)
                .resize({
                    width: 128,
                    height: 128,
                    fit: 'inside'
                })
                .toBuffer();

            await channel.guild.emojis.create({
                attachment: resizedBuffer,
                name: server.tag
            });
        }

        async function addMentionButton(serverList) {
            if (!options.MentionRoleId) return serverList;

            const channel = await client.channels.fetch(options.roleChannelId);

            let role = channel.guild.roles.cache.find(role => role.id === options.MentionRoleId);
            if (!role) return serverList;

            let mentionObj = {
                name: role.name,
                tag: role.name.toLowerCase(),
                discordRoleId: role.id
            };

            serverList.unshift(mentionObj);
            return serverList;
        }

        buildButtons();
        setInterval(buildButtons, options.interval * 60 * 1000);
    }

};