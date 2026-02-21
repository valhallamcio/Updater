/*
 * File: apiManager.js
 * Project: valhalla-updater
 * File Created: Friday, 14th June 2024 12:29:18 am
 * Author: flaasz
 * -----
 * Last Modified: Friday, 14th June 2024 2:10:06 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const webhook = require('../discord/webhook');
const webApiPort = require("../config/config.json").webApi.port;
const sessionLogger = require('../modules/sessionLogger');
require('dotenv').config();
const kofiToken = process.env.KOFI_SECRET;
const config = require("../config/config.json");
const pterodactyl = require('../modules/pterodactyl');
const velocityMetrics = require('../modules/velocityMetrics');
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(bodyParser.json());

module.exports = {
    startServer: async function () {
        try {
            sessionLogger.info('ApiManager', 'Initializing API server...');

            const output = {
                content: "",
                username: "Ko-fi",
                avatarURL: "https://uploads-ssl.webflow.com/5c14e387dab576fe667689cf/61e1116779fc0a9bd5bdbcc7_Frame%206.png",
            };

            app.post('/post', async function (req, res) {
                const data = req.body.data;
                if (!data) {
                    sessionLogger.debug('ApiManager', 'Ko-fi webhook received empty data');
                    return res.json({ success: true });
                }

                try {
                    const obj = JSON.parse(data);
                    if (obj.verification_token != kofiToken) {
                        sessionLogger.warn('ApiManager', 'Ko-fi webhook received invalid token');
                        return res.json({ success: false });
                    }
                    
                    if (obj.message) {
                        output.content = `**${obj.from_name}** just donated **€${obj.amount}**: *${obj.message}*`;
                        pterodactyl.sendCommand(config.pterodactyl.velocityID, `alert [Ko-fi] ${obj.from_name} just donated €${obj.amount}: ${obj.message}`);
                        sessionLogger.info('ApiManager', `Ko-fi donation: ${obj.from_name} donated €${obj.amount} with message: ${obj.message}`);
                    } else {
                        output.content = `**${obj.from_name}** just donated **€${obj.amount}**!`;
                        pterodactyl.sendCommand(config.pterodactyl.velocityID, `alert [Ko-fi] ${obj.from_name} just donated €${obj.amount}!`);
                        sessionLogger.info('ApiManager', `Ko-fi donation: ${obj.from_name} donated €${obj.amount}`);
                    }
                    webhook.sendWebhook(config.discord.chatChannelId, output);

                } catch (err) {
                    sessionLogger.error('ApiManager', 'Ko-fi webhook processing failed', err.message);
                    return res.json({
                        success: false,
                        error: err.message
                    });
                }
                return res.json({
                    success: true
                });
            });
            
            app.use('/players', async function (req, res) {
                let data = await velocityMetrics.getPlayers();
                res.json(data);
                return;
            });

            app.use('/', async function (req, res) {
                sessionLogger.debug('ApiManager', `API request from ${req.ip}: ${req.method} ${req.path}`);
                res.json({
                    message: "ValhallaMC api server is online!"
                });
                return;
            });

            app.listen(webApiPort, function () {
                sessionLogger.info('ApiManager', `Web API Server online on port ${webApiPort}`);
            });
        } catch (error) {
            sessionLogger.error('ApiManager', 'Failed to start API server', error.message);
            throw error;
        }
    }
};
