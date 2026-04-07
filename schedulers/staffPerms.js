/*
 * File: staffPerms.js
 * Project: valhalla-updater
 * File Created: Wednesday, 3rd July 2024 9:36:20 pm
 * Author: flaasz
 * -----
 * Last Modified: Wednesday, 3rd July 2024 10:42:24 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const functions = require("../modules/functions");
const yggdrasil = require("../modules/yggdrasil");
const pterodactyl = require("../modules/pterodactyl");
const sessionLogger = require("../modules/sessionLogger");

module.exports = {
    name: "staffPerms",
    defaultConfig: {
        "active": true,
        "interval": 24,
        "staffMailList": [],
        "staffPermissions": [
            "control.console",
            "control.start",
            "control.stop",
            "control.restart",
            "file.create",
            "file.read",
            "file.read-content",
            "file.update",
            "file.delete",
            "file.archive",
            "file.sftp",
            "activity.read",
        ]
    },

    /**
     * Starts a scheduler that gives permissions for staff on pterodactyl.
     * @param {object} options Object containing options for the scheduler.
     */
    start: async function (options) {
        await functions.sleep(30000);
        this.givePerms(options);
        setInterval(() => this.givePerms(options), options.interval * 60 * 60 * 1000);
    },

    givePerms: async function (options) {

        sessionLogger.info('StaffPerms', "Checking staff permissions...");
        const servers = await yggdrasil.getServers();

        for (let server of servers) {
            //console.log(`Checking server ${server.name}`);
            const subUsers = await pterodactyl.listUsers(server.serverId);
            //console.log(subUsers.data);
            for (let staffMail of options.staffMailList) {

                const user = subUsers.data.find(user => user.attributes.email === staffMail);
                //console.log(user);

                if (user) {
                    if (options.staffPermissions.every(permission => user.attributes.permissions.includes(permission))) {
                        continue;
                    } else {
                        sessionLogger.info('StaffPerms', `User ${staffMail} has missing permissions for server ${server.name}! Updating...`);
                        await pterodactyl.updateSubUser(server.serverId, user.attributes.uuid, {
                            "permissions": options.staffPermissions
                        });
                        await functions.sleep(1000);
                    }
                    continue;
                }

                await functions.sleep(300);
                sessionLogger.info('StaffPerms', `User ${staffMail} does not have permissions for server ${server.name}! Adding...`);

                const userBody = {
                    "email": staffMail,
                    "permissions": options.staffPermissions
                };

                await pterodactyl.createSubUser(server.serverId, userBody);

            }
        }
    }

};