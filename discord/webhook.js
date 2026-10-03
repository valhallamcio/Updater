/*
 * File: webhook.js
 * Project: valhalla-updater
 * File Created: Monday, 27th May 2024 7:31:16 pm
 * Author: flaasz
 * -----
 * Last Modified: Saturday, 1st June 2024 12:12:42 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const { getClient } = require('./bot');
const sessionLogger = require('../modules/sessionLogger');

module.exports = {
    /**
     * Sends a webhook message to the specified channel.
     * @param {String} channelId Id of the channel.
     * @param {object} message Object containing the message to send.
     * @returns 
     */
    sendWebhook: async function (channelId, message) {
        const client = await getClient();
        const channel = client.channels.cache.get(channelId);

        if (!channel) {
            sessionLogger.error('Webhook', `Channel with ID ${channelId} not found!`);
            return;
        }

        let webhook = await module.exports.getWebhook(channelId);
        if (!webhook) return;

        // Pack names and versions come from upstream APIs. Nothing pings unless the caller names it.
        await webhook.send({
            allowedMentions: {
                parse: []
            },
            ...message
        });
    },

    getWebhook: async function(channelId) {
        const client = await getClient();
        const channel = client.channels.cache.get(channelId);

        if (!channel) {
            sessionLogger.error('Webhook', `Channel with ID ${channelId} not found!`);
            return;
        }
        try {
            const webhooks = await channel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.token);

            if (!webhook) {
                sessionLogger.info('Webhook', `Creating webhook for channel ${channel.name}...`);
                webhook = await channel.createWebhook({
                    name: "Valhalla Updater",
                    avatar: client.user.displayAvatarURL(),
                });
                // moveCursor only exists on a TTY. Under a service manager it threw and lost the new webhook.
                if (process.stdout.isTTY) process.stdout.moveCursor(0, -1);
                sessionLogger.info('Webhook', `Creating webhook for channel ${channel.name}... Done!`);
            }

            return webhook;

        } catch (error) {
            sessionLogger.error('Webhook', 'Error trying to create a webhook:', error);
        }
    }
};