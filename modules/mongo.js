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
    mongoDBName
} = require("../config/config.json").mongodb;

const mongoClient = new MongoClient(process.env.MONGODB_URL);

let mainClientConnected = false;

module.exports = {

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
     * Gets all live embeds from MongoDB.
     * @returns Array of objects containing live embed data.
     */
    getLiveEmbeds: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const embedsArray = await mongoClient
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
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        await mongoClient
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
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        await mongoClient
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
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        await mongoClient
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