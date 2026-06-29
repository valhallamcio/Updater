/*
 * File: pterodactyl.js
 * Project: valhalla-updater
 * File Created: Saturday, 11th May 2024 8:15:21 pm
 * Author: flaasz
 * -----
 * Last Modified: Wednesday, 3rd July 2024 10:37:31 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const axios = require('axios');
const progress = require('progress');
const sessionLogger = require('./sessionLogger');
require('dotenv').config();


const pterodactylAPIKey = process.env.PTERODACTYL_APIKEY;
const {
    pterodactylHostName
} = require("../config/config.json").pterodactyl;

const header = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": `Bearer ${pterodactylAPIKey}`,
};

// API call tracking for debugging rate limits
const apiCallTracker = {
    calls: [],
    callerStats: {},

    track(endpoint, caller) {
        const now = Date.now();
        this.calls.push({ endpoint, caller, timestamp: now });

        // Track per-caller stats
        if (!this.callerStats[caller]) {
            this.callerStats[caller] = { count: 0, endpoints: {} };
        }
        this.callerStats[caller].count++;
        this.callerStats[caller].endpoints[endpoint] = (this.callerStats[caller].endpoints[endpoint] || 0) + 1;

        // Clean old entries (older than 60 seconds)
        this.calls = this.calls.filter(c => now - c.timestamp < 60000);
    },

    getStats() {
        const now = Date.now();
        const recentCalls = this.calls.filter(c => now - c.timestamp < 60000);
        const last10Seconds = this.calls.filter(c => now - c.timestamp < 10000);

        // Group by endpoint
        const byEndpoint = {};
        for (const call of recentCalls) {
            byEndpoint[call.endpoint] = (byEndpoint[call.endpoint] || 0) + 1;
        }

        // Group by caller
        const byCaller = {};
        for (const call of recentCalls) {
            byCaller[call.caller] = (byCaller[call.caller] || 0) + 1;
        }

        return {
            totalLast60s: recentCalls.length,
            totalLast10s: last10Seconds.length,
            byEndpoint,
            byCaller
        };
    },

    logStats() {
        const stats = this.getStats();
        sessionLogger.info('Pterodactyl', `API Stats: ${stats.totalLast10s}/10s, ${stats.totalLast60s}/60s`);
        sessionLogger.info('Pterodactyl', `By Caller: ${JSON.stringify(stats.byCaller)}`);
        sessionLogger.info('Pterodactyl', `By Endpoint: ${JSON.stringify(stats.byEndpoint)}`);
    }
};

// Log stats every 10 seconds. unref so this telemetry timer never keeps the process alive on its
// own (prod stays up via the schedulers/Discord/HTTP handles; lets `node --test` exit cleanly).
setInterval(() => {
    const stats = apiCallTracker.getStats();
    if (stats.totalLast60s > 0) {
        apiCallTracker.logStats();
    }
}, 10000).unref();

// Warn when approaching rate limit
setInterval(() => {
    const stats = apiCallTracker.getStats();
    if (stats.totalLast60s > 100) {
        sessionLogger.warn('Pterodactyl', `HIGH API USAGE: ${stats.totalLast60s} calls in last 60s!`);
    }
}, 5000).unref();

// Helper to extract caller from stack trace
function getCaller() {
    const stack = new Error().stack;
    const lines = stack.split('\n');
    // Find the first line that's not in pterodactyl.js
    for (let i = 2; i < lines.length; i++) {
        if (!lines[i].includes('pterodactyl.js') && !lines[i].includes('node:internal')) {
            const match = lines[i].match(/at (?:async )?(?:(\S+)\s)?\(?(.+?):(\d+):\d+\)?/);
            if (match) {
                const fnName = match[1] || 'anonymous';
                const file = match[2].split('/').pop();
                return `${file}:${fnName}`;
            }
        }
    }
    return 'unknown';
}

module.exports = {
    /**
     * Safe API request wrapper with response validation
     */
    safeApiRequest: async function(method, url, data = null, options = {}) {
        const maxRetries = 3;
        const retryDelay = 2000;

        // Track API call
        const endpoint = url.replace(pterodactylHostName, '').split('?')[0];
        const caller = getCaller();
        apiCallTracker.track(endpoint, caller);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const config = {
                    method: method,
                    url: url,
                    headers: header,
                    timeout: 30000, // 30 second timeout
                    validateStatus: (status) => status < 500, // Don't throw on 4xx errors
                    ...options
                };
                
                if (data) {
                    config.data = data;
                }
                
                const response = await axios(config);
                
                // Check for error responses
                if (response.status >= 400) {
                    throw new Error(`API returned ${response.status}: ${response.statusText}`);
                }
                
                // Validate response structure (allow empty data for some endpoints)
                if (response.data === undefined) {
                    throw new Error('API returned undefined response');
                }
                
                return response;
                
            } catch (error) {
                sessionLogger.error('Pterodactyl', 
                    `API request failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
                
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                } else {
                    // Enhanced error with more context
                    const enhancedError = new Error(
                        `Pterodactyl API error after ${maxRetries} attempts: ${error.message}`
                    );
                    enhancedError.originalError = error;
                    enhancedError.url = url;
                    enhancedError.method = method;
                    throw enhancedError;
                }
            }
        }
    },

    /**
     * Gets the status of a server with enhanced error handling.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @returns Object containing the status of the server.
     */
    getStatus: async function (serverID) {
        try {
            const response = await this.safeApiRequest(
                'GET',
                `${pterodactylHostName}api/client/servers/${serverID}/resources`
            );
            
            // Validate response structure
            if (!response.data || !response.data.attributes) {
                throw new Error('Invalid status response structure');
            }
            
            return response.data;
            
        } catch (error) {
            sessionLogger.error('Pterodactyl', 
                `Failed to get status for server ${serverID}:`, error.message);
            
            // Return a safe default instead of undefined
            return {
                attributes: {
                    current_state: 'unknown',
                    resources: {
                        memory_bytes: 0,
                        cpu_absolute: 0,
                        disk_bytes: 0,
                        network_rx_bytes: 0,
                        network_tx_bytes: 0,
                        uptime: 0
                    }
                }
            };
        }
    },

    /**
     * Gets server uptime in hours
     * @param {string} serverID Id of the server on Pterodactyl.
     * @returns {number} Server uptime in hours, or 0 if server is not running
     */
    getServerUptime: async function (serverID) {
        try {
            const status = await this.getStatus(serverID);
            
            if (!status || status.attributes.current_state !== 'running') {
                return 0; // Server not running = 0 uptime
            }
            
            const resources = status.attributes.resources || {};
            
            // Pterodactyl returns uptime in milliseconds
            if (resources.uptime !== undefined) {
                const uptimeMs = resources.uptime;
                const uptimeHours = Math.floor(uptimeMs / (1000 * 3600));
                return uptimeHours;
            }
            
            // Fallback: check for seconds format (less common)
            if (resources.uptime_in_seconds !== undefined) {
                const uptimeSeconds = resources.uptime_in_seconds;
                const uptimeHours = Math.floor(uptimeSeconds / 3600);
                return uptimeHours;
            }
            
            // No uptime field found - log for debugging
            sessionLogger.warn('Pterodactyl', `Server ${serverID}: No uptime field found in API response`);
            return 0;
            
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Error getting uptime for server ${serverID}`, error.message);
            return 0; // Return 0 on error to be safe
        }
    },

    /**
     * Gets the one-time download link of a file.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {string} path Path to the file to download on Pterodactyl.
     * @returns URL to download the file.
     */
    getDownloadLink: async function (serverID, path) {
        path = path.replace("+", "%2B");
        apiCallTracker.track('files/download', getCaller());
        try {
            let response = await axios.get(`${pterodactylHostName}api/client/servers/${serverID}/files/download?file=${path}`, {
                headers: header
            });
            //console.log(response);
            return response.data.attributes.url;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Gets the one-time upload link of a file.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @returns URL of the upload link.
     */
    getUploadLink: async function (serverID) {
        apiCallTracker.track('files/upload', getCaller());
        try {
            let response = await axios.get(`${pterodactylHostName}api/client/servers/${serverID}/files/upload`, {
                headers: header
            });
            //console.log(response);
            return response.data.attributes.url;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Sends a power action to be executed on the server with validation.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {string} action Action to be executed on the server. Options: "start", "stop", "restart", "kill".
     * @returns 
     */
    sendPowerAction: async function (serverID, action) {
        try {
            const validActions = ['start', 'stop', 'restart', 'kill'];
            if (!validActions.includes(action)) {
                throw new Error(`Invalid power action: ${action}`);
            }
            
            const response = await this.safeApiRequest(
                'POST',
                `${pterodactylHostName}api/client/servers/${serverID}/power`,
                { signal: action }
            );
            
            return response.data || { success: true };
            
        } catch (error) {
            sessionLogger.error('Pterodactyl', 
                `Failed to send power action ${action} to server ${serverID}:`, error.message);
            throw error;
        }
    },

    /**
     * Sends a request to compress a list of files on the server.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {Array} fileList List of files to compress.
     * @param {string} listPath Path to the folder containing the files to compress. Defaults to the root directory.
     * @returns 
     */
    compressFile: async function (serverID, fileList, listPath = "/", ) {
        apiCallTracker.track('files/compress', getCaller());
        try {
            let response = await axios.post(`${pterodactylHostName}api/client/servers/${serverID}/files/compress`, {
                root: listPath,
                files: fileList,
            }, {
                headers: header
            });
            //console.log(response);
            return response.data.attributes.name;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Sends a request to decompress a file on the server.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {string} fileName Name of the file to decompress.
     * @param {string} filePath Path to the folder containing the file to decompress. Defaults to the root directory.
     * @returns 
     */
    decompressFile: async function (serverID, fileName, filePath = "/") {
        apiCallTracker.track('files/decompress', getCaller());
        try {
            let response = await axios.post(`${pterodactylHostName}api/client/servers/${serverID}/files/decompress`, {
                root: filePath,
                file: fileName,
            }, {
                headers: header
            });
            //console.log(response);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Sends a request to delete a list of files on the server.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {Array} fileList List of files to delete.
     * @param {string} listPath Path to the folder containing the files to delete. Defaults to the root directory.
     * @returns 
     */
    deleteFile: async function (serverID, fileList, filePath = "/") {
        apiCallTracker.track('files/delete', getCaller());
        try {
            let response = await axios.post(`${pterodactylHostName}api/client/servers/${serverID}/files/delete`, {
                root: filePath,
                files: fileList,
            }, {
                headers: header
            });
            //console.log(response);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Sends a request to rename the specified file on the server.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {string} path Path to the file to rename on the server.
     * @param {string} newName New name of the file.
     * @param {string} filePath Path to the file to rename. Defaults to the root directory.
     * @returns 
     */
    renameFile: async function (serverID, path, newName, filePath = "/") {
        apiCallTracker.track('files/rename', getCaller());
        try {
            let response = await axios.put(`${pterodactylHostName}api/client/servers/${serverID}/files/rename`, {
                root: filePath,
                files: path,
                name: newName
            }, {
                headers: header
            });
            //console.log(response);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Executes a command on the server with validation.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {string} command Command to be executed on the server.
     */
    sendCommand: async function (serverID, command) {
        apiCallTracker.track('command', getCaller());
        try {
            if (!command || typeof command !== 'string') {
                throw new Error('Invalid command: must be a non-empty string');
            }

            // Use axios directly for commands since they often return empty responses
            const response = await axios.post(
                `${pterodactylHostName}api/client/servers/${serverID}/command`,
                { command: command },
                { 
                    headers: header,
                    timeout: 15000, // 15 second timeout for commands
                    validateStatus: (status) => status < 500
                }
            );
            
            // Commands often return empty responses - this is normal
            if (response.status >= 200 && response.status < 300) {
                return { success: true, data: response.data };
            } else if (response.status >= 400) {
                throw new Error(`Command failed with status ${response.status}`);
            }
            
            return response.data || { success: true };
            
        } catch (error) {
            // Don't throw on 502 errors (server might be restarting)
            if (error.response && error.response.status === 502) {
                sessionLogger.debug('Pterodactyl', 
                    `502 error sending command to ${serverID} (server may be restarting)`);
                return { success: true };
            }
            
            // Handle timeout errors gracefully
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                sessionLogger.warn('Pterodactyl', 
                    `Command timeout for server ${serverID} - command may still execute`);
                return { success: true, timeout: true };
            }
            
            sessionLogger.error('Pterodactyl', 
                `Failed to send command to server ${serverID}:`, error.message);
            throw error;
        }
    },

    /**
     * Lists all subusers of a server.
     * @param {*} serverID Id of the server on Pterodactyl.
     * @returns Object containing the list of subusers.
     */
    listUsers: async function (serverID) {
        apiCallTracker.track('users/list', getCaller());
        try {
            let response = await axios.get(`${pterodactylHostName}api/client/servers/${serverID}/users`, {
                headers: header
            });
            //console.log(response);
            return response.data;
        }
        catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    }, 

    /**
     * Creates a subuser on the server.
     * @param {*} serverID Id of the server on Pterodactyl.
     * @param {*} subUserData Object containing the subuser data.
     */
    createSubUser: async function (serverID, subUserData) {
        apiCallTracker.track('users/create', getCaller());
        try {
            let response = await axios.post(`${pterodactylHostName}api/client/servers/${serverID}/users`, subUserData, {
                headers: header
            });
            //console.log(response);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Updates a subuser on the server.
     * @param {*} serverID Id of the server on Pterodactyl.
     * @param {*} subUserID Id of the subuser on Pterodactyl.
     * @param {*} subUserData Object containing the updated subuser data.
     */
    updateSubUser: async function (serverID, subUserID, subUserData) {
        apiCallTracker.track('users/update', getCaller());
        try {
            let response = await axios.post(`${pterodactylHostName}api/client/servers/${serverID}/users/${subUserID}`, subUserData, {
                headers: header
            });
            //console.log(response);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'API request failed', error.response?.data || error.message);
        }
    },

    /**
     * Begins a shutdown sequence on the server. If the server takes longer than the specified time to shut down, it will wait for it to idle and forcibly kill it.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {number} timeToKill Time in seconds to wait before killing the server. Default is 30 seconds.
     * @param {number} interval Interval in seconds to check the server status. Default interval is 3 seconds.
     * @param {number} preSaveWaitSeconds save-all then idle this long before stopping, so a slow modded
     *                                     world finishes flushing to disk before the stop/kill. Default 90s; 0 disables.
     */
    shutdown: async function (serverID, timeToKill = 30, interval = 3, preSaveWaitSeconds = 90) {
        // Flush the world and let it settle BEFORE the stop. shutdown() force-kills an idling server
        // after timeToKill, so without this an in-flight modded save could be truncated.
        if (preSaveWaitSeconds > 0) {
            try {
                await this.sendCommand(serverID, "save-all");
            } catch (error) {
                // server may already be offline / unreachable — nothing to flush, proceed to stop.
                sessionLogger.warn('Pterodactyl', `Pre-stop save-all failed for ${serverID}: ${error.message}`);
            }
            sessionLogger.info('Pterodactyl', `save-all issued for ${serverID}; waiting ${preSaveWaitSeconds}s for world flush before stop`);
            await new Promise(resolve => setTimeout(resolve, preSaveWaitSeconds * 1000));
        }

        const progressBar = new progress(`Shutting down the server [:bar] :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: timeToKill + 1
        });

        let iterator = 0;
        let killWaitSeconds = 0; // time spent waiting in the kill phase (iterator freezes at timeToKill)
        const killHardCapSeconds = 600; // never wait more than 10 min before a last-resort kill
        await this.sendPowerAction(serverID, "stop");

        return new Promise((resolve, reject) => {
            let shutdownSequence = setInterval(async () => {
                try {
                    let status = await this.getStatus(serverID);
                    const state = status.attributes.current_state;
                    const cpu = status.attributes.resources.cpu_absolute;

                    if (state === "offline") {
                        progressBar.update(1);
                        clearInterval(shutdownSequence);
                        return resolve(); // stop here — don't fall through into the kill block
                    } else if (iterator < timeToKill) {
                        progressBar.tick(interval);
                        iterator += interval;
                    }
                    if (iterator >= timeToKill) {
                        killWaitSeconds += interval;
                        progressBar.update(0.99);
                        sessionLogger.warn('Pterodactyl', 'Server shutdown taking longer than expected...');
                        process.stdout.moveCursor(76, -2);

                        // A kill is SIGKILL — only send it when the JVM is CONFIRMED idle (save done /
                        // hung), never mid-write. getStatus() returns state 'unknown' + cpu 0 on an API
                        // error, so guard on a known state; a hard cap stops an API outage hanging the
                        // update (or a server wedged at high CPU) forever.
                        const idle = state !== 'unknown' && cpu < 10;
                        const capped = killWaitSeconds >= killHardCapSeconds;
                        if (idle || capped) {
                            progressBar.update(1);
                            sessionLogger.info('Pterodactyl',
                                idle ? 'Server is idling. Killing it...' : 'Kill grace exhausted. Killing it...');
                            await this.sendPowerAction(serverID, "kill");
                            clearInterval(shutdownSequence);
                            resolve();
                        }
                    }
                } catch (error) {
                    clearInterval(shutdownSequence);
                    reject(error);
                }
            }, interval * 1000);
        });
    },

    /**
     *  Discovers all available nodes from Pterodactyl admin API with validation
     * @returns {Array} Array of node objects with resource information
     */
    getNodes: async function () {
        try {
            const response = await this.safeApiRequest(
                'GET',
                `${pterodactylHostName}api/application/nodes`
            );
            
            // Validate response structure
            if (!response.data || !response.data.data || !Array.isArray(response.data.data)) {
                throw new Error('Invalid nodes response structure');
            }
            
            return response.data.data.map(node => {
                // Validate node structure
                if (!node.attributes) {
                    throw new Error('Invalid node structure: missing attributes');
                }
                
                return {
                    id: node.attributes.uuid || `node-${node.attributes.name}`,
                    name: node.attributes.name || 'Unknown Node',
                    fqdn: node.attributes.fqdn || 'unknown.fqdn',
                    memory: {
                        total: node.attributes.memory || 0,
                        allocated: node.attributes.allocated_resources?.memory || 0
                    },
                    disk: {
                        total: node.attributes.disk || 0,
                        allocated: node.attributes.allocated_resources?.disk || 0
                    },
                    capacity: 4 // Default safe concurrent server capacity
                };
            });
        } catch (error) {
            sessionLogger.error('Pterodactyl', 'Error fetching nodes:', error.message);
            return [];
        }
    },

    /**
     *  Gets the node assignment for a specific server with validation
     * @param {string} serverID Server ID
     * @returns {string|null} Node UUID/ID or null if not found
     */
    getServerNode: async function (serverID) {
        try {
            const response = await this.safeApiRequest(
                'GET',
                `${pterodactylHostName}api/client/servers/${serverID}`
            );
            
            // Validate response structure
            if (!response.data || !response.data.attributes) {
                throw new Error('Invalid server response structure');
            }
            
            return response.data.attributes.node || null;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Error getting node for server ${serverID}:`, error.message);
            return null;
        }
    }

};