/*
 * File: cakeDrop.js
 * Project: valhalla-updater
 * File Created: Monday, 27th May 2024 8:35:46 pm
 * Author: flaasz
 * -----
 * Last Modified: Monday, 16th September 2024 1:31:16 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 *
 * The drop credits a BALANCE now. It used to run `give` on every online player,
 * which put thousands of cake into chests and hoppers on every pack — the
 * cake-limiting complaint. The proxy owns the balance (`bifrost.players.cake`)
 * and the player takes it out with `/cake` when they want it, so nothing ever
 * lands on the floor again and nothing is lost when an inventory is full.
 */

const functions = require("../modules/functions");
const mongo = require("../modules/mongo");
const pterodactyl = require("../modules/pterodactyl");
const yggdrasil = require("../modules/yggdrasil");
const sessionLogger = require("../modules/sessionLogger");

/** The line a player sees. A messages.json from before the bank has no `[AMOUNT]`, so it is not used. */
const DEFAULT_DROP_LINE = 'tellraw [RECIEVERS] {"text":"+[AMOUNT] cake banked. /cake to withdraw.","color":"green"}';

/** The configured line when it can carry the amount, else the default. Read per drop. */
function dropLine() {
    const configured = require("../config/messages.json").alertCakeDrop;
    return typeof configured === 'string' && configured.includes('[AMOUNT]') ? configured : DEFAULT_DROP_LINE;
}

module.exports = {
    name: "cakeDrop",
    defaultConfig: {
        "active": true,
        "interval": 120,
        "min": 1,
        "max": 10,
        "chance": 3,
        "exclude": []
    },

    /**
     * Starts a scheduler that has a chance to give players on the servers a random amount of cake.
     * @param {object} options Object containing options for the scheduler.
     */
    start: async function (options) {
        setInterval(() => this.dropCake(options), options.interval * 60 * 1000);
    },

    /**
     * Rolls the chance and banks a random amount when it comes up.
     * @param {object} options Object containing options for the scheduler.
     */
    dropCake: async function (options) {

        const randomNumber = Math.random();

        if (randomNumber < 1 / options.chance) {
            sessionLogger.info('CakeDrop', "Attempting to drop cake... Dropping cake!");

            let cakeAmount = Math.floor(Math.random() * (options.max - options.min + 1)) + options.min;

            await module.exports.creditAll(cakeAmount, 'cakeDrop');
        } else {
            sessionLogger.info('CakeDrop', "Attempting to drop cake... No cake dropped.");
        }
    },

    /**
     * Banks the same amount for every online player and tells them on their own server.
     * @param {number} cakeAmount Cake to bank per player.
     * @param {string} by Who asked for it - the scheduler name, or a Discord tag.
     * @returns {Promise<{players: number, cakes: number}>} How many players were paid, and how much in total.
     */
    creditAll: async function (cakeAmount, by) {
        let servers = await yggdrasil.getServers();
        let playerData = await yggdrasil.getPlayersDetailed();
        const exclude = (require("../config/config.json").scheduler.cakeDrop || {}).exclude || [];

        let totalAmount = 0;
        let totalPlayers = 0;

        for (let serverName in playerData) {
            let server = servers.find(s => s.tag === serverName);
            if (!server) {
                sessionLogger.warn('CakeDrop', `Server '${serverName}' not found, skipping`);
                continue;
            }

            let allTagServers = servers.filter(s => s.tag === serverName);

            for (let player of playerData[serverName]) {
                if (exclude.includes(player.username)) continue;

                let targetServer = server;
                if (player.instance) {
                    let matched = allTagServers.find(s =>
                        s.name === player.instance || s.id === player.instance || s.serverId === player.instance
                    );
                    if (matched) targetServer = matched;
                }

                // An account the proxy has never seen has nowhere to put the
                // cake. Say so and move on - one stranger must not stop the drop.
                const credited = await mongo.creditCake(player.username, cakeAmount, {
                    kind: 'drop',
                    by: by,
                    server: targetServer.tag || serverName
                });
                if (!credited) {
                    sessionLogger.warn('CakeDrop', `No Bifrost player doc for '${player.username}', skipping`);
                    continue;
                }

                await pterodactyl.sendCommand(targetServer.serverId, dropLine()
                    .replace("[RECIEVERS]", player.username)
                    .replace("[AMOUNT]", String(cakeAmount)));
                totalAmount += cakeAmount;
                totalPlayers++;
                await functions.sleep(100);
            }
        }
        sessionLogger.info('CakeDrop', `Banked ${totalAmount} cakes for ${totalPlayers} players!`);
        return { players: totalPlayers, cakes: totalAmount };
    },

    /**
     * The Discord `/cake` path.
     * @param {number} cakeAmount Cake to bank per player.
     * @param {string} by Who ran the command.
     * @returns {Promise<string>} The reply for the interaction.
     */
    dropCakeManual: async function (cakeAmount, by) {
        // Called destructured from discord/commands/cake.js, so there is no `this` here.
        const result = await module.exports.creditAll(cakeAmount, by || 'discord');
        return `Done! Banked **${result.cakes}** cake for **${result.players}** players!`;
    }

};
