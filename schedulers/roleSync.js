/*
 * File: roleSync.js
 * Project: valhalla-updater
 * -----
 * Keeps two Discord facts and Bifrost in step:
 *
 *  - the Verified role sits on exactly the Discord accounts that hold a Minecraft link
 *    (/link and /unlink already do it per event - this converges a role somebody moved
 *    by hand, or a link made while the bot was down),
 *  - a server booster holds membership of Bifrost's `booster` permission group, and
 *    loses it when the boost stops.
 *
 * OFF by default, and it stays off until the owner fills in `guildId` and flips
 * `enabled` - and `dryRun` is true out of the box, so the first real runs only say what
 * they WOULD do. Everything here needs the guild member list, which needs the
 * GuildMembers privileged intent that is NOT enabled on this app today: without it
 * modules/guildMembers.js logs one warning naming the intent and this whole run no-ops.
 *
 * The maths is in modules/roleSyncPlan.js and is tested on its own; what is left here is
 * the I/O, the dry run, and the rails: nothing is written when the linked-player read
 * comes back empty, when the permission group does not exist, or when a single run wants
 * to make more changes than `maxChangesPerRun` (a bad read must not storm the guild).
 */

const mongo = require('../modules/mongo');
const sessionLogger = require('../modules/sessionLogger');
const { fetchGuildMembers } = require('../modules/guildMembers');
const plan = require('../modules/roleSyncPlan');

const LOG = 'RoleSync';

// Warned-once flags, per process - a scheduled re-check every interval is fine, the same
// warning every interval is not.
let warnedNoGroup = false;

module.exports = {
    name: 'roleSync',
    defaultConfig: {
        // `active` is the scheduler loader's switch, `enabled` is the feature's own.
        "active": true,
        "enabled": false,
        "interval": 30,
        "guildId": "",
        // falls back to discordLink.verifiedRoleId (what /link and /unlink use)
        "verifiedRoleId": false,
        "boosterGroup": "booster",
        "dryRun": true,
        "maxChangesPerRun": 50
    },

    /**
     * Starts the reconcile loop.
     * @param {object} options Scheduler config (`scheduler.roleSync` in config.json).
     */
    start: async function (options) {
        const config = this.resolveConfig(options);

        if (!config.enabled) {
            sessionLogger.info(LOG, 'Role sync is off (scheduler.roleSync.enabled = false)');
            return;
        }
        if (!config.guildId) {
            sessionLogger.warn(LOG, 'Role sync is enabled but scheduler.roleSync.guildId is empty - doing nothing');
            return;
        }
        if (config.dryRun) {
            sessionLogger.info(LOG, 'Role sync is in DRY RUN - every change is logged, nothing is written');
        }

        const tick = () => this.runOnce(config).catch(error =>
            sessionLogger.error(LOG, 'Reconcile failed (will try again next interval)', error.message));

        setTimeout(tick, 60000);
        setInterval(tick, Math.max(1, config.interval) * 60 * 1000);
    },

    /**
     * Fills in the defaults and the verified-role fallback, so the rest of the file can
     * read one object.
     * @param {object} options Raw scheduler config.
     * @returns {object} `{enabled, guildId, verifiedRoleId, boosterGroup, dryRun, interval, maxChangesPerRun}`.
     */
    resolveConfig: function (options) {
        const config = Object.assign({}, this.defaultConfig, options || {});
        if (!config.verifiedRoleId) {
            try {
                const linkConfig = require('../config/config.json').discordLink;
                const id = linkConfig && linkConfig.verifiedRoleId;
                config.verifiedRoleId = typeof id === 'string' && id ? id : false;
            } catch (_) {
                config.verifiedRoleId = false; // no config = no role
            }
        }
        return config;
    },

    /**
     * One reconcile pass. Never throws.
     * @param {object} config A resolved config (see resolveConfig).
     * @param {object} [deps] `{guild}` - only tests pass one; otherwise the guild is
     *     fetched off the bot client.
     * @returns {Promise<object>} A summary: `{ran, reason?, verified, booster, dryRun}`.
     */
    runOnce: async function (config, deps = {}) {
        const guild = deps.guild || await this.getGuild(config.guildId);
        if (!guild) return { ran: false, reason: 'no-guild' };

        const fetched = await fetchGuildMembers(guild, LOG);
        if (!fetched.ok) return { ran: false, reason: fetched.reason };

        const players = await mongo.findLinkedBifrostPlayers();
        if (!players || players.length === 0) {
            // Never the moment to strip roles from a whole guild - treat it as a fault.
            sessionLogger.warn(LOG, 'No linked accounts came back from Mongo - skipping this pass');
            return { ran: false, reason: 'no-linked-players' };
        }

        const verified = await this.syncVerifiedRole(config, fetched.members, players);
        const booster = await this.syncBoosterGroup(config, fetched.members, players);

        const changes = verified.granted + verified.revoked + booster.granted + booster.revoked;
        if (changes > 0 || config.dryRun) {
            sessionLogger.info(LOG,
                `${config.dryRun ? '[dry run] ' : ''}${players.length} linked accounts, ${fetched.members.length} members: ` +
                `verified +${verified.granted}/-${verified.revoked}, booster +${booster.granted}/-${booster.revoked}`);
        }

        return { ran: true, verified: verified, booster: booster, dryRun: Boolean(config.dryRun) };
    },

    /**
     * Gets the configured guild off the bot client.
     * @param {string} guildId Guild snowflake.
     * @returns {Promise<object|null>} The guild, or null when it cannot be reached.
     */
    getGuild: async function (guildId) {
        try {
            const { getClient } = require('../discord/bot');
            const client = await getClient();
            return await client.guilds.fetch(String(guildId));
        } catch (error) {
            sessionLogger.error(LOG, `Could not fetch guild ${guildId}`, error.message);
            return null;
        }
    },

    /**
     * Grants the Verified role to linked members and takes it off unlinked ones.
     * @param {object} config Resolved config.
     * @param {object[]} members Rows from fetchGuildMembers.
     * @param {object[]} players Linked player docs.
     * @returns {Promise<{granted: number, revoked: number, planned: number}>} What happened.
     */
    syncVerifiedRole: async function (config, members, players) {
        const result = { granted: 0, revoked: 0, planned: 0 };
        if (!config.verifiedRoleId) return result;

        const { grants, revokes } = plan.planVerifiedSync({
            members: members,
            players: players,
            roleId: config.verifiedRoleId
        });
        result.planned = grants.length + revokes.length;
        if (result.planned === 0) return result;
        if (!this.underCap(config, result.planned, 'verified role')) return result;

        const byId = new Map(members.map(m => [m.id, m.member]));

        for (const row of grants) {
            if (config.dryRun) {
                sessionLogger.info(LOG, `[dry run] would give the Verified role to ${row.discordId}`);
                result.granted++;
                continue;
            }
            try {
                await byId.get(row.discordId).roles.add(config.verifiedRoleId, 'Linked Minecraft account');
                result.granted++;
            } catch (error) {
                sessionLogger.error(LOG,
                    `Could not give the Verified role to ${row.discordId} (Manage Roles, and the bot's top role above it?)`,
                    error.message);
            }
        }

        for (const row of revokes) {
            if (config.dryRun) {
                sessionLogger.info(LOG, `[dry run] would take the Verified role off ${row.discordId}`);
                result.revoked++;
                continue;
            }
            try {
                await byId.get(row.discordId).roles.remove(config.verifiedRoleId, 'No linked Minecraft account');
                result.revoked++;
            } catch (error) {
                sessionLogger.error(LOG, `Could not take the Verified role off ${row.discordId}`, error.message);
            }
        }

        return result;
    },

    /**
     * Mirrors Discord boosts into the Bifrost permission group.
     * @param {object} config Resolved config.
     * @param {object[]} members Rows from fetchGuildMembers.
     * @param {object[]} players Linked player docs.
     * @returns {Promise<{granted: number, revoked: number, planned: number}>} What happened.
     */
    syncBoosterGroup: async function (config, members, players) {
        const result = { granted: 0, revoked: 0, planned: 0 };
        if (!config.boosterGroup) return result;

        const group = await mongo.getPermissionGroup(config.boosterGroup);
        if (!group) {
            if (!warnedNoGroup) {
                warnedNoGroup = true;
                sessionLogger.warn(LOG,
                    `There is no '${config.boosterGroup}' group in bifrost.permission_groups - a membership entry ` +
                    'pointing at a group that does not exist grants nothing, so the booster sync is skipped');
            }
            return result;
        }
        warnedNoGroup = false;

        const { grants, revokes, skipped } = plan.planBoosterSync({
            members: members,
            players: players,
            group: config.boosterGroup
        });
        for (const row of skipped) {
            sessionLogger.debug(LOG, `${row.username} boosts but their ${config.boosterGroup} entry is somebody else's - left alone`);
        }

        result.planned = grants.length + revokes.length;
        if (result.planned === 0) return result;
        if (!this.underCap(config, result.planned, 'booster group')) return result;

        const entry = plan.boosterEntry(config.boosterGroup);

        for (const row of grants) {
            if (config.dryRun) {
                sessionLogger.info(LOG, `[dry run] would add ${row.username} to ${config.boosterGroup} (boosting as ${row.discordId})`);
                result.granted++;
                continue;
            }
            try {
                const write = await mongo.addPlayerGroupEntry(row.uuid, entry);
                if (write && write.modifiedCount > 0) result.granted++;
            } catch (error) {
                sessionLogger.error(LOG, `Could not add ${row.username} to ${config.boosterGroup}`, error.message);
            }
        }

        for (const row of revokes) {
            if (config.dryRun) {
                sessionLogger.info(LOG, `[dry run] would remove ${row.username} from ${config.boosterGroup} (no longer boosting)`);
                result.revoked++;
                continue;
            }
            try {
                const write = await mongo.removeSyncedPlayerGroupEntry(row.uuid, entry.key, plan.BOOSTER_SOURCE);
                if (write && write.modifiedCount > 0) result.revoked++;
            } catch (error) {
                sessionLogger.error(LOG, `Could not remove ${row.username} from ${config.boosterGroup}`, error.message);
            }
        }

        return result;
    },

    /**
     * The circuit breaker: a pass that suddenly wants to change half the guild is a bad
     * read far more often than it is real, so it reports instead of firing.
     * @param {object} config Resolved config.
     * @param {number} planned How many changes this half wants to make.
     * @param {string} what Which half, for the log line.
     * @returns {boolean} True when it may go ahead.
     */
    underCap: function (config, planned, what) {
        const cap = Number(config.maxChangesPerRun) || 0;
        if (cap <= 0 || planned <= cap) return true;
        sessionLogger.warn(LOG,
            `The ${what} pass wants ${planned} changes, over the ${cap} cap - nothing was done. ` +
            'Check the plan (dryRun) and raise scheduler.roleSync.maxChangesPerRun if it is right.');
        return false;
    }
};
