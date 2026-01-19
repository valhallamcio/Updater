/*
 * File: updateManager.js
 * Project: valhalla-updater
 * File Created: Saturday, 11th May 2024 3:52:12 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 25th July 2024 5:56:15 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const fs = require('fs');
const {
    decompress,
    compressDirectory
} = require('../modules/compressor');
const comparator = require('../modules/comparator');
const merger = require('../modules/merger');
const {
    sleep,
    checkMods,
    getVersion,
    rmRecursive
} = require('../modules/functions');
const curseforge = require('../modules/curseforge');
const {
    download,
    upload
} = require('../modules/downloader');
const pterodactyl = require('../modules/pterodactyl');
const {
    unpack
} = require('../modules/unpacker');
const modpacksch = require('../modules/modpacksch');
const {
    alertScheduledUpdate,
    updateMessage
} = require('../config/messages.json');
const mongo = require('../modules/mongo');
const {
    sendWebhook
} = require('../discord/webhook');
const manifest = require('../modules/manifest');
const { verify } = require('crypto');
const sessionLogger = require('../modules/sessionLogger');
const {
    active,
    announcementChannelId
} = require("../config/config.json").discord;


/*  REFERENCE  */
let newpack = {
    //_id: new ObjectId('6638d513fb984056c222f480'),
    hostname: '',
    port: 10004,
    tag: 'ske',
    desc: '',
    discord_role_id: '',
    name: 'FTB Skies Expert',
    server_version: '1.19.2',
    modpack_version: '1.8.1',
    genre: '',
    early_access: false,
    color: 'blue',
    serverId: 'asdadas',
    image: '',
    rtp_max_range: '10000',
    rtp_min_range: '250',
    modpackID: 117,
    fileID: 11927,
    rtp_cooldown: '600',
    newestFileID: 11927,
    platform: 'feedthebeast',
    requiresUpdate: false
};
/*  REFERENCE  */

module.exports = {

    /**
     * Updates the server with the latest version of the modpack. (CurseForge)
     * @param {object} pack Object with the server data.
     * @param {object} interaction Object with the interaction data.(for Discord)
     */

    updateCF: async function (pack, versionOverride, interaction) {

        const packManifest = await modpacksch.getCFPackManifest(pack.modpackID, pack.newestFileID);

        let newVersionNumber = getVersion(packManifest.name);
        if (versionOverride) newVersionNumber = versionOverride;

        const alert = alertScheduledUpdate.replace("[NEWVERSION]", newVersionNumber);

        let progressLog = `Update sequence started for **${pack.name}** (${pack.modpack_version} -> ${newVersionNumber}).`;
        await interaction.edit(progressLog);

        await pterodactyl.sendCommand(pack.serverId, alert);

        let newestServerPackID = await curseforge.getServerFileId(pack.modpackID, pack.newestFileID);
        let currentServerPackID = await curseforge.getServerFileId(pack.modpackID, pack.fileID);

        // Fallback mechanism using additional files endpoint
        if (newestServerPackID === null) {
            progressLog += `\n- Could not find primary server pack ID for new version (${pack.newestFileID}). Checking additional files...`;
            await interaction.edit(progressLog);
            newestServerPackID = await curseforge.getAdditionalServerFileId(pack.modpackID, pack.newestFileID);
            if (newestServerPackID !== null) {
                 progressLog += ` Found fallback ID: ${newestServerPackID}.`;
                 await interaction.edit(progressLog);
            } else {
                 progressLog += ` No fallback found.`;
                 await interaction.edit(progressLog);
            }
        }
        if (currentServerPackID === null) {
            progressLog += `\n- Could not find primary server pack ID for current version (${pack.fileID}). Checking additional files...`;
            await interaction.edit(progressLog);
            currentServerPackID = await curseforge.getAdditionalServerFileId(pack.modpackID, pack.fileID);
             if (currentServerPackID !== null) {
                 progressLog += ` Found fallback ID: ${currentServerPackID}.`;
                 await interaction.edit(progressLog);
            } else {
                 progressLog += ` No fallback found.`;
                 await interaction.edit(progressLog);
            }
        }

        // Re-check IDs after fallback attempt
        if (newestServerPackID === null && currentServerPackID === null) {
            progressLog += `\n- Could not find server pack IDs for **both** the current version (${pack.fileID}) and the new version (${pack.newestFileID}) even after checking additional files. Aborting update.`;
            await interaction.edit(progressLog);
            return;
        } else if (newestServerPackID === null) {
            progressLog += `\n- Could not find server pack ID for the new version (${pack.newestFileID}) even after checking additional files. Aborting update.`;
            await interaction.edit(progressLog);
            return;
        } else if (currentServerPackID === null) {
            progressLog += `\n- Could not find server pack ID for the current version (${pack.fileID}) even after checking additional files. Aborting update.`;
            await interaction.edit(progressLog);
            return;
        }

        const newestServerpackURL = await curseforge.getFileLink(pack.modpackID, newestServerPackID);
        const currentServerPackURL = await curseforge.getFileLink(pack.modpackID, currentServerPackID);

        rmRecursive(`./${pack.tag}`);

        progressLog += `\n- Downloading new server pack...`;
        await interaction.edit(progressLog);
        await download(newestServerpackURL, `./${pack.tag}/downloads/new/${pack.tag}_${newestServerPackID}.zip`);

        await pterodactyl.sendCommand(pack.serverId, alert);

        progressLog += ` Done!\n- Downloading reference server pack...`;
        await interaction.edit(progressLog);
        await download(currentServerPackURL, `./${pack.tag}/downloads/old/${pack.tag}_${currentServerPackID}.zip`);

        await pterodactyl.sendCommand(pack.serverId, alert);

        progressLog += ` Done!\n- Decompressing new pack files...`;
        await interaction.edit(progressLog);
        await decompress(`./${pack.tag}/downloads/new/${pack.tag}_${newestServerPackID}.zip`, `./${pack.tag}/compare/new`);
        await checkMods(`./${pack.tag}/compare/new`);

        await pterodactyl.sendCommand(pack.serverId, alert);

        progressLog += ` Done!\n- Decompressing reference pack files...`;
        await interaction.edit(progressLog);
        await decompress(`./${pack.tag}/downloads/old/${pack.tag}_${currentServerPackID}.zip`, `./${pack.tag}/compare/old`);
        await checkMods(`./${pack.tag}/compare/old`);

        await pterodactyl.sendCommand(pack.serverId, alert);

        let toCompressList = [];

        await fs.readdirSync(`./${pack.tag}/compare/old`).forEach(file => {
            toCompressList.push(file);
        });

        progressLog += ` Done!\n- Shutting down the server...`;
        await interaction.edit(progressLog);
        await pterodactyl.shutdown(pack.serverId);

        progressLog += ` Done!\n- Compressing and downloading current server files...`;
        await interaction.edit(progressLog);
        const compress = await pterodactyl.compressFile(pack.serverId, toCompressList);

        const downloadLink = await pterodactyl.getDownloadLink(pack.serverId, compress);
        await download(downloadLink, `./vault/${pack.tag}/${pack.tag}_${pack.modpack_version}_${pack.fileID}.tar.gz`);

        await sleep(1000);
        await pterodactyl.deleteFile(pack.serverId, [compress]);

        progressLog += ` Done!\n- Unpacking current server files...`;
        await interaction.edit(progressLog);
        await unpack(`./vault/${pack.tag}/${pack.tag}_${pack.modpack_version}_${pack.fileID}.tar.gz`, `./${pack.tag}/compare/main`);

        progressLog += ` Done!\n- Comparing changes...`;
        await interaction.edit(progressLog);
        const customChanges = await comparator.findCustomChanges(`./${pack.tag}/compare/main`, `./${pack.tag}/compare/old`);
        const changeList = await comparator.compare(`./${pack.tag}/compare/old`, `./${pack.tag}/compare/new`);

        progressLog += ` Done!\n- **Custom files**: ${customChanges.customFiles.length}, **Missing files**: ${customChanges.missingFiles.length}, **Edited files**: ${customChanges.editedFiles.length}`;
        progressLog += `\n- **Files to delete**: ${changeList.deletions.length}, **Files to add**: ${changeList.additions.length}`;
        const overWrites = customChanges.editedFiles.filter(file => changeList.additions.includes(file));

        let printOverWrite = " ";
        for (let f of overWrites) {
            printOverWrite += `\n - ${f}`;
        }

        if (printOverWrite.length > 700) {
            progressLog += `\n- **Overwrites**: ${overWrites.length} files: Too many to list.`;
        } else {
            progressLog += `\n- **Overwrites**: ${overWrites.length} files: ${printOverWrite}`;
        }
        await interaction.edit(progressLog);

        progressLog += `\n- Merging changes...`;
        await interaction.edit(progressLog);
        await merger.merge(`./${pack.tag}`, changeList);

        progressLog += ` Done!\n- Compressing merged server pack...`;
        await interaction.edit(progressLog);
        await compressDirectory(`${pack.tag}/compare/main`, `${pack.tag}/update_${pack.tag}_${pack.newestFileID}.zip`);

        progressLog += ` Done!\n- Uploading compressed update to the server...`;
        await interaction.edit(progressLog);
        const uploadUrl = await pterodactyl.getUploadLink(pack.serverId);
        await upload(`${pack.tag}/update_${pack.tag}_${pack.newestFileID}.zip`, uploadUrl);


        //DANGER ZONE - LINES BELOW MODIFY THE SERVER FILES ON LIVE BRANCH

        progressLog += ` Done!\n- Unpacking the update...`;
        await interaction.edit(progressLog);
        await pterodactyl.deleteFile(pack.serverId, toCompressList);
        await sleep(1000);
        await pterodactyl.decompressFile(pack.serverId, `update_${pack.tag}_${pack.newestFileID}.zip`);
        await sleep(1000);
        await pterodactyl.deleteFile(pack.serverId, [`update_${pack.tag}_${pack.newestFileID}.zip`]);

        //DANGER ZONE - LINES ABOVE MODIFY THE SERVER FILES ON LIVE BRANCH


        progressLog += ` Done!\n- Starting the server...`;
        await interaction.edit(progressLog);
        await pterodactyl.sendPowerAction(pack.serverId, "start");

        progressLog += ` Done!\n- Update sequence completed. Cleaning up...`;
        await interaction.edit(progressLog);
        rmRecursive(`./${pack.tag}`);

        progressLog += ` Done!\n- Updating data and sending update message...`;
        await interaction.edit(progressLog);
        let dbUpdate = {
            $set: {
                modpack_version: newVersionNumber,
                fileID: pack.newestFileID,
                newestFileID: pack.newestFileID,
                requiresUpdate: false
            }
        };
        mongo.updateServer(pack.serverId, dbUpdate);

        //TODO ai summary ???
        const packData = await curseforge.getPackData(pack.modpackID);
        const updateMessageContent = updateMessage.replace("[PACKNAME]", pack.name)
            .replace("[NEWVERSION]", newVersionNumber)
            .replace("[OLDVERSION]", pack.modpack_version)
            .replace("[CHANGELOGURL]", `https://www.curseforge.com/minecraft/modpacks/${packData.slug}/files/${pack.newestFileID}`)
            .replace("[PINGROLE]", `<@&${pack.discord_role_id}>`)
            .replace("[SUMMARY]", "");

        const updateWebhook = {
            content: updateMessageContent,
            username: pack.name,
            avatarURL: packData.logo.url,
        };

        await sendWebhook(announcementChannelId, updateWebhook);

    },

    /**
     * Updates the server with the latest version of the modpack. (Feed The Beast)
     * @param {object} pack Object with the server data.
     * @param {object} interaction Object with the interaction data.(for Discord)
     */
    updateFTB: async function (pack, versionOverride, interaction) {
        const newManifest = await modpacksch.getFTBPackManifest(pack.modpackID, pack.newestFileID);

        let newVersionNumber = getVersion(newManifest.name);
        if (versionOverride) newVersionNumber = versionOverride;

        const alert = alertScheduledUpdate.replace("[NEWVERSION]", newVersionNumber);

        let progressLog = `Update sequence started for **${pack.name}** (${pack.modpack_version} -> ${newVersionNumber}).`;
        await interaction.edit(progressLog);

        await pterodactyl.sendCommand(pack.serverId, alert);

        progressLog += `\n- Getting pack manifests...`;
        await interaction.edit(progressLog);


        const oldManifest = await modpacksch.getFTBPackManifest(pack.modpackID, pack.fileID);

        // Diagnostic logging for manifest structures
        sessionLogger.info('UpdateManager', `Old manifest has ${oldManifest.files.length} files`);
        sessionLogger.info('UpdateManager', `Sample old manifest file: ${JSON.stringify(oldManifest.files[0])}`);
        sessionLogger.info('UpdateManager', `New manifest has ${newManifest.files.length} files`);
        sessionLogger.info('UpdateManager', `Sample new manifest file: ${JSON.stringify(newManifest.files[0])}`);

        rmRecursive(`./${pack.tag}`);

        await pterodactyl.sendCommand(pack.serverId, alert);

        let toCompressList = [];
        for (let file of oldManifest.files) {
            if (file.path === "./") toCompressList.push(file.name);
            const match = file.path.match(/\/([^/]+)/);
            const path = match ? match[1] : null;
            if (!toCompressList.includes(path) && path != null) toCompressList.push(path);
        }

        // Diagnostic logging for toCompressList
        sessionLogger.info('UpdateManager', `Generated toCompressList with ${toCompressList.length} items`);
        sessionLogger.info('UpdateManager', `toCompressList contents: ${JSON.stringify(toCompressList)}`);

        await sleep(5000);

        await pterodactyl.sendCommand(pack.serverId, alert);

        progressLog += ` Done!\n- Shutting down the server...`;
        await interaction.edit(progressLog);
        await pterodactyl.shutdown(pack.serverId);

        progressLog += ` Done!\n- Compressing and downloading current server files...`;
        await interaction.edit(progressLog);
        const compress = await pterodactyl.compressFile(pack.serverId, toCompressList);

        const downloadLink = await pterodactyl.getDownloadLink(pack.serverId, compress);
        await download(downloadLink, `./vault/${pack.tag}/${pack.tag}_${pack.modpack_version}_${pack.fileID}.tar.gz`);

        await sleep(1000);
        await pterodactyl.deleteFile(pack.serverId, [compress]);

        progressLog += ` Done!\n- Unpacking current server files...`;
        await interaction.edit(progressLog);
        await unpack(`./vault/${pack.tag}/${pack.tag}_${pack.modpack_version}_${pack.fileID}.tar.gz`, `./${pack.tag}/compare/main`);

        progressLog += ` Done!\n- Generating current server manifest...`;
        await interaction.edit(progressLog);

        const currentManifest = await manifest.generate(`./${pack.tag}/compare/main`);

        progressLog += ` Done!\n- Comparing changes...`;
        await interaction.edit(progressLog);

        const oldFilelist = oldManifest.files.filter(obj => !obj.clientonly);
        const newFilelist = newManifest.files.filter(obj => !obj.clientonly);

        const customChanges = await comparator.findCustomManifestChanges(currentManifest, oldFilelist);
        const changeList = await comparator.findManifestChanges(oldFilelist, newFilelist);

        progressLog += ` Done!\n- **Custom files**: ${customChanges.customFiles.length}, **Missing files**: ${customChanges.missingFiles.length}, **Edited files**: ${customChanges.editedFiles.length}`;
        progressLog += `\n- **Files to delete**: ${changeList.deletions.length}, **Files to add**: ${changeList.additions.length}`;
        const overWrites = customChanges.editedFiles.filter(file => changeList.additions.includes(file));

        let printOverWrite = " ";
        for (let f of overWrites) {
            printOverWrite += `\n - ${f}`;
        }

        if (printOverWrite.length > 700) {
            progressLog += `\n- **Overwrites**: ${overWrites.length} files: Too many to list.`;
        } else {
            progressLog += `\n- **Overwrites**: ${overWrites.length} files: ${printOverWrite}`;
        }
        await interaction.edit(progressLog);

        progressLog += `\n- Merging changes...`;
        await interaction.edit(progressLog);

        await merger.mergeFromManifest(`./${pack.tag}/compare/main`, changeList, newManifest);

        progressLog += ` Done!\n- Compressing merged server pack...`;
        await interaction.edit(progressLog);
        await compressDirectory(`${pack.tag}/compare/main`, `${pack.tag}/update_${pack.tag}_${pack.newestFileID}.zip`);

        progressLog += ` Done!\n- Uploading compressed update to the server...`;
        await interaction.edit(progressLog);
        const uploadUrl = await pterodactyl.getUploadLink(pack.serverId);
        await upload(`${pack.tag}/update_${pack.tag}_${pack.newestFileID}.zip`, uploadUrl);


        //DANGER ZONE - LINES BELOW MODIFY THE SERVER FILES ON LIVE BRANCH

        progressLog += ` Done!\n- Unpacking the update...`;
        await interaction.edit(progressLog);
        await pterodactyl.deleteFile(pack.serverId, toCompressList);
        await sleep(1000);
        await pterodactyl.decompressFile(pack.serverId, `update_${pack.tag}_${pack.newestFileID}.zip`);
        await sleep(1000);
        await pterodactyl.deleteFile(pack.serverId, [`update_${pack.tag}_${pack.newestFileID}.zip`]);

        //DANGER ZONE - LINES ABOVE MODIFY THE SERVER FILES ON LIVE BRANCH


        progressLog += ` Done!\n- Starting the server...`;
        await interaction.edit(progressLog);
        await pterodactyl.sendPowerAction(pack.serverId, "start");

        progressLog += ` Done!\n- Update sequence completed. Cleaning up...`;
        await interaction.edit(progressLog);
        rmRecursive(`./${pack.tag}`);

        progressLog += ` Done!\n- Updating data and sending update message...`;
        await interaction.edit(progressLog);
        let dbUpdate = {
            $set: {
                modpack_version: newVersionNumber,
                fileID: pack.newestFileID,
                newestFileID: pack.newestFileID,
                requiresUpdate: false
            }
        };
        await mongo.updateServer(pack.serverId, dbUpdate);

        //TODO ai summary ???
        const packData = await modpacksch.getFTBPackData(pack.modpackID);
        const updateMessageContent = updateMessage.replace("[PACKNAME]", pack.name)
            .replace("[NEWVERSION]", newVersionNumber)
            .replace("[OLDVERSION]", pack.modpack_version)
            .replace("[CHANGELOGURL]", `https://www.feed-the-beast.com/modpacks/${pack.modpackID}?tab=versions`)
            .replace("[PINGROLE]", `<@&${pack.discord_role_id}>`)
            .replace("[SUMMARY]", "");

        const updateWebhook = {
            content: updateMessageContent,
            username: pack.name,
            avatarURL: packData.art[0].url,
        };

        await sendWebhook(announcementChannelId, updateWebhook);
    },

    /**
     * Restores an update from the list of available versions. Pterodactyl has trouble unpacking tar.gz files, so it repacks the backup to a zip file first.
     * @param {object} pack Object containing the server data.
     * @param {string} backup The backup file to restore from.
     * @param {object} interaction Object containing the interaction data. (for Discord)
     */
    restore: async function (pack, backup, interaction) {

        let restoredPackData = backup.match(/^.+?_(.+)_(.+)\.tar\.gz$/);

        let progressLog = `Restore sequence started for **${pack.name}** (${pack.modpack_version} -> ${restoredPackData[1]}).`;
        await interaction.edit(progressLog);

        progressLog += `\n- Shutting down the server...`;
        await interaction.edit(progressLog);
        await pterodactyl.shutdown(pack.serverId);

        progressLog += ` Done!\n- Repacking backup to zip...`;
        await interaction.edit(progressLog);
        await unpack(`./vault/${pack.tag}/${pack.tag}_${restoredPackData[1]}_${restoredPackData[2]}.tar.gz`, `./${pack.tag}/backup`);

        await compressDirectory(`${pack.tag}/backup`, `${pack.tag}/${pack.tag}_${restoredPackData[1]}_${restoredPackData[2]}.zip`);

        progressLog += ` Done!\n- Uploading backup to the server...`;
        await interaction.edit(progressLog);
        const uploadUrl = await pterodactyl.getUploadLink(pack.serverId);
        await upload(`${pack.tag}/${pack.tag}_${restoredPackData[1]}_${restoredPackData[2]}.zip`, uploadUrl);

        progressLog += ` Done!\n- Deleting update files...`;
        await interaction.edit(progressLog);

        let toDeleteList = [];

        await fs.readdirSync(`./${pack.tag}/backup`).forEach(file => {
            toDeleteList.push(file);
        });

        // DANGER ZONE - LINES BELOW MODIFY THE SERVER FILES ON LIVE BRANCH

        await pterodactyl.deleteFile(pack.serverId, toDeleteList);
        await sleep(1000);

        progressLog += ` Done!\n- Unpacking the backup...`;
        await interaction.edit(progressLog);

        await pterodactyl.decompressFile(pack.serverId, `${pack.tag}_${restoredPackData[1]}_${restoredPackData[2]}.zip`);
        await sleep(1000);
        await pterodactyl.deleteFile(pack.serverId, [`${pack.tag}_${restoredPackData[1]}_${restoredPackData[2]}.zip`]);

        // DANGER ZONE - LINES ABOVE MODIFY THE SERVER FILES ON LIVE BRANCH

        /*progressLog += ` Done!\n- Starting the server...`;
        await interaction.edit(progressLog);

        await pterodactyl.sendPowerAction(pack.serverId, "start");*/
        rmRecursive(`./${pack.tag}`);

        progressLog += ` Done!\n- Restore sequence completed. Updating data...`;
        await interaction.edit(progressLog);

        let dbUpdate = {
            $set: {
                modpack_version: restoredPackData[1],
                fileID: restoredPackData[2],
                requiresUpdate: true
            }
        };
        await mongo.updateServer(pack.serverId, dbUpdate);

    },

    /**
     * Updates the server with the latest version of the GregTech New Horizons modpack.
     * @param {object} pack Object with the server data.
     * @param {string} versionOverride Optional specific version to update to.
     * @param {object} interaction Object with the interaction data (for Discord).
     */
    updateGTNH: async function (pack, versionOverride, interaction) {
        const gtnh = require('../modules/gregtechnewhorizons');
        
        // Get current and latest version URLs
        let currentVersionUrl = null;
        let newestVersionUrl = null;
        
        // If version override is specified, use that version
        if (versionOverride) {
            // Find the specific version in available versions
            const allVersions = await gtnh.getAllVersions();
            newestVersionUrl = allVersions.find(url => url.includes(`GT_New_Horizons_${versionOverride}_Server_Java_17-21.zip`));
            
            if (!newestVersionUrl) {
                const errorMsg = `Version ${versionOverride} not found in available GTNH versions!`;
                sessionLogger.error('UpdateManager', errorMsg);
                await interaction.edit(errorMsg);
                return;
            }
        } else {
            // Get the latest version
            newestVersionUrl = await gtnh.getLatestVersion();
        }
        
        // Get current version based on pack info
        const allVersions = await gtnh.getAllVersions();
        currentVersionUrl = allVersions.find(url => url.includes(`GT_New_Horizons_${pack.modpack_version}_Server_Java_17-21.zip`));
        
        if (!currentVersionUrl) {
            const errorMsg = `Current version ${pack.modpack_version} not found in available GTNH versions!`;
            sessionLogger.error('UpdateManager', errorMsg);
            await interaction.edit(errorMsg);
            return;
        }
        
        // Extract version numbers for display
        const currentVersion = gtnh.extractVersionFromUrl(currentVersionUrl);
        const newestVersion = gtnh.extractVersionFromUrl(newestVersionUrl);
        
        if (currentVersion === newestVersion) {
            const msg = `Server is already on the latest version (${currentVersion})!`;
            sessionLogger.info('UpdateManager', msg);
            await interaction.edit(msg);
            return;
        }
        
        // Start the update process
        const alert = alertScheduledUpdate.replace("[NEWVERSION]", newestVersion);
        let progressLog = `Update sequence started for **${pack.name}** (${currentVersion} -> ${newestVersion}).`;
        await interaction.edit(progressLog);
        
        // Send update alert to server
        await pterodactyl.sendCommand(pack.serverId, alert);
          // Clear working directory
        rmRecursive(`./${pack.tag}`);
        
        // Check if we have valid version information
        if (!newestVersion || !currentVersion) {
            const errorMsg = `Failed to extract version information from URLs. Current: ${currentVersionUrl}, Newest: ${newestVersionUrl}`;
            sessionLogger.error('UpdateManager', errorMsg);
            await interaction.edit(errorMsg);
            return;
        }
        
        // Download server packs
        progressLog += `\n- Downloading new server pack (version ${newestVersion})...`;
        await interaction.edit(progressLog);
        await download(newestVersionUrl, `./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`);
        
        await pterodactyl.sendCommand(pack.serverId, alert);
        
        progressLog += ` Done!\n- Downloading reference server pack (version ${currentVersion})...`;
        await interaction.edit(progressLog);
        await download(currentVersionUrl, `./${pack.tag}/downloads/old/${pack.tag}_${currentVersion}.zip`);
        
        await pterodactyl.sendCommand(pack.serverId, alert);
        
        // Extract packs
        progressLog += ` Done!\n- Decompressing new pack files...`;
        await interaction.edit(progressLog);
        await decompress(`./${pack.tag}/downloads/new/${pack.tag}_${newestVersion}.zip`, `./${pack.tag}/compare/new`);
        await checkMods(`./${pack.tag}/compare/new`);
        
        await pterodactyl.sendCommand(pack.serverId, alert);
        
        progressLog += ` Done!\n- Decompressing reference pack files...`;
        await interaction.edit(progressLog);
        await decompress(`./${pack.tag}/downloads/old/${pack.tag}_${currentVersion}.zip`, `./${pack.tag}/compare/old`);
        await checkMods(`./${pack.tag}/compare/old`);
        
        await pterodactyl.sendCommand(pack.serverId, alert);
        
        // Get current server files
        let toCompressList = [];
        await fs.readdirSync(`./${pack.tag}/compare/old`).forEach(file => {
            toCompressList.push(file);
        });
        
        progressLog += ` Done!\n- Shutting down the server...`;
        await interaction.edit(progressLog);
        await pterodactyl.shutdown(pack.serverId);
        
        progressLog += ` Done!\n- Compressing and downloading current server files...`;
        await interaction.edit(progressLog);
        const compress = await pterodactyl.compressFile(pack.serverId, toCompressList);
        
        const downloadLink = await pterodactyl.getDownloadLink(pack.serverId, compress);
        await download(downloadLink, `./vault/${pack.tag}/${pack.tag}_${pack.modpack_version}_${currentVersion}.tar.gz`);
        
        await sleep(1000);
        await pterodactyl.deleteFile(pack.serverId, [compress]);
        
        progressLog += ` Done!\n- Unpacking current server files...`;
        await interaction.edit(progressLog);
        await unpack(`./vault/${pack.tag}/${pack.tag}_${pack.modpack_version}_${currentVersion}.tar.gz`, `./${pack.tag}/compare/main`);
        
        progressLog += ` Done!\n- Comparing changes...`;
        await interaction.edit(progressLog);
        // Compare old reference pack with new reference pack
        const changeList = await comparator.compare(`./${pack.tag}/compare/old`, `./${pack.tag}/compare/new`);
        // Compare current server files with old reference pack to find customizations
        const customChanges = await comparator.findCustomChanges(`./${pack.tag}/compare/main`, `./${pack.tag}/compare/old`);

        progressLog += ` Done!\n- **Custom files**: ${customChanges.customFiles.length}, **Missing files**: ${customChanges.missingFiles.length}, **Edited files**: ${customChanges.editedFiles.length}`;
        progressLog += `\n- **Files to delete**: ${changeList.deletions.length}, **Files to add**: ${changeList.additions.length}`;
        // Identify standard files that would overwrite user edits (though merge logic should handle this)
        const overWrites = customChanges.editedFiles.filter(file => changeList.additions.some(addition => addition.path === file.path));

        let printOverWrite = " ";
        for (let f of overWrites) {
            printOverWrite += `\n - ${f.path}`; // Assuming editedFiles contains objects with a path property
        }

        if (printOverWrite.length > 700) {
            progressLog += `\n- **Potential Overwrites (Check Merge)**: ${overWrites.length} files: Too many to list.`;
        } else {
            progressLog += `\n- **Potential Overwrites (Check Merge)**: ${overWrites.length} files: ${printOverWrite}`;
        }
        await interaction.edit(progressLog);

        // Helper function to get full relative path from various possible inputs
        function getPathFromEntry(entry) {
            if (typeof entry === 'string') {
                // If it's already a string path
                return entry.startsWith('/') ? entry.substring(1) : entry;
            } else if (typeof entry === 'object' && entry !== null) {
                // If it's an object from the comparator
                const objPath = entry.path;
                const objName = entry.name || entry.name1 || entry.name2;

                if (typeof objPath === 'string' && typeof objName === 'string') {
                    let fullPath = objPath.endsWith('/') ? objPath + objName : objPath + '/' + objName;
                    fullPath = fullPath.replace(/\/+/g, '/'); // Replace multiple slashes with one
                    return fullPath.startsWith('/') ? fullPath.substring(1) : fullPath;
                } else if (typeof entry.relativePath === 'string') {
                    // Handle potential alternative structure { relativePath: '...' }
                     return entry.relativePath.startsWith('/') ? entry.relativePath.substring(1) : entry.relativePath;
                }
            }
            // If input is invalid or path cannot be determined
            sessionLogger.warn('UpdateManager', 'Could not determine path from entry:', entry);
            return null;
        }

        // Filter out excluded files/folders from the standard change list BEFORE merging
        progressLog += `\n- Filtering excluded files from change list...`;
        await interaction.edit(progressLog);

        const originalDeletionCount = changeList.deletions.length;
        const originalAdditionCount = changeList.additions.length;

        // Create NEW filtered lists, don't modify original changeList directly yet
        const filteredDeletions = changeList.deletions.filter(entry => {
            const path = getPathFromEntry(entry);
            // Ensure path is valid before checking exclusion
            return typeof path === 'string' && !gtnh.isExcluded(path);
        });

        const filteredAdditions = changeList.additions.filter(entry => {
            const path = getPathFromEntry(entry);
            // Ensure path is valid before checking exclusion
            return typeof path === 'string' && !gtnh.isExcluded(path);
        });

        // Create a new object for the merge operation containing only filtered changes
        const filteredChangeList = {
            deletions: filteredDeletions,
            additions: filteredAdditions
        };

        const filteredDeletionCount = filteredDeletions.length;
        const filteredAdditionCount = filteredAdditions.length;

        progressLog += ` Done! Filtered ${originalDeletionCount - filteredDeletionCount} deletions and ${originalAdditionCount - filteredAdditionCount} additions.`;
        await interaction.edit(progressLog);

        progressLog += `\n- Merging non-excluded changes...`;
        await interaction.edit(progressLog);
        // Merge standard, *non-excluded* changes onto the current server files directory
        // Pass the NEW filteredChangeList object to the merger
        await merger.merge(`./${pack.tag}`, filteredChangeList);

        progressLog += ` Done!\n- Compressing merged server pack (preserving excluded files)...`;
        await interaction.edit(progressLog);
        const zipName = `update_${pack.tag}_${newestVersion}.zip`; // Use consistent naming
        const zipPath = `${pack.tag}/${zipName}`;
        await compressDirectory(`${pack.tag}/compare/main`, zipPath);        progressLog += ` Done!\n- Uploading compressed update to the server...`;
        await interaction.edit(progressLog);
        const uploadUrl = await pterodactyl.getUploadLink(pack.serverId);
        await upload(zipPath, uploadUrl);


        // DANGER ZONE - LINES BELOW MODIFY THE SERVER FILES ON LIVE BRANCH

        progressLog += ` Done!\n- Deleting old modpack files from server...`;
        await interaction.edit(progressLog);
        
        // This is similar to the CurseForge and FTB update methods - delete all
        // top-level directories from old modpack, but preserve excluded files
        await pterodactyl.deleteFile(pack.serverId, toCompressList.filter(item => {
            // Don't delete excluded folders or files
            return !gtnh.isExcluded(item);
        }));
        await sleep(1000); // Give server time for deletion operation


        progressLog += ` Done!\n- Unpacking the update (will not overwrite excluded files if they weren't deleted)...`;
        await interaction.edit(progressLog);
        await pterodactyl.decompressFile(pack.serverId, zipName); // Unpack the uploaded zip
        await sleep(1000); // Give server time

        progressLog += ` Done!\n- Deleting uploaded zip archive...`;
        await interaction.edit(progressLog);
        await pterodactyl.deleteFile(pack.serverId, [zipName]); // Delete the zip

        // DANGER ZONE - LINES ABOVE MODIFY THE SERVER FILES ON LIVE BRANCH


        progressLog += ` Done!\n- Starting the server...`;
        await interaction.edit(progressLog);
        await pterodactyl.sendPowerAction(pack.serverId, "start"); // Use consistent start action

        progressLog += ` Done!\n- Update sequence completed. Cleaning up...`;
        await interaction.edit(progressLog);
        rmRecursive(`./${pack.tag}`); // Clean up temp directory

        progressLog += ` Done!\n- Updating data and sending update message...`;
        await interaction.edit(progressLog);
        // Use consistent database update
        let dbUpdate = {
            $set: {
                modpack_version: newestVersion,
                fileID: null, // GTNH doesn't use fileID concept like CF/FTB
                newestFileID: null, // GTNH doesn't use fileID concept like CF/FTB
                requiresUpdate: false
            }
        };
        await mongo.updateServer(pack.serverId, dbUpdate);

        // Use consistent webhook structure
        // Note: GTNH doesn't have a specific pack data endpoint like CF/FTB for logo/summary
        const updateMessageContent = updateMessage.replace("[PACKNAME]", pack.name)
            .replace("[NEWVERSION]", newestVersion)
            .replace("[OLDVERSION]", currentVersion) // Use the extracted currentVersion
            .replace("[CHANGELOGURL]", `https://wiki.gtnewhorizons.com/wiki/Upcoming_Features`) // Standard GTNH changelog link
            .replace("[PINGROLE]", `<@&${pack.discord_role_id}>`)
            .replace("[SUMMARY]", "Check the GTNH wiki for detailed changes."); // Placeholder summary

        const updateWebhook = {
            content: updateMessageContent,
            username: `${pack.name} Updater`, // Consistent username
            avatarURL: "", // No standard avatar for GTNH packs
        };

        if (active) {
            await sendWebhook(announcementChannelId, updateWebhook);
        }

        progressLog += ` Done!\n\n**Update completed successfully!** The server **${pack.name}** is now running GTNH version **${newestVersion}**.`;
        await interaction.edit(progressLog);
    },
    //TODO gregtech updater sequence
};
