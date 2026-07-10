/*
 * File: checkForUpdates.js
 * Project: valhalla-updater
 * File Created: Monday, 27th May 2024 8:27:53 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 13th June 2024 11:15:24 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const curseforge = require("../modules/curseforge");
const modpacksch = require("../modules/modpacksch");
const yggdrasil = require("../modules/yggdrasil");
const functions = require("../modules/functions");
const {
    EmbedBuilder
} = require("discord.js");
const {
    sendWebhook
} = require("../discord/webhook");
const {
    active,
    staffChannelId
} = require("../config/config.json").discord;
const sessionLogger = require("../modules/sessionLogger");

module.exports = {
    name: 'checkForUpdates',
    defaultConfig: {
        "active": true,
        "interval": 6
    },

    /**
     * Starts a scheduler that checks for modpack updates at a specified interval.
     * @param {object} options Object containing options for the scheduler.
     */
    start: async function (options) {
        //this.updateCheck();
        setInterval(this.updateCheck, options.interval * 60 * 60 * 1000);
    },

    updateCheck: async function () {
        sessionLogger.info('CheckForUpdates', "Checking for updates...");

        let servers = await yggdrasil.getServers();
        let numberOfUpdates = 0;

        for (let server of servers) {
            if (server.platform === "github" || server.platform === "gregtechodyssey") continue;

            let newestUpdateId = 0;
            let updateRequired = false;
            let packManifest = {};
            let packData = {};
            let packURL = "";
            let packLogo = "";

            if (server.platform === "curseforge" || server.platform === "gregtechnewhorizons") {
                newestUpdateId = await curseforge.getLatestVersionId(server.modpackID);
                packManifest = await modpacksch.getCFPackManifest(server.modpackID, newestUpdateId);
                packData = await curseforge.getPackData(server.modpackID);
                packLogo = packData.logo.url;
                packURL = `https://www.curseforge.com/minecraft/modpacks/${packData.slug}/files/${newestUpdateId}`;
            }

            if (server.platform === "feedthebeast") {
                newestUpdateId = await modpacksch.getLatestFTBVersionId(server.modpackID);
                packManifest = await modpacksch.getFTBPackManifest(server.modpackID, newestUpdateId);
                packData = await modpacksch.getFTBPackData(server.modpackID);
                packLogo = packData.art[0].url;
                packURL = `https://www.feed-the-beast.com/modpacks/${server.modpackID}?tab=versions`;
            }

            if (server.fileID === newestUpdateId) {
                sessionLogger.info('CheckForUpdates', `No updates found for ${server.name}.`);
            } else {
                const newVersionNumber = functions.getVersion(packManifest.name) || 'unknown';

                sessionLogger.info('CheckForUpdates', `Update found for ${server.name}! (v${server.modpackVersion} -> v${newVersionNumber})`);
                updateRequired = true;
                numberOfUpdates++;

                if (active && server.newestFileID != newestUpdateId) {
                    const embed = new EmbedBuilder()
                        .setAuthor({
                            name: server.name,
                            iconURL: packLogo,
                        })
                        .setTitle("<a:Update:1242446803345866883><a:U_:1242446802083385426><a:pd:1242446800586280960><a:ate:1242446799093104650>")
                        .setDescription(`An update was detected for ${server.name}! (v${server.modpackVersion} -> v${newVersionNumber})\n\nLearn more here: [Changelog](${packURL})`)
                        .setColor("#00f597")
                        .setFooter({
                            text: "To run automated update use /update",
                        })
                        .setTimestamp();
                    const updateWebhook = {
                        embeds: [embed],
                    };

                    await sendWebhook(staffChannelId, updateWebhook);
                }
            }

            await yggdrasil.updateServer(server.tag, {
                newestFileID: newestUpdateId,
                requiresUpdate: updateRequired
            });
            //console.log(newestUpdateId);
        }

        return numberOfUpdates;
    }
};