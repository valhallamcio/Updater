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

// bifrost.logs starts here; anything older lives only in valhallamc.logs (the archive)
const ARCHIVE_CUTOFF = new Date('2026-03-01T00:00:00Z');

module.exports = {

    /**
     * Prefix-searches the Bifrost players collection by username for autocomplete.
     * Case-insensitive, anchored prefix, capped result set — never loads all ~49k
     * players. Lives in the `bifrost` DB (not mongoDBName), same Mongo cluster.
     * @param {string} query Username prefix the user is typing.
     * @param {number} limit Max results (Discord caps autocomplete at 25).
     * @returns {Promise<string[]>} Matching usernames.
     */
    searchPlayerUsernames: async function (query, limit = 25) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const escaped = String(query || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const filter = escaped ? { username: { $regex: `^${escaped}`, $options: 'i' } } : {};
        const docs = await mongoClient
            .db('bifrost')
            .collection('players')
            .find(filter, { projection: { username: 1, _id: 0 } })
            .limit(limit)
            .toArray();
        return docs.map(d => d.username).filter(Boolean);
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

    // Reboot countdowns (valhallamc.reboot_events). Bifrost renders the countdown itself
    // (boss bar / action bar per client era) and keeps a planned restart from being relayed
    // as a crash; this collection is its only source, so EVERY countdown writes one doc.
    /**
     * Records the start of a reboot countdown.
     * @param {object} doc Countdown doc (built in schedulers/rebootScheduler.js).
     * @returns {Promise<object|null>} The inserted _id.
     */
    insertRebootEvent: async function (doc) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const result = await mongoClient
            .db(mongoDBName)
            .collection('reboot_events')
            .insertOne(doc);
        return result.insertedId;
    },

    /**
     * Stamps every still-open countdown of a server as cancelled, so the proxy takes the
     * bar down instead of counting to a restart that is no longer coming.
     * @param {string} serverId Pterodactyl server id.
     * @returns {Promise<object>} The updateMany result.
     */
    cancelRebootEvents: async function (serverId) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db(mongoDBName)
            .collection('reboot_events')
            .updateMany(
                { serverId: serverId, cancelledAt: null, fireAt: { $gt: new Date() } },
                { $set: { cancelledAt: new Date() } }
            );
    },

    /**
     * Stamps a countdown as reached (the server is being stopped now).
     * @param {*} id The _id insertRebootEvent returned.
     * @returns {Promise<object>} The updateOne result.
     */
    completeRebootEvent: async function (id) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db(mongoDBName)
            .collection('reboot_events')
            .updateOne({ _id: id }, { $set: { completedAt: new Date() } });
    },

    /**
     * Creates the reboot_events indexes: a 2-day TTL (the docs are only interesting while
     * the countdown runs) and the lookup the proxy polls with.
     * @returns {Promise<void>}
     */
    ensureRebootEventIndexes: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const collection = mongoClient.db(mongoDBName).collection('reboot_events');
        await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 172800, name: 'reboot_events_ttl' });
        await collection.createIndex({ serverId: 1, startedAt: -1 }, { name: 'reboot_events_server' });
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

    // =========================================================================
    // INVESTIGATION FUNCTIONS (for /investigate — see docs/investigate-plan.md)
    // =========================================================================

    /**
     * Gets a player's activity rows (chat/command/connect/disconnect/server_change)
     * from bifrost.logs, plus valhallamc.logs (the pre-2026-03 archive) when the
     * range reaches back that far. Merged and sorted ascending by timestamp.
     * @param {string} username Exact username (autocomplete gives canonical casing).
     * @param {Date} from Range start.
     * @param {Date} to Range end.
     * @param {object} [opts] { limit } max rows per store (default 20000).
     * @returns {Promise<object[]>} Log rows, oldest first.
     */
    getPlayerActivity: async function (username, from, to, opts = {}) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const limit = opts.limit || 20000;
        const rows = await mongoClient
            .db('bifrost')
            .collection('logs')
            .find({ username: username, timestamp: { $gte: from, $lte: to } })
            .sort({ timestamp: 1 })
            .limit(limit)
            .toArray();

        // valhallamc.logs holds the only chat before bifrost.logs starts (2026-03-01).
        // Cap the archive query at that cutoff so the March 2026 overlap isn't duplicated.
        if (from < ARCHIVE_CUTOFF) {
            const archiveTo = to < ARCHIVE_CUTOFF ? to : ARCHIVE_CUTOFF;
            const archiveRows = await mongoClient
                .db('valhallamc')
                .collection('logs')
                .find({ username: username, timestamp: { $gte: from, $lt: archiveTo } })
                .sort({ timestamp: 1 })
                .limit(limit)
                .toArray();
            rows.push(...archiveRows);
            rows.sort((a, b) => a.timestamp - b.timestamp);
        }

        return rows;
    },

    /**
     * Gets everyone's chat/command/server_change rows on a server in a window —
     * the room context around a dispute. Keyed on server_name (the DISPLAY name,
     * e.g. "GT New Horizons", not the tag). Same archive handling as
     * getPlayerActivity. NOTE: needs the {server_name, timestamp} index or this
     * collection-scans.
     * @param {string} serverName Server display name as stored in logs.
     * @param {Date} from Range start.
     * @param {Date} to Range end.
     * @param {object} [opts] { limit } max rows per store (default 5000).
     * @returns {Promise<object[]>} Log rows, oldest first.
     */
    getRoomContext: async function (serverName, from, to, opts = {}) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const limit = opts.limit || 5000;
        const rows = await mongoClient
            .db('bifrost')
            .collection('logs')
            .find({ server_name: serverName, timestamp: { $gte: from, $lte: to } })
            .sort({ timestamp: 1 })
            .limit(limit)
            .toArray();

        if (from < ARCHIVE_CUTOFF) {
            const archiveTo = to < ARCHIVE_CUTOFF ? to : ARCHIVE_CUTOFF;
            const archiveRows = await mongoClient
                .db('valhallamc')
                .collection('logs')
                .find({ server_name: serverName, timestamp: { $gte: from, $lt: archiveTo } })
                .sort({ timestamp: 1 })
                .limit(limit)
                .toArray();
            rows.push(...archiveRows);
            rows.sort((a, b) => a.timestamp - b.timestamp);
        }

        return rows;
    },

    /**
     * Gets a player's sessions (join/leave + IP + server tag) overlapping a window.
     * Overlap test, not containment — a session spanning the whole window still counts.
     * @param {string} username Exact username.
     * @param {Date} from Range start.
     * @param {Date} to Range end.
     * @returns {Promise<object[]>} yggdrasil.player_sessions docs, oldest first.
     */
    getPlayerSessions: async function (username, from, to) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('yggdrasil')
            .collection('player_sessions')
            .find({
                username: username,
                joinedAt: { $lte: to },
                $or: [{ leftAt: null }, { leftAt: { $gte: from } }]
            })
            .sort({ joinedAt: 1 })
            .toArray();
    },

    /**
     * Gets a player's punishments from both the live and old backends.
     * @param {string} username Target name (case-insensitive).
     * @returns {Promise<object[]>} Punishment docs, newest first.
     */
    getPlayerPunishments: async function (username) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const filter = { target_name: { $regex: `^${escaped}$`, $options: 'i' } };
        const [live, old] = await Promise.all([
            mongoClient.db('bifrost').collection('punishments').find(filter).toArray(),
            mongoClient.db('valhallamc').collection('punishments').find(filter).toArray()
        ]);
        return [...live, ...old].sort((a, b) => (b.date || 0) - (a.date || 0));
    },

    /**
     * Gets a player's identity doc from bifrost.players (the live, biggest store).
     * @param {string} username Username (case-insensitive).
     * @returns {Promise<object|null>} Player doc or null.
     */
    getPlayerIdentity: async function (username) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return mongoClient
            .db('bifrost')
            .collection('players')
            .findOne({ username: { $regex: `^${escaped}$`, $options: 'i' } });
    },

    /**
     * Finds accounts sharing IPs with a player. Collects the player's IPs from
     * player_sessions.ip and bifrost.logs.ip_address (stripping the leading '/'
     * and ':port'), then reverse-looks-up other usernames on those IPs.
     * The deep pass regex-scans bifrost.logs (no ip index) — slower, so it's
     * opt-in; the fast pass only uses player_sessions.
     * @param {string} username Exact username.
     * @param {object} [opts] { deep } also reverse-search bifrost.logs (default false).
     * @returns {Promise<{ips: string[], alts: object[]}>} IPs + accounts seen on them.
     */
    findAlts: async function (username, opts = {}) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const cleanIp = raw => {
            if (!raw) return null;
            const m = String(raw).match(/^\/?([0-9a-fA-F.:]+?)(?::\d+)?$/);
            return m ? m[1] : null;
        };

        const [sessionIps, logIps] = await Promise.all([
            mongoClient.db('yggdrasil').collection('player_sessions')
                .distinct('ip', { username: username }),
            mongoClient.db('bifrost').collection('logs')
                .distinct('ip_address', { username: username, ip_address: { $exists: true, $ne: null } })
        ]);

        const ips = new Set();
        for (const ip of sessionIps) if (ip) ips.add(ip);
        for (const raw of logIps) { const ip = cleanIp(raw); if (ip) ips.add(ip); }
        // cap so a heavy-roamer can't build a monster $or
        const ipArr = [...ips].slice(0, 50);
        if (ipArr.length === 0) return { ips: [], alts: [] };

        const byUser = new Map();
        const addHit = (name, ip, lastSeen) => {
            if (!name || name === username) return;
            let e = byUser.get(name);
            if (!e) { e = { username: name, ips: new Set(), lastSeen: null }; byUser.set(name, e); }
            if (ip) e.ips.add(ip);
            if (lastSeen && (!e.lastSeen || lastSeen > e.lastSeen)) e.lastSeen = lastSeen;
        };

        const sessionHits = await mongoClient.db('yggdrasil').collection('player_sessions')
            .aggregate([
                { $match: { ip: { $in: ipArr }, username: { $ne: username } } },
                { $group: { _id: '$username', ips: { $addToSet: '$ip' }, lastSeen: { $max: '$joinedAt' } } }
            ]).toArray();
        for (const h of sessionHits) for (const ip of h.ips) addHit(h._id, ip, h.lastSeen);

        if (opts.deep) {
            const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const orClauses = ipArr.map(ip => ({ ip_address: { $regex: `^/${escapeRegex(ip)}:` } }));
            const logHits = await mongoClient.db('bifrost').collection('logs')
                .aggregate([
                    { $match: { username: { $ne: username }, $or: orClauses } },
                    { $group: { _id: '$username', rawIps: { $addToSet: '$ip_address' }, lastSeen: { $max: '$timestamp' } } }
                ]).toArray();
            for (const h of logHits) for (const raw of h.rawIps) addHit(h._id, cleanIp(raw), h.lastSeen);
        }

        const alts = [...byUser.values()]
            .map(e => ({ username: e.username, ips: [...e.ips], lastSeen: e.lastSeen }))
            .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return { ips: ipArr, alts: alts };
    },

    // Bifrost notices + mail (the `bifrost` DB, same cluster). The proxy watches
    // bifrost.notices with a change stream, so a write here reaches players in ~1s.
    /**
     * Gets the Bifrost database handle (notices, mail, players, logs).
     * @returns {Promise<import('mongodb').Db>} The `bifrost` database.
     */
    getBifrostDb: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }
        return mongoClient.db('bifrost');
    },

    /**
     * Creates or replaces a notice by its id. The proxy validates the doc shape,
     * so callers must build it with discord/commands/util/noticeDoc.js.
     * @param {object} doc Notice doc (must carry `id` and `type`).
     * @returns {Promise<object>} The updateOne result.
     */
    upsertNotice: async function (doc) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const { id, ...rest } = doc;
        return mongoClient
            .db('bifrost')
            .collection('notices')
            .updateOne({ id: id }, { $set: { id: id, ...rest } }, { upsert: true });
    },

    /**
     * Lists notices, newest first.
     * @param {string} [type] Restrict to one type (help, tip, announcement, ...).
     * @param {number} limit Max docs (Discord embeds cap at 25 fields).
     * @returns {Promise<object[]>} Notice docs.
     */
    listNotices: async function (type, limit = 25) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const filter = type ? { type: type } : {};
        return mongoClient
            .db('bifrost')
            .collection('notices')
            .find(filter)
            .sort({ updatedAt: -1 })
            .limit(limit)
            .toArray();
    },

    /**
     * Gets one notice by id.
     * @param {string} id Notice id.
     * @returns {Promise<object|null>} The doc or null.
     */
    getNotice: async function (id) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('notices')
            .findOne({ id: id });
    },

    /**
     * Enables or retires a notice. Staff never delete from Discord - a retired
     * doc keeps its history and can be switched back on.
     * @param {string} id Notice id.
     * @param {boolean} enabled New enabled state.
     * @param {string} updatedBy Who did it.
     * @returns {Promise<object>} The updateOne result.
     */
    setNoticeEnabled: async function (id, enabled, updatedBy) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('notices')
            .updateOne({ id: id }, {
                $set: {
                    enabled: enabled,
                    updatedBy: updatedBy,
                    updatedAt: new Date()
                }
            });
    },

    /**
     * Adds or replaces one language of a notice's text. `tip` docs keep their text
     * under `card`, every other type under `body` - the proxy validates both shapes.
     * @param {string} id Notice id.
     * @param {string} lang Language code (en, es, de, ...).
     * @param {string} text Text for that language.
     * @param {string} updatedBy Who did it.
     * @returns {Promise<object|null>} The updateOne result, or null when the id is unknown.
     */
    setNoticeBodyLang: async function (id, lang, text, updatedBy) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const notices = mongoClient.db('bifrost').collection('notices');
        const existing = await notices.findOne({ id: id }, { projection: { type: 1 } });
        if (!existing) return null;

        const field = existing.type === 'tip' ? 'card' : 'body';
        return notices.updateOne({ id: id }, {
            $set: {
                [`${field}.${lang}`]: text,
                updatedBy: updatedBy,
                updatedAt: new Date()
            }
        });
    },

    /**
     * Prefix-searches notice ids for autocomplete, falling back to a contains search
     * when nothing starts with what was typed.
     * @param {string} prefix Id prefix the user is typing.
     * @param {number} limit Max results.
     * @returns {Promise<string[]>} Matching ids.
     */
    searchNoticeIds: async function (prefix, limit = 25) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const notices = mongoClient.db('bifrost').collection('notices');
        const projection = { projection: { id: 1, _id: 0 } };
        const escaped = String(prefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!escaped) {
            const all = await notices.find({}, projection).limit(limit).toArray();
            return all.map(d => d.id).filter(Boolean);
        }

        const anchored = await notices
            .find({ id: { $regex: `^${escaped}`, $options: 'i' } }, projection)
            .limit(limit)
            .toArray();
        // Ids read `<type>.<slug>`, so a prefix is what staff type - but they also type the
        // slug alone ("nether lag"), which no prefix can match. Fall back to contains then.
        if (anchored.length) return anchored.map(d => d.id).filter(Boolean);

        const contains = await notices
            .find({ id: { $regex: escaped, $options: 'i' } }, projection)
            .limit(limit)
            .toArray();
        return contains.map(d => d.id).filter(Boolean);
    },

    /**
     * Inserts one mail doc. The proxy's change stream delivers it inline when the
     * recipient is online, otherwise it waits in their inbox.
     * @param {object} doc Mail doc (build it with discord/commands/util/mailDoc.js).
     * @returns {Promise<object>} The insertOne result.
     */
    insertMail: async function (doc) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('mail')
            .insertOne(doc);
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