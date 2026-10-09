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

// The panel throttles subuser writes: on 2026-10-08 ten creates went through in 5 s,
// then every create got 429 "Too Many Attempts" and three staff were never added.
const RETRY_WAIT_MS = 65000;
const MAX_ATTEMPTS = 3;

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

    /**
     * Runs one panel call and tries again when it fails. The pterodactyl module logs the
     * error and returns undefined, so an empty result is a failure.
     * @param {string} label What the call does, for the log.
     * @param {Function} call Returns the panel response.
     * @returns The response, or null after MAX_ATTEMPTS failures.
     */
    withRetry: async function (label, call) {
        for (let attempt = 1; ; attempt++) {
            const result = await call();
            if (result) return result;
            if (attempt >= MAX_ATTEMPTS) {
                sessionLogger.error('StaffPerms', `${label} failed ${MAX_ATTEMPTS} times. Skipped until the next run.`);
                return null;
            }
            sessionLogger.warn('StaffPerms', `${label} failed (attempt ${attempt} of ${MAX_ATTEMPTS}). Next try in ${RETRY_WAIT_MS / 1000} s.`);
            await functions.sleep(RETRY_WAIT_MS);
        }
    },

    givePerms: async function (options) {

        sessionLogger.info('StaffPerms', "Checking staff permissions...");
        const servers = await yggdrasil.getServers();

        for (let server of servers) {
            //console.log(`Checking server ${server.name}`);
            const subUsers = await this.withRetry(`Subuser list for ${server.name}`, () => pterodactyl.listUsers(server.serverId));
            if (!subUsers) continue;
            //console.log(subUsers.data);
            for (let staffMail of options.staffMailList) {

                const user = subUsers.data.find(user => user.attributes.email === staffMail);
                //console.log(user);

                if (user) {
                    if (options.staffPermissions.every(permission => user.attributes.permissions.includes(permission))) {
                        continue;
                    } else {
                        sessionLogger.info('StaffPerms', `User ${staffMail} has missing permissions for server ${server.name}! Updating...`);
                        await this.withRetry(`Update of ${staffMail} on ${server.name}`, () => pterodactyl.updateSubUser(server.serverId, user.attributes.uuid, {
                            "permissions": options.staffPermissions
                        }));
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

                await this.withRetry(`Add of ${staffMail} to ${server.name}`, () => pterodactyl.createSubUser(server.serverId, userBody));

            }
        }
    }

};