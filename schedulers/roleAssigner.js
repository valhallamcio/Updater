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
const crypto = require('crypto');
const sharp = require('sharp');
const axios = require('axios');
const sessionLogger = require("../modules/sessionLogger");
const mongo = require("../modules/mongo");
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
    sleep
} = require("../modules/functions");
const {
    getFTBPackData
} = require("../modules/modpacksch");
const yggdrasil = require("../modules/yggdrasil");
const {
    ActionRowBuilder,
    AuditLogEvent,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

// The audit log reason on every role VU creates. A RoleCreate entry with this reason and the
// bot as executor proves that VU made the role.
const ROLE_REASON = 'Automated role generation for role assigner.';

/**
 * The name VU gives the role of a pack.
 */
function roleName(pack) {
    return `[${pack.tag.toUpperCase()}] ${pack.name}`;
}

/**
 * The label of a pack with several instances: the shortest instance name, then the first in
 * alphabetical order. It does not depend on the order Yggdrasil lists the instances in.
 */
function packLabel(rows) {
    const names = rows.map(r => String(r.name || '').trim()).filter(Boolean);
    if (names.length === 0) return rows[0].tag;
    return names.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/**
 * One role button per pack. The instances of a tag share one Discord role, so they share
 * one button, and the role id comes from all of them together.
 * @param {Array} servers Server docs, with the mention and Bifrost rows put in front.
 * @returns {{packs: Array, conflicts: Array, hidden: Array}} packs: one row per tag in first-seen
 *   order, with the role id the instances carry ('' when none has one). conflicts: { tag, roleIds }
 *   for a tag whose instances carry different role ids. Such a tag gets no button and no new role.
 *   hidden: { tag, discordRoleId } for a tag whose every instance has excludeFromServerList. The
 *   pack is not released, so it gets no button, no new role and no emoji.
 */
function packButtons(servers) {
    const byTag = new Map();
    for (const server of servers) {
        if (!server || !server.tag) continue;
        if (!byTag.has(server.tag)) byTag.set(server.tag, []);
        byTag.get(server.tag).push(server);
    }

    const packs = [];
    const conflicts = [];
    const hidden = [];
    for (const [tag, rows] of byTag) {
        const roleIds = [...new Set(rows.map(r => r.discordRoleId).filter(Boolean))];
        if (roleIds.length > 1) {
            conflicts.push({ tag, roleIds });
            continue;
        }
        const visible = rows.filter(r => !r.excludeFromServerList);
        if (visible.length === 0) {
            hidden.push({ tag, discordRoleId: roleIds[0] || '' });
            continue;
        }
        // Pack data for the emoji. The instances run one pack, so any row that has it will do.
        const data = rows.find(r => r.modpackID) || {};
        packs.push({
            tag,
            // A hidden instance can carry a code name. The label comes from the visible ones.
            name: visible.length === 1 ? visible[0].name : packLabel(visible),
            discordRoleId: roleIds[0] || '',
            hostname: data.hostname,
            modpackID: data.modpackID,
            platform: data.platform
        });
    }
    return { packs, conflicts, hidden };
}

/**
 * The role ids that RoleCreate audit log entries show the role assigner created.
 * @param {Iterable} entries Audit log entries: { targetId, executorId, reason }.
 * @param {string} botId The bot's user id.
 * @returns {Set<string>} Role ids.
 */
function createdByAssigner(entries, botId) {
    const roleIds = new Set();
    for (const entry of entries) {
        if (entry.targetId && entry.executorId === botId && entry.reason === ROLE_REASON) roleIds.add(entry.targetId);
    }
    return roleIds;
}

/**
 * The roles to mark as waiting for a release. VU created them, and a hidden tag holds them now.
 * @param {Array} hidden Hidden tags from packButtons.
 * @param {Map<string, object>} owned Role id to its role_assigner_roles row.
 * @param {Set<string>} created Role ids that are not in owned yet, which the audit log shows VU created.
 * @returns {Array<{roleId: string, tag: string}>}
 */
function pendingMarks(hidden, owned, created) {
    const marks = [];
    for (const { tag, discordRoleId: roleId } of hidden) {
        if (!roleId || marks.some(mark => mark.roleId === roleId)) continue;
        const row = owned.get(roleId);
        if (row && row.pendingRelease) continue;
        if (!row && !created.has(roleId)) continue;
        marks.push({ roleId, tag });
    }
    return marks;
}

/**
 * The roles of released packs that VU created while the pack was hidden. Each one takes the
 * pack's real tag and name. A role that a hidden tag still holds waits.
 * @param {Array} packs Visible packs from packButtons.
 * @param {Array} hidden Hidden tags from packButtons.
 * @param {Map<string, object>} owned Role id to its role_assigner_roles row.
 * @returns {Array<{roleId: string, tag: string, name: string}>} The name the role must have.
 */
function releasedRoles(packs, hidden, owned) {
    const held = new Set(hidden.map(h => h.discordRoleId).filter(Boolean));
    return packs
        .filter(pack => pack.discordRoleId && !held.has(pack.discordRoleId))
        .filter(pack => (owned.get(pack.discordRoleId) || {}).pendingRelease)
        .map(pack => ({ roleId: pack.discordRoleId, tag: pack.tag, name: roleName(pack) }));
}

module.exports = {
    name: "roleAssigner",
    defaultConfig: {
        "active": true,
        "interval": 1,
        "roleChannelId": "",
        "MentionRoleId": "",
        "BifrostRoleId": "",
        "defaultEmojiId": "",
    },

    /**
     * Starts a scheduler that hooks to a message on discord and adds buttons for role assignemnt.
     * @param {object} options Object containing options for the scheduler.
     */
    start: async function (options) {

        if (!options.roleChannelId) return sessionLogger.warn('RoleAssigner', "Set role assigner up in /config/config.json!");

        const client = await getClient();
        // Hash of the button rows last written. A rebuild that lands on the same rows edits nothing.
        let lastPayloadHash = null;
        // Role id conflicts already logged, so the 1 min rebuild does not repeat them.
        const loggedConflicts = new Set();
        // The role_assigner_roles rows by role id. Null until the first read works.
        let ownedRoles = null;
        // Role ids the audit log does not show VU created. Each one is looked up once per process.
        const auditChecked = new Set();
        let lastTrackError = null;

        client.on("interactionCreate", async interaction => {
            if (interaction.isButton() && interaction.message.channelId === options.roleChannelId) {
                try {
                    let serverList = await yggdrasil.getServers();
                    serverList = await addMentionButton(serverList);
                    serverList = await addBifrostButton(serverList);
                    let server = packButtons(serverList).packs.find(pack => pack.tag === interaction.customId);
                    let replyMessage = "Something went wrong!";
                    //console.log(interaction);
                    const guildMember = await interaction.guild.members.fetch(interaction.user.id);
                    const role = server && server.discordRoleId
                        ? interaction.guild.roles.cache.find(role => role.id === server.discordRoleId)
                        : null;
                    if (!role) {
                        sessionLogger.warn('RoleAssigner', `No role for button ${interaction.customId}`);
                        await interaction.reply({ content: "This role is not available right now.", ephemeral: true });
                        return;
                    }

                    if (guildMember.roles.cache.has(role.id)) {
                        await guildMember.roles.remove(role);
                        await rememberOptOut(interaction.user.id, server.tag, true);
                        sessionLogger.info('RoleAssigner', `${interaction.user.globalName} disabled role for ${server.name}`);
                        replyMessage = `Role for ${server.name} **removed**!`;
                    } else {
                        await guildMember.roles.add(role);
                        await rememberOptOut(interaction.user.id, server.tag, false);
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

        /**
         * Remembers which way somebody used a button, so the playtime sync in roleSync
         * does not hand back a role they just took off. Never throws - a Mongo hiccup must
         * not cost the member their button.
         * @param {string} discordId Who clicked.
         * @param {string} tag Pack tag on the button.
         * @param {boolean} optedOut True when the role was removed.
         */
        async function rememberOptOut(discordId, tag, optedOut) {
            try {
                if (optedOut) await mongo.recordPackRoleOptOut(discordId, tag);
                else await mongo.clearPackRoleOptOut(discordId, tag);
            } catch (error) {
                sessionLogger.error('RoleAssigner', `Could not record the ${tag} opt-out for ${discordId}:`, error.message);
            }
        }

        async function buildButtons() {
            let serverList = await yggdrasil.getServers();
            let serverListFull = await addMentionButton(serverList);
            serverListFull = await addBifrostButton(serverListFull);

            // One row per tag. The role id comes from every instance, never from the first one.
            const { packs, conflicts, hidden } = packButtons(serverListFull);
            for (const { tag, roleIds } of conflicts) {
                const key = `${tag}:${roleIds.join(',')}`;
                if (loggedConflicts.has(key)) continue;
                loggedConflicts.add(key);
                sessionLogger.warn('RoleAssigner', `The instances of ${tag} carry different role ids (${roleIds.join(', ')}). No button for ${tag} until they match.`);
            }

            await trackReleases(packs, hidden);

            serverList = packs.filter(server => server.discordRoleId);
            const serverListMissing = packs.filter(server => !server.discordRoleId);
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

            const payloadHash = crypto.createHash('sha1')
                .update(JSON.stringify(actionRowsChunks.map(rows => rows.map(row => row.toJSON()))))
                .digest('hex');
            if (payloadHash === lastPayloadHash && messages.size === actionRowsChunks.length) return;

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
            lastPayloadHash = payloadHash;
        }

        /**
         * Keeps the release state of the roles VU created. A hidden tag that holds such a role
         * marks it as waiting for a release. When its pack turns visible, the role takes the
         * pack's real tag and name once. A role VU did not create is never renamed. Never throws:
         * the buttons must not wait on Mongo or the audit log.
         */
        async function trackReleases(packs, hidden) {
            try {
                if (!ownedRoles) {
                    const rows = await mongo.findAssignerRoles();
                    ownedRoles = new Map(rows.map(row => [row.roleId, row]));
                }
                const channel = await client.channels.fetch(options.roleChannelId);
                const guild = channel.guild;

                const unknown = [...new Set(hidden.map(h => h.discordRoleId))]
                    .filter(roleId => roleId && !ownedRoles.has(roleId) && !auditChecked.has(roleId));
                let created = new Set();
                if (unknown.length > 0) {
                    const auditLog = await guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 100 });
                    created = createdByAssigner(auditLog.entries.values(), client.user.id);
                    for (const roleId of unknown) {
                        if (!created.has(roleId)) auditChecked.add(roleId);
                    }
                }

                for (const { roleId, tag } of pendingMarks(hidden, ownedRoles, created)) {
                    await mongo.recordAssignerRole(roleId, tag, true, 'audit_log');
                    ownedRoles.set(roleId, { roleId, tag, pendingRelease: true });
                    sessionLogger.info('RoleAssigner', `Role ${roleId} of hidden ${tag} waits for the release`);
                }

                for (const { roleId, tag, name } of releasedRoles(packs, hidden, ownedRoles)) {
                    const role = guild.roles.cache.get(roleId);
                    if (role && role.name !== name) {
                        const oldName = role.name;
                        await role.setName(name, 'The pack of this role is released.');
                        sessionLogger.info('RoleAssigner', `Renamed role ${roleId} from ${oldName} to ${name}: ${tag} is released`);
                    }
                    await mongo.recordAssignerRole(roleId, tag, false, 'audit_log');
                    ownedRoles.set(roleId, { roleId, tag, pendingRelease: false });
                }
                lastTrackError = null;
            } catch (error) {
                if (error.message !== lastTrackError) {
                    sessionLogger.error('RoleAssigner', 'Could not track the roles of hidden packs:', error.message);
                }
                lastTrackError = error.message;
            }
        }

        async function generateNewRoles(serverList) {
            for (let server of serverList) {
                sessionLogger.info('RoleAssigner', `Generating new role for ${server.name}`);
                const channel = await client.channels.fetch(options.roleChannelId);

                const newRole = await channel.guild.roles.create({
                    name: roleName(server),
                    reason: ROLE_REASON
                });

                await yggdrasil.updateServer(server.tag, {
                    discord_role_id: newRole.id
                });

                try {
                    await mongo.recordAssignerRole(newRole.id, server.tag, false, 'created');
                    if (ownedRoles) ownedRoles.set(newRole.id, { roleId: newRole.id, tag: server.tag, pendingRelease: false });
                } catch (error) {
                    sessionLogger.warn('RoleAssigner', `Could not record the new role ${newRole.id} of ${server.tag}: ${error.message}`);
                }
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

            const resizedBuffer = await sharp(buffer)
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

        async function addBifrostButton(serverList) {
            if (!options.BifrostRoleId) return serverList;

            const channel = await client.channels.fetch(options.roleChannelId);

            let role = channel.guild.roles.cache.find(role => role.id === options.BifrostRoleId);
            if (!role) return serverList;

            let bifrostObj = {
                name: role.name,
                tag: role.name.toLowerCase(),
                discordRoleId: role.id
            };

            serverList.unshift(bifrostObj);
            return serverList;
        }

        const safeBuildButtons = () => buildButtons().catch(error =>
            sessionLogger.error('RoleAssigner', 'Failed to build role buttons (will retry next interval):', error.message));
        safeBuildButtons();
        setInterval(safeBuildButtons, options.interval * 60 * 1000);
    }

};

module.exports.packButtons = packButtons;
module.exports.createdByAssigner = createdByAssigner;
module.exports.pendingMarks = pendingMarks;
module.exports.releasedRoles = releasedRoles;
module.exports.ROLE_REASON = ROLE_REASON;