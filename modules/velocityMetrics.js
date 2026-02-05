/*
 * File: velocityMetrics.js
 * Project: valhalla-updater
 * File Created: Thursday, 13th June 2024 2:28:16 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 13th June 2024 3:34:02 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

require('dotenv').config();
const axios = require('axios');



module.exports = {
    getPlayers: async function () {

        const response = await axios.get(`${process.env.VELOCITY_METRICS_URL}`, { timeout: 15000 });

        const regex = /bungeecord_online_player\{server="([^"]+)",player="([^"]*)",\} \d+\.\d+/g;
        const servers = {};
        let match;

        while ((match = regex.exec(response.data)) !== null) {
            const server = match[1].trim();
            const player = match[2].trim();

            if (!servers[server]) {
                servers[server] = [];
            }

            if (player) {
                servers[server].push(player);
            }
        }

        return servers;
    }
};