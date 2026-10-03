const axios = require('axios');

module.exports = {
    /**
     * Gets the list of all available GTNH versions from the raw directory listing
     * @returns {Promise<Array>} Array of available version URLs
     */    getAllVersions: async function () {
        try {
            const response = await axios.get('https://downloads.gtnewhorizons.com/ServerPacks/?raw');
            const versions = [];
            
            // Parse the raw response to get the list of files
            const lines = response.data.split('\n');            for (const line of lines) {
                // We only care about Server_Java_17-21.zip files (not betas, not Java 8, not April Fool's editions)
                if (line.includes('GT_New_Horizons') && 
                    line.includes('Server_Java_17-21.zip') && 
                    !line.includes('/betas/') &&
                    !line.includes('Aprils_Fool')) {
                    // Extract just the filename without any URL prefixes that might be in the raw listing
                    const fileName = line.trim().split('/').pop();
                    // https: over plain http anyone on the path could swap the jars we deploy
                    const url = `https://downloads.gtnewhorizons.com/ServerPacks/${fileName}`;
                    versions.push(url);
                }
            }
            
            return versions.sort(); // Sort to ensure versions are in order
        } catch (error) {
            console.error('Error fetching GTNH versions:', error);
            throw error;
        }
    },

    /**
     * Gets the latest version of GTNH from the available versions
     * @returns {Promise<String>} URL of the latest version
     */
    getLatestVersion: async function () {
        const versions = await this.getAllVersions();
        // Return the last (latest) version based on sorting
        return versions[versions.length - 1];
    },

    /**
     * Extracts version number from GTNH URL
     * @param {String} url URL of the GTNH version
     * @returns {String} Version number (e.g., "2.7.4")
     */
    extractVersionFromUrl: function (url) {
        // Example URL: http://downloads.gtnewhorizons.com/ServerPacks/GT_New_Horizons_2.7.4_Server_Java_17-21.zip
        const match = url.match(/GT_New_Horizons_([0-9.]+)_Server_Java_17-21\.zip/);
        return match ? match[1] : null;
    },    /**
     * Checks if the given file path should be preserved during update (not overwritten)
     * @param {String} path File path to check
     * @returns {Boolean} True if the file should be preserved (not overwritten)
     */
    isExcluded: function (path) {
        const preserveFiles = [
            'server.properties',
            'usercache.json',
            'ops.json',
            'banned-players.json',
            'banned-ips.json',
            'startserver-java9.bat',
            'eula.txt',
            'startserver-java9.sh',
            'java9args.txt'
        ];
        
        const preserveFolders = [
            'serverutilities'
        ];
        
        // Check if the path matches a file that should be preserved
        if (preserveFiles.some(file => path.endsWith(file))) {
            console.log(`Preserving server config file: ${path}`);
            return true;
        }
        
        // Check if the path is within a folder that should be preserved
        if (preserveFolders.some(folder => path.includes(`/${folder}/`) || path.includes(`\\${folder}\\`))) {
            console.log(`Preserving server config folder content: ${path}`);
            return true;
        }
        
        return false;
    }
};
