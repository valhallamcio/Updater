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
    Long,
    ObjectId
} = require('mongodb');
require('dotenv').config();
const sessionLogger = require('./sessionLogger');
// one source for the link field shape - /link writes it, this writes it, the proxy reads it
const { buildLinkFields } = require('../discord/commands/util/linkCode');
const {
    mongoDBName
} = require("../config/config.json").mongodb;

const mongoClient = new MongoClient(process.env.MONGODB_URL);

let mainClientConnected = false;
// The discord-link indexes are created once per process, on the first code claim. The
// three code indexes are the proxy's specs verbatim (src/plugins/discord-link/index.ts) -
// same names, same options, so whichever side gets there first the other finds them right.
const DISCORD_LINK_INDEXES = [
    { collection: 'players', keys: { discord_id: 1 }, options: { sparse: true } },
    { collection: 'discord_link_codes', keys: { code: 1 }, options: { name: 'link_code', unique: true } },
    { collection: 'discord_link_codes', keys: { uuid: 1 }, options: { name: 'link_uuid' } },
    { collection: 'discord_link_codes', keys: { expiresAt: 1 }, options: { name: 'link_ttl', expireAfterSeconds: 0 } }
];
let discordLinkIndexesEnsured = false;
// Failed link attempts are support evidence for a few weeks, then noise.
const LINK_FAILURE_TTL_SECONDS = 90 * 86400;
let linkFailureIndexEnsured = false;

// bifrost.logs starts here; anything older lives only in valhallamc.logs (the archive)
const ARCHIVE_CUTOFF = new Date('2026-03-01T00:00:00Z');

/**
 * A link request or chat flag id, back in the form Mongo matches on. The Discord button
 * carries the _id as text, so a 24-character hex string has to become an ObjectId again.
 * @param {*} id Whatever the caller has - an ObjectId, or its string form.
 * @returns {*} The id to filter with.
 */
function buttonDocId(id) {
    if (id instanceof ObjectId) return id;
    const text = String(id);
    return text.length === 24 && ObjectId.isValid(text) ? new ObjectId(text) : text;
}

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
     * Marks a job as started, only while it is still active. The matched count
     * is the answer: zero means somebody cancelled it first and it must not run.
     * A oneTime job is claimed once only, so a restart between its run and its
     * deactivation never runs it again.
     * @param {string} jobId Schedule job ID.
     * @param {boolean} [once] True for a oneTime job.
     * @returns {Promise<object>} The updateOne result (`matchedCount`).
     */
    claimScheduleJob: async function (jobId, once = false) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const filter = { _id: jobId, active: true };
        if (once) filter.startedAt = { $exists: false };
        return mongoClient
            .db(mongoDBName)
            .collection('schedule_jobs')
            .updateOne(filter, { $set: { startedAt: new Date() } });
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
     * Adds cake to a player's Bifrost balance and writes one audit row.
     *
     * The drop used to run `give` on the backend, which put thousands of stacks
     * on the floor. It credits `bifrost.players.cake.balance` now and the player
     * takes it out in game with `/cake`.
     * @param {string} username Username (case-insensitive).
     * @param {number} amount Cake to add.
     * @param {object} [meta] `{kind, by, server}` for the ledger row.
     * @returns {Promise<{uuid: string, username: string}|null>} The player, or null when no doc matches.
     */
    creditCake: async function (username, amount, meta = {}) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bifrost = mongoClient.db('bifrost');
        const player = await bifrost
            .collection('players')
            .findOne({ username: { $regex: `^${escaped}$`, $options: 'i' } });
        if (!player || !player.uuid) return null;

        const at = new Date();
        await bifrost.collection('players').updateOne(
            { uuid: player.uuid },
            { $inc: { 'cake.balance': amount }, $set: { 'cake.updatedAt': at } }
        );
        await bifrost.collection('cake_ledger').insertOne({
            uuid: player.uuid,
            delta: amount,
            kind: meta.kind || 'drop',
            by: meta.by,
            server: meta.server,
            at: at
        });
        return { uuid: player.uuid, username: player.username };
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

    // Player reports (bifrost.reports). The proxy files them from in-game /report, and staff
    // close them in game with /reports close. `/reply ... report:<id>` closes one with the
    // same fields. These go through getBifrostDb, so a test can hand them a fake database.
    /**
     * One player's reports, newest first, id and status only. A typed report id is matched
     * against these, the way the proxy's `/report list <id>` does it.
     * @param {string} uuid Reporter uuid.
     * @param {number} limit Max reports.
     * @returns {Promise<object[]>} `{_id, status}` docs.
     */
    findReportIdsOf: async function (uuid, limit = 500) {
        const db = await module.exports.getBifrostDb();
        return db
            .collection('reports')
            .find({ 'reporter.uuid': String(uuid) }, { projection: { _id: 1, status: 1 } })
            .sort({ at: -1 })
            .limit(limit)
            .toArray();
    },

    /**
     * The newest reports of every player, id and reporter only. /reply reads these only to
     * tell staff that the id they typed is another player's report.
     * @param {number} limit Max reports.
     * @returns {Promise<object[]>} `{_id, reporter}` docs.
     */
    findRecentReportIds: async function (limit = 500) {
        const db = await module.exports.getBifrostDb();
        return db
            .collection('reports')
            .find({}, { projection: { _id: 1, reporter: 1 } })
            .sort({ at: -1 })
            .limit(limit)
            .toArray();
    },

    /**
     * One player's open reports, newest first, for the /reply autocomplete.
     * @param {string} uuid Reporter uuid.
     * @param {number} limit Max reports (Discord caps autocomplete at 25).
     * @returns {Promise<object[]>} `{_id, text}` docs.
     */
    findOpenReportsOf: async function (uuid, limit = 25) {
        const db = await module.exports.getBifrostDb();
        return db
            .collection('reports')
            .find({ 'reporter.uuid': String(uuid), status: 'open' }, { projection: { _id: 1, text: 1 } })
            .sort({ at: -1 })
            .limit(limit)
            .toArray();
    },

    /**
     * Closes one report of one player, and only while it is still open. The open filter is
     * the proxy's own: two staff closing the same report at once never write twice.
     * @param {*} id The report _id, as read from the collection.
     * @param {string} reporterUuid The player the report must belong to.
     * @param {object} fields The `$set` (build it with discord/commands/util/reportClose.js).
     * @returns {Promise<object>} The updateOne result - `matchedCount` 0 means it was closed already.
     */
    closeReport: async function (id, reporterUuid, fields) {
        const db = await module.exports.getBifrostDb();
        return db
            .collection('reports')
            .updateOne({ _id: id, 'reporter.uuid': String(reporterUuid), status: 'open' }, { $set: fields });
    },

    // Discord <-> Minecraft linking (bifrost.discord_link_codes, bifrost.players,
    // bifrost.discord_link_audit). The proxy mints the code in game and watches
    // bifrost.players, so the confirmation card follows the write here in about a second.
    // `discord_id` is ALWAYS a string: a snowflake does not survive a JS number.
    /**
     * Claims a code: the lookup and the burn are ONE write, so two Discords racing the
     * same code can never both walk away holding it. Reading first and burning after is
     * how the same code linked twice.
     * @param {string} code Normalised code (discord/commands/util/linkCode.js).
     * @param {string} discordId Who is claiming it.
     * @returns {Promise<object|null>} The claimed doc, or null when the code was already
     *     used, has expired, or never existed.
     */
    claimLinkCode: async function (code, discordId) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        await module.exports.ensureDiscordLinkIndexes();
        // driver 6 hands back the document itself, not a {value} wrapper
        return mongoClient
            .db('bifrost')
            .collection('discord_link_codes')
            .findOneAndUpdate({
                code: String(code),
                usedAt: null,
                expiresAt: { $gt: new Date() }
            }, {
                $set: {
                    usedAt: new Date(),
                    usedBy: String(discordId)
                }
            }, { returnDocument: 'after' });
    },

    /**
     * Gets a Bifrost player doc by uuid (the link code carries the uuid).
     * @param {string} uuid Dashed uuid string.
     * @returns {Promise<object|null>} Player doc or null.
     */
    getBifrostPlayerByUuid: async function (uuid) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .findOne({ uuid: String(uuid) });
    },

    /**
     * Lists the Minecraft accounts one Discord user has linked. One Discord may hold
     * several accounts; one Minecraft account holds at most one Discord.
     * @param {string} discordId Discord snowflake, as a string.
     * @returns {Promise<object[]>} `{uuid, username, discord_id, discord_name, discord_linked_at}` docs.
     */
    findBifrostPlayersByDiscordId: async function (discordId) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .find({ discord_id: String(discordId) }, {
                projection: {
                    _id: 0,
                    uuid: 1,
                    username: 1,
                    discord_id: 1,
                    discord_name: 1,
                    discord_linked_at: 1
                }
            })
            .toArray();
    },

    /**
     * Writes the link onto the player doc, but only while that account is still free.
     * The filter is what makes a race lose instead of overwrite - an in-game link landing
     * between the claim and this write used to be silently replaced.
     * @param {string} uuid Dashed uuid of the Minecraft account.
     * @param {object} link `{discordId, discordName}`.
     * @returns {Promise<object>} The updateOne result - `matchedCount` 0 means somebody
     *     else got there first and the caller must refuse.
     */
    setBifrostDiscordLink: async function (uuid, link) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        // $in:[null] is 'missing or null' - a doc from before the field existed matches too
        return mongoClient
            .db('bifrost')
            .collection('players')
            .updateOne({ uuid: String(uuid), discord_id: { $in: [null] } },
                { $set: buildLinkFields(link) });
    },

    /**
     * Drops the link from a player doc.
     * @param {string} uuid Dashed uuid of the Minecraft account.
     * @returns {Promise<object>} The updateOne result.
     */
    unsetBifrostDiscordLink: async function (uuid) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .updateOne({ uuid: String(uuid) }, {
                $unset: {
                    discord_id: '',
                    discord_name: '',
                    discord_linked_at: ''
                }
            });
    },

    /**
     * Appends one link/unlink audit row. History only - nothing reads it in flight.
     * @param {object} doc `{uuid, discordId, action, by, discordName, at}`.
     * @returns {Promise<object>} The insertOne result.
     */
    insertLinkAudit: async function (doc) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('discord_link_audit')
            .insertOne(doc);
    },

    /**
     * Reads a code doc whatever its state, so a failed claim can say why it failed. The
     * TTL index drops a code about a minute after it expires, so an old code reads as
     * missing here.
     * @param {string} code Normalised code.
     * @returns {Promise<object|null>} `{code, uuid, username, expiresAt, usedAt, usedBy}` or null.
     */
    findLinkCode: async function (code) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('discord_link_codes')
            .findOne({ code: String(code) }, {
                projection: { _id: 0, code: 1, uuid: 1, username: 1, expiresAt: 1, usedAt: 1, usedBy: 1 }
            });
    },

    /**
     * Appends one failed link attempt. The first call in a process also makes the
     * retention index, so the collection stays small.
     * @param {object} doc A row from buildLinkFailure (discord/commands/util/linkCode.js).
     * @returns {Promise<object>} The insertOne result.
     */
    insertLinkFailure: async function (doc) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const collection = mongoClient.db('bifrost').collection('discord_link_failures');
        if (!linkFailureIndexEnsured) {
            try {
                await collection.createIndex({ at: 1 },
                    { name: 'link_fail_ttl', expireAfterSeconds: LINK_FAILURE_TTL_SECONDS });
                linkFailureIndexEnsured = true;
            } catch (error) {
                sessionLogger.warn('Mongo', 'Could not ensure the discord_link_failures TTL index', error.message);
            }
        }
        return collection.insertOne(doc);
    },

    /**
     * Reads where a bot-owned panel message lives (the #link panel, for one).
     * @param {string} key Panel name.
     * @returns {Promise<object|null>} `{_id, channelId, messageId, hash}` or null.
     */
    getDiscordPanel: async function (key) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db(mongoDBName)
            .collection('discord_panels')
            .findOne({ _id: String(key) });
    },

    /**
     * Remembers where a bot-owned panel message lives, so a restart edits it again.
     * @param {string} key Panel name.
     * @param {object} fields `{channelId, messageId, hash}`.
     * @returns {Promise<object>} The updateOne result.
     */
    saveDiscordPanel: async function (key, fields) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db(mongoDBName)
            .collection('discord_panels')
            .updateOne({ _id: String(key) }, {
                $set: {
                    channelId: String(fields.channelId),
                    messageId: String(fields.messageId),
                    hash: fields.hash == null ? null : String(fields.hash),
                    updatedAt: new Date()
                }
            }, { upsert: true });
    },

    // In-game /link request (bifrost.link_requests). A player who cannot reach Discord -
    // a country that blocks it, or any other reason - asks in game, staff decide on the
    // embed schedulers/linkRequests.js posts, and an approval writes the exemption onto
    // their bifrost.players doc. The proxy watches that collection, so they hear about it
    // in about a second.
    /**
     * The open requests that have not been posted to Discord yet, oldest first.
     * @param {number} limit Max requests per pass.
     * @returns {Promise<object[]>} bifrost.link_requests docs.
     */
    findOpenLinkRequests: async function (limit = 10) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('link_requests')
            .find({ status: 'open', postedAt: null })
            .sort({ createdAt: 1 })
            .limit(limit)
            .toArray();
    },

    /**
     * Gets one request by id - the approve path needs the uuid and the reason off it.
     * @param {*} id The request _id (an ObjectId, or its string form).
     * @returns {Promise<object|null>} The request doc or null.
     */
    getLinkRequest: async function (id) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('link_requests')
            .findOne({ _id: buttonDocId(id) });
    },

    /**
     * Records the message staff decide on, so the request is never posted twice.
     * @param {*} id The request _id.
     * @param {string} messageId The Discord message the embed went to.
     * @returns {Promise<object>} The updateOne result.
     */
    markLinkRequestPosted: async function (id, messageId) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('link_requests')
            .updateOne({ _id: buttonDocId(id) }, {
                $set: {
                    postedAt: new Date(),
                    messageId: String(messageId)
                }
            });
    },

    /**
     * Moves a request out of `open`, and only while it still IS open. The filter is what
     * makes a second click lose instead of decide the same request twice.
     * @param {*} id The request _id.
     * @param {string} status 'approved' or 'denied'.
     * @param {string} decidedBy Discord id of whoever clicked.
     * @param {string} decidedName Their username.
     * @returns {Promise<object>} The updateOne result - `matchedCount` 0 means somebody
     *     else decided it first and the caller must stop there.
     */
    claimLinkRequest: async function (id, status, decidedBy, decidedName) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('link_requests')
            .updateOne({ _id: buttonDocId(id), status: 'open' }, {
                $set: {
                    status: String(status),
                    decidedBy: String(decidedBy),
                    decidedName: String(decidedName),
                    decidedAt: new Date()
                }
            });
    },

    /**
     * Writes the approval onto the player doc. The proxy reads it and stops asking that
     * account to link through Discord.
     * @param {string} uuid Dashed uuid of the Minecraft account.
     * @param {object} exempt `{by, byName, reason, at}`.
     * @returns {Promise<object>} The updateOne result.
     */
    setBifrostLinkExempt: async function (uuid, exempt) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .updateOne({ uuid: String(uuid) }, { $set: { discord_link_exempt: exempt } });
    },

    // Chat guard flags (bifrost.chat_flags). The proxy writes one open doc per player when
    // a message trips the guard, and may add context lines or raise `action` while it stays
    // open. schedulers/chatFlags.js posts the card and owns every field the proxy does not
    // write. None of these helpers touch the proxy's fields. A staff /unmute in game or on
    // the Bifrost console has the proxy close the open muted flag, with `decidedIn: 'game'`.
    /**
     * The open flags that have no card yet, oldest first.
     * @param {number} limit Max flags per pass.
     * @returns {Promise<object[]>} bifrost.chat_flags docs.
     */
    findChatFlagsToPost: async function (limit = 10) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .find({ status: 'open', posted: { $ne: true } })
            .sort({ createdAt: 1 })
            .limit(limit)
            .toArray();
    },

    /**
     * The open flags that already have a card, newest first. The scheduler compares each
     * one with the card it last drew and edits the card when the proxy changed the doc.
     * @param {number} limit Max flags per pass.
     * @returns {Promise<object[]>} bifrost.chat_flags docs.
     */
    findPostedChatFlags: async function (limit = 50) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .find({ status: 'open', posted: true })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
    },

    /**
     * Gets one flag by id.
     * @param {*} id The flag _id (an ObjectId, or its string form).
     * @returns {Promise<object|null>} The flag doc or null.
     */
    getChatFlag: async function (id) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .findOne({ _id: buttonDocId(id) });
    },

    /**
     * Records the card staff decide on, so the flag is never posted twice.
     * @param {*} id The flag _id.
     * @param {string} messageId The Discord message the card went to.
     * @param {string} channelId The channel that message is in.
     * @param {string} cardHash Fingerprint of the card as posted.
     * @returns {Promise<object>} The updateOne result.
     */
    markChatFlagPosted: async function (id, messageId, channelId, cardHash) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .updateOne({ _id: buttonDocId(id) }, {
                $set: {
                    posted: true,
                    postedAt: new Date(),
                    messageId: String(messageId),
                    channelId: String(channelId),
                    cardHash: String(cardHash)
                }
            });
    },

    /**
     * Records the card as it was last drawn, while the flag is still open.
     * @param {*} id The flag _id.
     * @param {string} cardHash Fingerprint of the card after the edit.
     * @returns {Promise<object>} The updateOne result.
     */
    setChatFlagCardHash: async function (id, cardHash) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .updateOne({ _id: buttonDocId(id), status: 'open' }, { $set: { cardHash: String(cardHash) } });
    },

    /**
     * Moves a flag out of `open`, and only while it is still open with the action the
     * clicker saw. A second click matches nothing. So does a click on a card the proxy
     * raised from review to muted after it was drawn.
     * @param {*} id The flag _id.
     * @param {string} action The `action` the card showed ('muted' or 'review').
     * @param {string} status 'banned', 'unmuted', 'kept', 'muted' or 'dismissed'.
     * @param {string} decidedBy Discord id of whoever clicked.
     * @param {string} decidedName Their username.
     * @returns {Promise<object>} The updateOne result. `matchedCount` 0 means the caller
     *     must stop there.
     */
    claimChatFlag: async function (id, action, status, decidedBy, decidedName) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .updateOne({ _id: buttonDocId(id), status: 'open', action: String(action) }, {
                $set: {
                    status: String(status),
                    decidedBy: String(decidedBy),
                    decidedName: String(decidedName),
                    decidedAt: new Date()
                }
            });
    },

    /**
     * The posted flags the proxy closed in game whose card still has its buttons, oldest
     * decision first.
     * @param {number} limit Max flags per pass.
     * @returns {Promise<object[]>} bifrost.chat_flags docs.
     */
    findChatFlagsClosedInGame: async function (limit = 50) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .find({ posted: true, decidedIn: 'game', cardClosed: { $ne: true } })
            .sort({ decidedAt: 1 })
            .limit(limit)
            .toArray();
    },

    /**
     * Records that the card of a flag closed in game shows the decision, so it is not
     * edited again.
     * @param {*} id The flag _id.
     * @returns {Promise<object>} The updateOne result.
     */
    markChatFlagCardClosed: async function (id) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('chat_flags')
            .updateOne({ _id: buttonDocId(id) }, { $set: { cardClosed: true } });
    },

    // Role sync (schedulers/roleSync.js): the linked accounts, and Bifrost's permission
    // shapes. Group membership is an entry on the player doc - `{key: 'group.<name>',
    // value: true}` in `permissions` - and the group itself is a permission_groups doc.
    // The writes below are targeted operators on purpose: permission-api rewrites the
    // whole array, so a read-modify-write from here would race a staff /perms edit.
    /**
     * Every account with a Discord link, with what the sync needs to decide. The playtime
     * maps are per-pack and only the playtime readers want them, so they are off unless
     * asked for - the Verified reconcile does not need to drag them across the wire every
     * interval. `afk_time` comes with `playtime`: active time is the one minus the other,
     * and playtime on its own would count somebody who stood still all evening.
     * @param {object} [options] `{withPlaytime}`.
     * @returns {Promise<object[]>} `{uuid, username, discord_id, permissions}` docs, plus
     *     `playtime` and `afk_time` when asked for.
     */
    findLinkedBifrostPlayers: async function (options = {}) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const projection = { _id: 0, uuid: 1, username: 1, discord_id: 1, permissions: 1 };
        if (options && options.withPlaytime) {
            projection.playtime = 1;
            projection.afk_time = 1;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .find({ discord_id: { $exists: true, $ne: null } }, { projection: projection })
            .toArray();
    },

    /**
     * Every account carrying a group entry THIS sync wrote, found by the marker rather
     * than by who is linked today. Without it an /unlink (either side) drops the account
     * out of the linked read and its granted entry is stuck on for good.
     * @param {string} key `group.<name>`.
     * @param {string} source The `source` context value that marks our own entries.
     * @returns {Promise<object[]>} `{uuid, username, discord_id, permissions}` docs.
     */
    findPlayersWithSyncedGroupEntry: async function (key, source) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .find({
                permissions: {
                    $elemMatch: {
                        key: String(key),
                        context: { $elemMatch: { key: 'source', value: String(source) } }
                    }
                }
            }, {
                projection: { _id: 0, uuid: 1, username: 1, discord_id: 1, permissions: 1 }
            })
            .toArray();
    },

    /**
     * Reads a permission group. A membership entry pointing at a group that does not
     * exist grants nothing, so the sync checks before it writes any.
     * @param {string} name Group name (the doc's _id).
     * @returns {Promise<object|null>} The group doc or null.
     */
    getPermissionGroup: async function (name) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('permission_groups')
            .findOne({ _id: String(name) });
    },

    /**
     * Adds a group membership entry, but only while the account has none for that group.
     * The filter is the idempotency: a second run writes nothing, and a manual grant or
     * an explicit `value: false` denial is never duplicated or overwritten.
     * @param {string} uuid Dashed uuid.
     * @param {object} entry `{key: 'group.<name>', value: true, context?}`.
     * @returns {Promise<object>} The updateOne result (`modifiedCount` 0 = already there).
     */
    addPlayerGroupEntry: async function (uuid, entry) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .updateOne({
                uuid: String(uuid),
                permissions: { $not: { $elemMatch: { key: entry.key } } }
            }, { $push: { permissions: entry } });
    },

    /**
     * Takes back a group membership entry the sync itself wrote - matched on the source
     * context, so a hand-made grant of the same group stays put.
     * @param {string} uuid Dashed uuid.
     * @param {string} key `group.<name>`.
     * @param {string} source The `source` context value that marks our own entries.
     * @returns {Promise<object>} The updateOne result.
     */
    removeSyncedPlayerGroupEntry: async function (uuid, key, source) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db('bifrost')
            .collection('players')
            .updateOne({ uuid: String(uuid) }, {
                $pull: {
                    permissions: {
                        key: String(key),
                        context: { $elemMatch: { key: 'source', value: String(source) } }
                    }
                }
            });
    },

    // Pack role opt-outs (the updater's own DB). The #role-assignment buttons are how a
    // member says no to a pack role, and the playtime sync in roleSync would hand it
    // straight back on the next pass - so a button that REMOVES a role writes a row here,
    // and one that adds it deletes that row again. Keyed on the Discord id: one person may
    // hold several Minecraft accounts.
    /**
     * Remembers that somebody took a pack role off themselves.
     * @param {string} discordId Discord snowflake, as a string.
     * @param {string} tag Pack tag.
     * @returns {Promise<object>} The updateOne result.
     */
    recordPackRoleOptOut: async function (discordId, tag) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        const row = { discordId: String(discordId), tag: String(tag) };
        return mongoClient
            .db(mongoDBName)
            .collection('pack_role_optouts')
            .updateOne(row, { $set: { ...row, at: new Date() } }, { upsert: true });
    },

    /**
     * Forgets an opt-out, because they just switched the role back on.
     * @param {string} discordId Discord snowflake, as a string.
     * @param {string} tag Pack tag.
     * @returns {Promise<object>} The deleteOne result.
     */
    clearPackRoleOptOut: async function (discordId, tag) {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db(mongoDBName)
            .collection('pack_role_optouts')
            .deleteOne({ discordId: String(discordId), tag: String(tag) });
    },

    /**
     * Every opt-out on record. One read per sync pass feeds the planner.
     * @returns {Promise<object[]>} `{discordId, tag, at}` rows.
     */
    findPackRoleOptOuts: async function () {
        if (!mainClientConnected) {
            await mongoClient.connect();
            mainClientConnected = true;
        }

        return mongoClient
            .db(mongoDBName)
            .collection('pack_role_optouts')
            .find({}, { projection: { _id: 0, discordId: 1, tag: 1, at: 1 } })
            .toArray();
    },

    /**
     * Creates the indexes the link flow needs, once per process. Each spec is attempted
     * on its own (one failure used to skip every later one for the life of the process)
     * and the ensured flag is only set once they all landed, so the next lookup retries.
     * @param {object} [db] Bifrost db handle - only tests pass one.
     * @returns {Promise<void>} Resolves when the attempt is done.
     */
    ensureDiscordLinkIndexes: async function (db) {
        if (discordLinkIndexesEnsured) return;

        if (!db) {
            if (!mainClientConnected) {
                await mongoClient.connect();
                mainClientConnected = true;
            }
            db = mongoClient.db('bifrost');
        }

        let allOk = true;
        for (const spec of DISCORD_LINK_INDEXES) {
            try {
                await db.collection(spec.collection).createIndex(spec.keys, spec.options);
            } catch (error) {
                // 85/86: the same keys already exist under another name or options. A retry
                // can never fix that, so stop asking - a human has to drop the old index.
                if (error && (error.code === 85 || error.code === 86)) {
                    sessionLogger.warn('Mongo',
                        `The ${spec.collection} link index already exists differently (code ${error.code})`,
                        error.message);
                    continue;
                }
                allOk = false;
                sessionLogger.warn('Mongo',
                    `Could not ensure a ${spec.collection} discord-link index`, error.message);
            }
        }
        discordLinkIndexesEnsured = allOk;
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