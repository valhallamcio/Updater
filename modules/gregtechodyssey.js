/*
 * File: gregtechodyssey.js
 * Project: valhalla-updater
 * -----
 * GregTech Odyssey (GTO) adapter. The pack is only distributed as GitHub
 * release assets, so versions are resolved from release tags (0.5.5,
 * 0.5.6-beta, ...) instead of a modpack API.
 */

const axios = require('axios');
const sessionLogger = require('./sessionLogger');

const REPO = 'GregTech-Odyssey/GregTech-Odyssey';
const SERVER_ASSET = 'GregTech-Odyssey-server.zip';
const CACHE_TTL_MS = 5 * 60 * 1000;

let releaseCache = null;
let releaseCacheTime = 0;

/**
 * Maps a raw GitHub release to {tag, url, htmlUrl}, or null if it has no server asset.
 * @param {object} release Raw release object from the GitHub API.
 */
function toVersion(release) {
    const asset = release.assets.find(a => a.name === SERVER_ASSET);
    if (!asset) return null;
    return {
        tag: release.tag_name,
        url: asset.browser_download_url,
        htmlUrl: release.html_url
    };
}

module.exports = {
    /**
     * Files that legitimately differ between GTO instances (Normal vs Expert difficulty,
     * ports) and must be snapshotted/restored per server during a multi-instance deploy.
     */
    perServerFiles: [
        'config/gtocore.yaml',
        'server.properties'
    ],

    /**
     * Gets all GTO releases from GitHub, newest first. The rolling "nightly" tag is
     * deleted/recreated on every push and is the only prerelease - both are filtered out.
     * @returns {Promise<Array>} Array of raw GitHub release objects.
     */
    getAllReleases: async function () {
        if (releaseCache && Date.now() - releaseCacheTime < CACHE_TTL_MS) {
            return releaseCache;
        }
        try {
            const response = await axios.get(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
                headers: {
                    'User-Agent': 'Valhalla-Updater',
                    'Accept': 'application/vnd.github+json'
                }
            });
            const releases = response.data
                .filter(r => !r.draft && !r.prerelease && r.tag_name !== 'nightly')
                .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

            releaseCache = releases;
            releaseCacheTime = Date.now();
            return releases;
        } catch (error) {
            sessionLogger.error('GregTechOdyssey', 'Error fetching GTO releases:', error.message);
            throw error;
        }
    },

    /**
     * Gets the latest GTO version that ships a server pack asset.
     * @returns {Promise<object>} {tag, url, htmlUrl} of the latest release.
     */
    getLatestVersion: async function () {
        const releases = await this.getAllReleases();
        for (const release of releases) {
            const version = toVersion(release);
            if (version) return version;
        }
        throw new Error('No GTO release with a server pack asset found!');
    },

    /**
     * Resolves an exact release tag to its server pack download.
     * @param {string} tag Release tag (e.g. "0.5.5", "0.5.6-beta").
     * @returns {Promise<object|null>} {tag, url, htmlUrl}, or null if the tag or its server asset is missing.
     */
    resolveVersion: async function (tag) {
        const releases = await this.getAllReleases();
        const release = releases.find(r => r.tag_name === tag);
        if (!release) return null;
        return toVersion(release);
    },

    /**
     * Checks if the given file path should be preserved during update (not overwritten).
     * Called with both full relative paths and bare root names (deletion list).
     * @param {String} path File path to check.
     * @returns {Boolean} True if the file should be preserved (not overwritten).
     */
    isExcluded: function (path) {
        const preserveFiles = [
            'server.properties',
            'eula.txt',
            'ops.json',
            'whitelist.json',
            'usercache.json',
            'usernamecache.json',
            'banned-players.json',
            'banned-ips.json',
            'user_jvm_args.txt',
            'run.sh',
            'run.bat',
            'database.db',
            'stations.json',
            'config/gtocore.yaml' // per-server difficulty (Normal vs Expert) + serverLang
        ];

        const preserveFolders = [
            'world',
            'logs',
            'crash-reports',
            'backup',
            'backups',
            'local',
            '.cache',
            '.local',
            'disabled-mods-backup',
            'gtocore',
            'ldlib',
            'modernfix'
        ];

        const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');

        // Exact file match or path ending on a /-boundary (avoids foo-server.properties matches)
        if (preserveFiles.some(file => normalized === file || normalized.endsWith(`/${file}`))) {
            sessionLogger.info('GregTechOdyssey', `Preserving server config file: ${path}`);
            return true;
        }

        // Bare folder name, or anything inside/under it
        if (preserveFolders.some(folder =>
            normalized === folder ||
            normalized.startsWith(`${folder}/`) ||
            normalized.includes(`/${folder}/`))) {
            sessionLogger.info('GregTechOdyssey', `Preserving server folder content: ${path}`);
            return true;
        }

        return false;
    }
};
