/*
 * File: modpacksch.js
 * Project: Valhalla-Updater
 * File Created: Wednesday, 15th May 2024 10:36:56 pm
 * Author: flaasz
 * -----
 * Last Modified: Tuesday, 28th May 2024 1:09:36 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const axios = require('axios');
const sessionLogger = require('./sessionLogger');

module.exports = {

    /**
     * Gets the latest version of a modpack from Feed The Beast.
     * @param {number} modPackId Modpack Id from Feed The Beast.
     * @returns Id of the latest version of the modpack.
     */
    getLatestFTBVersionId: async function (modPackId) {
        let response = await axios.get(`https://api.feed-the-beast.com/v1/modpacks/public/modpack/${modPackId}`);

        return response.data.versions[response.data.versions.length - 1].id;
    },

    /**
     * Gets a manifest of the version of the modpack from Feed The Beast. (modpacks.ch)
     * @param {number} modPackId Modpack Id from Feed The Beast.
     * @param {number} modPackVersion Version of the modpack.
     * @returns Object containing the manifest of the modpack.
     */
    getFTBPackManifest: async function (modPackId, modPackVersion) {
        let response = await axios.get(`https://api.feed-the-beast.com/v1/modpacks/public/modpack/${modPackId}/${modPackVersion}`);

        // Diagnostic logging for API response structure
        sessionLogger.debug('ModpacksCH', `FTB API response type: ${typeof response.data}`);
        sessionLogger.debug('ModpacksCH', `FTB API response has files: ${Array.isArray(response.data.files)}`);
        if (response.data.files && response.data.files.length > 0) {
            sessionLogger.debug('ModpacksCH', `FTB API response files count: ${response.data.files.length}`);
        }

        return response.data;
    },

    /**
     * Gets the data of the modpack from Feed The Beast. (modpacks.ch)
     * @param {number} modPackId Modpack Id from Feed The Beast.
     * @returns Object containing the data of the modpack.
     */
    getFTBPackData: async function (modPackId) {
        let response = await axios.get(`https://api.feed-the-beast.com/v1/modpacks/public/modpack/${modPackId}`);

        return response.data;
    },


    /**
     * Gets the changelog of the version of the modpack from Feed The Beast. (modpacks.ch)
     * @param {number} modPackId Modpack Id from Feed The Beast.
     * @param {number} modPackVersion Version of the modpack.
     * @returns String containing the changelog of the modpack.
     */
    getFTBChangelog: async function (modPackId, modPackVersion) {
        let response = await axios.get(`https://api.feed-the-beast.com/v1/modpacks/public/modpack/${modPackId}/${modPackVersion}/changelog`);

        return response.data.content;
    },

    /**
     * Gets a manifest of the version of the modpack from CurseForge. (modpacks.ch)
     * @param {number} modPackId Modpack Id from CurseForge.
     * @param {number} modPackVersion Version of the modpack.
     * @returns Object containing the manifest of the modpack.
     */
    getCFPackManifest: async function (modPackId, modPackVersion) {
        let response = await axios.get(`https://api.modpacks.ch/public/curseforge/${modPackId}/${modPackVersion}`);

        return response.data;
    },

    /**
     * Gets the data of the modpack from CurseForge. (modpacks.ch)
     * @param {number} modPackId Modpack Id from CurseForge.
     * @returns Object containing the data of the modpack.
     */
    getCFPackData: async function (modPackId) {
        let response = await axios.get(`https://api.modpacks.ch/public/curseforge/${modPackId}`);

        return response.data;
    }

};