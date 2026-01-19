/*
 * File: mongo.js
 * Project: valhalla-updater
 * File Created: Wednesday, 15th May 2024 9:00:51 pm
 * Author: flaasz
 * -----
 * Last Modified: Thursday, 25th July 2024 5:49:53 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const {
    MongoClient,
    Long
} = require('mongodb');
require('dotenv').config();
const {
    mongoDBName,
    mongoDBserversCollection,
    mongoDBshardsCollection
} = require("../config/config.json").mongodb;

const mongoClient = new MongoClient(process.env.MONGODB_URL);

// Separate client for live embed operations to avoid race conditions
const liveEmbedClient = new MongoClient(process.env.MONGODB_URL);

// Keep track of connection state
let liveEmbedConnected = false;
let mainClientConnected = false;

module.exports = {

    /**
     * Gets all current servers data from MongoDB.
     * @returns Array of objects containing the server data.
     */
    getServers: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const serversArray = await mongoClient
            .db(mongoDBName)
            .collection(mongoDBserversCollection)
            .find({}).toArray();

        //console.log(serversArray);
        return serversArray;
    },

    /**
     * Gets all current shards data from MongoDB.
     * @returns Array of objects containing the shard data.
     */
    getShards: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const shardsArray = await mongoClient
            .db(mongoDBName)
            .collection(mongoDBshardsCollection)
            .find({}).toArray();

        //console.log(shardsArray);
        return shardsArray;
    },


    /**
     * Gets all tickets user closed or participated in by user from MongoDB.
     * @param {*} id Id of the user.
     * @param {*} username Username of the user.
     * @returns Array of objects containing the tickets data.
     */
    getTickets: async function (id, username) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const ticketsData = await mongoClient
            .db(mongoDBName)
            .collection('tickets');
        let array = await ticketsData.find({
            $or: [{
                closed_by: parseInt(id)
            }, {
                closed_by: new Long(id)
            }, {
                closed_by_name: username
            }]
        }).toArray();
        let contr = await ticketsData.find({
            [`users_involved.${id}`]: {
                $exists: true
            }
        }).toArray();
        //console.log(array);

        let results = [];
        results[0] = array;
        results[1] = contr;
        return results;
    },

    /**
     * Update the data of multiple servers in MongoDB.
     * @param {number} modpackId ID of the modpack on CF/FTB.
     * @param {object} update Object containing the fields to update.
     */
    updateServers: async function (modpackId, update) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        await mongoClient
            .db(mongoDBName)
            .collection(mongoDBserversCollection)
            .updateMany({
                modpackID: modpackId
            }, update);
    },

    /**
     * Update the data of a single server in MongoDB.
     * @param {number} serverId ID of the server on the panel.
     * @param {object} update Object containing the fields to update.
     */
    updateServer: async function (serverId, update) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        await mongoClient
            .db(mongoDBName)
            .collection(mongoDBserversCollection)
            .updateOne({
                serverId: serverId
            }, update);
    },

    /**
     * Gets all live embeds from MongoDB.
     * @returns Array of objects containing live embed data.
     */
    getLiveEmbeds: async function () {
        if (!liveEmbedConnected) {
            await liveEmbedClient.connect();
            liveEmbedConnected = true;
        }
        
        const embedsArray = await liveEmbedClient
            .db(mongoDBName)
            .collection('live_embeds')
            .find({}).toArray();

        return embedsArray;
    },

    /**
     * Stores a new live embed in MongoDB.
     * @param {string} messageId Discord message ID.
     * @param {string} channelId Discord channel ID.
     * @param {string} guildId Discord guild ID.
     * @param {string} createdBy User ID who created the embed.
     * @param {string} lastHash Hash of the current server state.
     */
    storeLiveEmbed: async function (messageId, channelId, guildId, createdBy, lastHash) {
        if (!liveEmbedConnected) {
            await liveEmbedClient.connect();
            liveEmbedConnected = true;
        }
        
        await liveEmbedClient
            .db(mongoDBName)
            .collection('live_embeds')
            .insertOne({
                messageId: messageId,
                channelId: channelId,
                guildId: guildId,
                createdBy: createdBy,
                lastHash: lastHash,
                createdAt: new Date()
            });
    },

    /**
     * Updates the hash for a live embed in MongoDB.
     * @param {string} messageId Discord message ID.
     * @param {string} newHash New hash of the server state.
     */
    updateLiveEmbedHash: async function (messageId, newHash) {
        if (!liveEmbedConnected) {
            await liveEmbedClient.connect();
            liveEmbedConnected = true;
        }
        
        await liveEmbedClient
            .db(mongoDBName)
            .collection('live_embeds')
            .updateOne({
                messageId: messageId
            }, {
                $set: {
                    lastHash: newHash,
                    lastUpdated: new Date()
                }
            });
    },

    /**
     * Removes a live embed from MongoDB.
     * @param {string} messageId Discord message ID.
     */
    removeLiveEmbed: async function (messageId) {
        if (!liveEmbedConnected) {
            await liveEmbedClient.connect();
            liveEmbedConnected = true;
        }
        
        await liveEmbedClient
            .db(mongoDBName)
            .collection('live_embeds')
            .deleteOne({
                messageId: messageId
            });
    },

    /**
     * Gets reboot history for a specific date.
     * @param {string} date Date string in YYYY-MM-DD format.
     * @returns {object|null} Reboot history data or null if not found.
     */
    getRebootHistory: async function (date) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const history = await mongoClient
            .db(mongoDBName)
            .collection('reboot_history')
            .findOne({ date: date });

        return history;
    },

    /**
     * Updates reboot history for a specific date.
     * @param {string} date Date string in YYYY-MM-DD format.
     * @param {object} historyData Reboot history data.
     */
    updateRebootHistory: async function (date, historyData) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        // Remove _id field to prevent conflicts during upsert
        const { _id, ...dataWithoutId } = historyData;
        
        await mongoClient
            .db(mongoDBName)
            .collection('reboot_history')
            .updateOne(
                { date: date },
                { $set: { ...dataWithoutId, lastUpdated: new Date() } },
                { upsert: true }
            );
    },


    /**
     * Gets recent reboot history.
     * @param {number} days Number of days to look back.
     * @returns {Array} Array of reboot history records.
     */
    getRecentRebootHistory: async function (days = 7) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffString = cutoffDate.toISOString().split('T')[0];
        
        const history = await mongoClient
            .db(mongoDBName)
            .collection('reboot_history')
            .find({ 
                date: { $gte: cutoffString }
            })
            .sort({ date: -1 })
            .toArray();

        return history;
    },

    // Schedule job functions
    /**
     * Gets active schedule jobs by type.
     * @param {string} type Type of schedule job ('player_trigger', 'scheduled_reboot', etc.).
     * @returns {Array} Array of active schedule jobs.
     */
    getActiveScheduleJobs: async function (type) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const jobs = await mongoClient
            .db(mongoDBName)
            .collection('schedule_jobs')
            .find({ 
                type: type, 
                active: true 
            }).toArray();

        return jobs;
    },

    /**
     * Creates a new schedule job.
     * @param {object} jobData Schedule job data.
     * @returns {object} Inserted document with _id.
     */
    createScheduleJob: async function (jobData) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const result = await mongoClient
            .db(mongoDBName)
            .collection('schedule_jobs')
            .insertOne({
                ...jobData,
                createdAt: new Date(),
                active: true
            });

        return result;
    },

    /**
     * Updates a schedule job.
     * @param {string} jobId Schedule job ID.
     * @param {object} updateData Data to update.
     */
    updateScheduleJob: async function (jobId, updateData) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        await mongoClient
            .db(mongoDBName)
            .collection('schedule_jobs')
            .updateOne(
                { _id: jobId },
                { $set: { ...updateData, lastUpdated: new Date() } }
            );
    },

    /**
     * Deactivates a schedule job.
     * @param {string} jobId Schedule job ID.
     */
    deactivateScheduleJob: async function (jobId) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        await mongoClient
            .db(mongoDBName)
            .collection('schedule_jobs')
            .updateOne(
                { _id: jobId },
                { $set: { active: false, deactivatedAt: new Date() } }
            );
    },

    /**
     * Deletes a schedule job.
     * @param {string} jobId Schedule job ID.
     */
    deleteScheduleJob: async function (jobId) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        await mongoClient
            .db(mongoDBName)
            .collection('schedule_jobs')
            .deleteOne({ _id: jobId });
    },

    /**
     * Gets all schedule jobs for management.
     * @returns {Array} Array of all schedule jobs.
     */
    getAllScheduleJobs: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const jobs = await mongoClient
            .db(mongoDBName)
            .collection('schedule_jobs')
            .find({}).toArray();

        return jobs;
    },

    // Crash history functions
    /**
     * Stores a server crash event to the crash history collection.
     * @param {string} serverId Server ID from Pterodactyl.
     * @param {object} crashEvent Crash event data.
     * @returns {object} Inserted document with _id.
     */
    storeCrashEvent: async function (serverId, crashEvent) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const result = await mongoClient
            .db(mongoDBName)
            .collection('server_crash_history')
            .insertOne({
                serverId: serverId,
                timestamp: new Date(crashEvent.timestamp),
                type: crashEvent.type,
                serverName: crashEvent.serverName,
                serverTag: crashEvent.serverTag,
                uptime: crashEvent.uptime,
                crashCount: crashEvent.crashCount,
                timeWindow: crashEvent.timeWindow,
                stuckDuration: crashEvent.stuckDuration,
                previousState: crashEvent.previousState,
                createdAt: new Date()
            });

        return result;
    },

    /**
     * Gets crash history for a specific server.
     * @param {string} serverId Server ID from Pterodactyl.
     * @param {number} limitHours Only get crashes from the last X hours (default: 24).
     * @returns {Array} Array of crash events.
     */
    getServerCrashHistory: async function (serverId, limitHours = 24) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const cutoff = new Date(Date.now() - (limitHours * 60 * 60 * 1000));
        
        const crashes = await mongoClient
            .db(mongoDBName)
            .collection('server_crash_history')
            .find({
                serverId: serverId,
                timestamp: { $gte: cutoff }
            })
            .sort({ timestamp: -1 })
            .toArray();

        return crashes;
    },

    /**
     * Gets crash summary statistics for all servers.
     * @param {number} limitHours Only count crashes from the last X hours (default: 24).
     * @returns {object} Crash statistics summary.
     */
    getCrashStatistics: async function (limitHours = 24) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const cutoff = new Date(Date.now() - (limitHours * 60 * 60 * 1000));
        
        // Get total crash count
        const totalCrashes = await mongoClient
            .db(mongoDBName)
            .collection('server_crash_history')
            .countDocuments({
                timestamp: { $gte: cutoff }
            });

        // Get crashes by type
        const crashesByType = await mongoClient
            .db(mongoDBName)
            .collection('server_crash_history')
            .aggregate([
                { $match: { timestamp: { $gte: cutoff } } },
                { $group: { _id: '$type', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray();

        // Get servers with most crashes
        const serverCrashCounts = await mongoClient
            .db(mongoDBName)
            .collection('server_crash_history')
            .aggregate([
                { $match: { timestamp: { $gte: cutoff } } },
                { $group: { 
                    _id: { serverId: '$serverId', serverName: '$serverName', serverTag: '$serverTag' }, 
                    count: { $sum: 1 } 
                } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]).toArray();

        return {
            totalCrashes,
            crashesByType,
            topCrashingServers: serverCrashCounts,
            timeWindow: limitHours
        };
    },

    /**
     * Gets recent crash events across all servers for monitoring.
     * @param {number} limit Maximum number of recent crashes to return (default: 50).
     * @returns {Array} Array of recent crash events.
     */
    getRecentCrashes: async function (limit = 50) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const crashes = await mongoClient
            .db(mongoDBName)
            .collection('server_crash_history')
            .find({})
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();

        return crashes;
    },

    /**
     * Clean up old crash history data.
     * @param {number} retentionDays Number of days to keep crash history (default: 30).
     * @returns {object} Result of deletion operation.
     */
    cleanupOldCrashHistory: async function (retentionDays = 30) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const cutoff = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
        
        const result = await mongoClient
            .db(mongoDBName)
            .collection('server_crash_history')
            .deleteMany({
                timestamp: { $lt: cutoff }
            });

        return result;
    },

    /**
     * Stores server state transition for analysis.
     * @param {string} serverId Server ID from Pterodactyl.
     * @param {object} stateTransition State transition data.
     * @returns {object} Inserted document with _id.
     */
    storeStateTransition: async function (serverId, stateTransition) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const result = await mongoClient
            .db(mongoDBName)
            .collection('server_state_history')
            .insertOne({
                serverId: serverId,
                timestamp: new Date(stateTransition.timestamp),
                fromState: stateTransition.fromState,
                toState: stateTransition.toState,
                serverName: stateTransition.serverName,
                serverTag: stateTransition.serverTag,
                uptime: stateTransition.uptime,
                createdAt: new Date()
            });

        return result;
    },

    /**
     * Gets server state transition history.
     * @param {string} serverId Server ID from Pterodactyl.
     * @param {number} limitHours Only get transitions from the last X hours (default: 24).
     * @returns {Array} Array of state transitions.
     */
    getServerStateHistory: async function (serverId, limitHours = 24) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const cutoff = new Date(Date.now() - (limitHours * 60 * 60 * 1000));
        
        const transitions = await mongoClient
            .db(mongoDBName)
            .collection('server_state_history')
            .find({
                serverId: serverId,
                timestamp: { $gte: cutoff }
            })
            .sort({ timestamp: -1 })
            .toArray();

        return transitions;
    },

    /**
     * Clean up old state transition history.
     * @param {number} retentionDays Number of days to keep state history (default: 7).
     * @returns {object} Result of deletion operation.
     */
    cleanupOldStateHistory: async function (retentionDays = 7) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const cutoff = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
        
        const result = await mongoClient
            .db(mongoDBName)
            .collection('server_state_history')
            .deleteMany({
                timestamp: { $lt: cutoff }
            });

        return result;
    },

    /**
     * Stores a reboot request for tracking
     * @param {object} requestData Reboot request data
     * @returns {object} Inserted document with _id
     */
    storeRebootRequest: async function (requestData) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const result = await mongoClient
            .db(mongoDBName)
            .collection('reboot_requests')
            .insertOne({
                ...requestData,
                completed: false,
                createdAt: new Date()
            });

        return result;
    },

    /**
     * Updates a reboot request status
     * @param {string} userId User ID who initiated the request
     * @param {boolean} completed Whether the reboot was completed
     * @param {string} status Optional status message
     */
    updateRebootRequest: async function (userId, completed, status = null) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        // Find the most recent request by this user
        const updateData = {
            completed,
            completedAt: new Date()
        };
        
        if (status) {
            updateData.status = status;
        }
        
        await mongoClient
            .db(mongoDBName)
            .collection('reboot_requests')
            .updateOne(
                { userId: userId, completed: false },
                { $set: updateData },
                { sort: { createdAt: -1 } }
            );
    },
    
    /**
     * Gets recent reboot requests that are not completed
     * @param {number} limit Maximum number of requests to return (default: 5)
     * @returns {Array} Array of reboot requests
     */
    getRecentRebootRequests: async function (limit = 5) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const requests = await mongoClient
            .db(mongoDBName)
            .collection('reboot_requests')
            .find({ completed: false })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
            
        return requests;
    },

    // =========================================================================
    // PLAYER FUNCTIONS (for Wrapped feature)
    // =========================================================================

    /**
     * Finds a player by their Discord ID in the valhallamc.players collection.
     * @param {string} discordId - Discord user ID
     * @returns {object|null} Player document or null if not found
     */
    getPlayerByDiscordId: async function (discordId) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        console.log(`[Mongo] Searching for discord_id: ${discordId}`);
        
        // Discord IDs can be stored as Long, number, or string
        const query = {
            $or: [
                { discord_id: Long.fromString(discordId) },
                { discord_id: parseInt(discordId) },
                { discord_id: discordId }
            ]
        };
        
        console.log(`[Mongo] Query:`, JSON.stringify(query, (key, value) => 
            typeof value === 'bigint' ? value.toString() : value
        ));
        
        const player = await mongoClient
            .db('valhallamc')
            .collection('players')
            .findOne(query);
        
        if (!player) {
            // Debug: check if collection exists and has documents
            const count = await mongoClient
                .db('valhallamc')
                .collection('players')
                .countDocuments({});
            console.log(`[Mongo] Collection 'valhallamc.players' has ${count} documents`);
            
            // Check a sample document to see discord_id format
            const sample = await mongoClient
                .db('valhallamc')
                .collection('players')
                .findOne({ discord_id: { $exists: true } });
            if (sample) {
                console.log(`[Mongo] Sample discord_id type: ${typeof sample.discord_id}, value: ${sample.discord_id}`);
            }
        }

        return player;
    },

    /**
     * Finds a player by their Minecraft username.
     * @param {string} username - Minecraft username (case-insensitive)
     * @returns {object|null} Player document or null if not found
     */
    getPlayerByUsername: async function (username) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const player = await mongoClient
            .db('valhallamc')
            .collection('players')
            .findOne({
                username: { $regex: new RegExp(`^${username}$`, 'i') }
            });

        return player;
    },

    /**
     * Finds a player by their Minecraft UUID.
     * UUID is stored as Binary subtype 03 in MongoDB.
     * @param {string} uuid - Minecraft UUID (dashed or undashed format)
     * @returns {object|null} Player document or null if not found
     */
    getPlayerByUuid: async function (uuid) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        
        const { uuidToMongoBase64, normalizeUuid } = require('./uuidUtils');
        const { Binary } = require('mongodb');
        
        // Normalize UUID and convert to MongoDB Binary format
        const normalizedUuid = normalizeUuid(uuid);
        const base64 = uuidToMongoBase64(normalizedUuid);
        const binaryUuid = new Binary(Buffer.from(base64, 'base64'), Binary.SUBTYPE_UUID_OLD);
        
        const player = await mongoClient
            .db('valhallamc')
            .collection('players')
            .findOne({ uuid: binaryUuid });

        return player;
    },

    /**
     * Gets the main MongoDB client (for advanced queries).
     * @returns {MongoClient} The main MongoDB client
     */
    getClient: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        return mongoClient;
    }
};