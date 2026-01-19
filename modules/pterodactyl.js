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

/**
 * Request queue for rate limiting Pterodactyl API calls
 */
class RequestQueue {
    constructor(options = {}) {
        this.queue = [];
        this.isProcessing = false;
        // 128 req/min = 60000ms/128 = 469ms, use 500ms for safety margin
        this.minInterval = options.minInterval || 500; // ms between requests
        this.maxConcurrent = options.maxConcurrent || 3; // reduced for safety
        this.activeRequests = 0;
        this.lastRequestTime = 0;
        this.backoffUntil = 0;
    }

    async add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            // Wait for backoff period
            if (Date.now() < this.backoffUntil) {
                await new Promise(r => setTimeout(r, this.backoffUntil - Date.now()));
            }

            // Respect max concurrent limit
            if (this.activeRequests >= this.maxConcurrent) {
                await new Promise(r => setTimeout(r, 50));
                continue;
            }

            // Respect minimum interval
            const timeSinceLast = Date.now() - this.lastRequestTime;
            if (timeSinceLast < this.minInterval) {
                await new Promise(r => setTimeout(r, this.minInterval - timeSinceLast));
            }

            const { fn, resolve, reject } = this.queue.shift();
            this.activeRequests++;
            this.lastRequestTime = Date.now();

            fn().then(resolve).catch(reject).finally(() => this.activeRequests--);
        }
        this.isProcessing = false;
    }

    setBackoff(ms) {
        this.backoffUntil = Date.now() + ms;
        sessionLogger.warn('Pterodactyl', `Rate limit hit, backing off for ${ms}ms`);
    }
}

// Tuned for Pterodactyl's 128 req/min client limit (60000ms/128 = 469ms per request)
const requestQueue = new RequestQueue({ minInterval: 500, maxConcurrent: 3 });


module.exports = {
    /**
     * Safe API request wrapper with response validation and rate limiting
     */
    safeApiRequest: async function(method, url, data = null, options = {}) {
        const maxRetries = 3;
        const retryDelay = 2000;

        return requestQueue.add(async () => {
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

                    // Debug logging: request
                    sessionLogger.debug('Pterodactyl',
                        `API Request: ${method} ${url}${data ? ` | Body: ${JSON.stringify(data)}` : ''}`);

                    const response = await axios(config);

                    // Debug logging: response
                    const dataPreview = response.data
                        ? JSON.stringify(response.data).substring(0, 200) + (JSON.stringify(response.data).length > 200 ? '...' : '')
                        : '(empty)';
                    sessionLogger.debug('Pterodactyl',
                        `API Response: ${response.status} ${response.statusText} | Data: ${dataPreview}`);

                    // Handle 429 Too Many Requests
                    if (response.status === 429) {
                        const retryAfter = parseInt(response.headers['retry-after']) || 30;
                        requestQueue.setBackoff(retryAfter * 1000);

                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                            continue;
                        }
                        throw new Error(`Rate limit exceeded (429) after ${maxRetries} attempts`);
                    }

                    // Check for other error responses
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
        });
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
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/files/download?file=${path}`;
            const response = await this.safeApiRequest('GET', url);
            return response.data.attributes.url;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to get download link for server ${serverID}:`, error.message);
            throw error;
        }
    },

    /**
     * Gets the one-time upload link of a file.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @returns URL of the upload link.
     */
    getUploadLink: async function (serverID) {
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/files/upload`;
            const response = await this.safeApiRequest('GET', url);
            return response.data.attributes.url;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to get upload link for server ${serverID}:`, error.message);
            throw error;
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
    compressFile: async function (serverID, fileList, listPath = "/") {
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/files/compress`;
            const body = { root: listPath, files: fileList };
            const response = await this.safeApiRequest('POST', url, body);
            return response.data.attributes.name;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to compress files for server ${serverID}:`, error.message);
            throw error;
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
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/files/decompress`;
            const body = { root: filePath, file: fileName };
            const response = await this.safeApiRequest('POST', url, body);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to decompress file for server ${serverID}:`, error.message);
            throw error;
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
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/files/delete`;
            const body = { root: filePath, files: fileList };
            const response = await this.safeApiRequest('POST', url, body);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to delete files for server ${serverID}:`, error.message);
            throw error;
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
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/files/rename`;
            const body = { root: filePath, files: path, name: newName };
            const response = await this.safeApiRequest('PUT', url, body);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to rename file for server ${serverID}:`, error.message);
            throw error;
        }
    },

    /**
     * Executes a command on the server with validation.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {string} command Command to be executed on the server.
     */
    sendCommand: async function (serverID, command) {
        try {
            if (!command || typeof command !== 'string') {
                throw new Error('Invalid command: must be a non-empty string');
            }

            const url = `${pterodactylHostName}api/client/servers/${serverID}/command`;
            const body = { command: command };

            // Use safeApiRequest with custom timeout for commands
            const response = await this.safeApiRequest('POST', url, body, {
                timeout: 15000 // 15 second timeout for commands
            });

            // Commands often return empty responses - this is normal
            return { success: true, data: response.data };

        } catch (error) {
            // Don't throw on 502 errors (server might be restarting)
            if (error.originalError?.response?.status === 502) {
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
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/users`;
            const response = await this.safeApiRequest('GET', url);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to list users for server ${serverID}:`, error.message);
            return null; // Return null to indicate API failure (different from empty user list)
        }
    }, 

    /**
     * Creates a subuser on the server.
     * @param {*} serverID Id of the server on Pterodactyl.
     * @param {*} subUserData Object containing the subuser data.
     */
    createSubUser: async function (serverID, subUserData) {
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/users`;
            const response = await this.safeApiRequest('POST', url, subUserData);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to create subuser for server ${serverID}:`, error.message);
            return null;
        }
    },

    /**
     * Updates a subuser on the server.
     * @param {*} serverID Id of the server on Pterodactyl.
     * @param {*} subUserID Id of the subuser on Pterodactyl.
     * @param {*} subUserData Object containing the updated subuser data.
     */
    updateSubUser: async function (serverID, subUserID, subUserData) {
        try {
            const url = `${pterodactylHostName}api/client/servers/${serverID}/users/${subUserID}`;
            const response = await this.safeApiRequest('POST', url, subUserData);
            return response.data;
        } catch (error) {
            sessionLogger.error('Pterodactyl', `Failed to update subuser for server ${serverID}:`, error.message);
            return null;
        }
    },

    /**
     * Begins a shutdown sequence on the server. If the server takes longer than the specified time to shut down, it will wait for it to idle and forcibly kill it.
     * @param {string} serverID Id of the server on Pterodactyl.
     * @param {number} timeToKill Time in seconds to wait before killing the server. Default is 30 seconds.
     * @param {number} interval Interval in seconds to check the server status. Default interval is 3 seconds.
     */
    shutdown: async function (serverID, timeToKill = 30, interval = 3) {
        const progressBar = new progress(`Shutting down the server [:bar] :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: timeToKill + 1
        });

        let iterator = 0;
        await this.sendPowerAction(serverID, "stop");

        return new Promise((resolve, reject) => {
            let shutdownSequence = setInterval(async () => {
                try {
                    let status = await this.getStatus(serverID);

                    if (status.attributes.current_state === "offline") {
                        progressBar.update(1);
                        clearInterval(shutdownSequence);
                        resolve();
                    } else if (iterator < timeToKill) {
                        progressBar.tick(interval);
                        iterator += interval;
                    }
                    if (iterator >= timeToKill) {
                        progressBar.update(0.99);
                        sessionLogger.warn('Pterodactyl', 'Server shutdown taking longer than expected...');
                        process.stdout.moveCursor(76, -2);

                        if (status.attributes.resources.cpu_absolute < 10) {
                            progressBar.update(1);
                            sessionLogger.info('Pterodactyl', 'Server is idling. Killing it...');
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