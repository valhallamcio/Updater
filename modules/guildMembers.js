/*
 * File: guildMembers.js
 * Project: valhalla-updater
 * -----
 * One place that asks Discord for the whole member list, because that is the one thing
 * this bot is not allowed to do today: the GuildMembers privileged intent is NOT enabled
 * on the app, and turning it on is the owner's call in the developer portal.
 *
 * So this never throws and never retries in a loop. Without the intent Discord answers
 * the REST list endpoint with 403 / 50001; we log ONE warning naming the intent and hand
 * back `{ok: false}`, and every caller no-ops on that. Fetching a SINGLE member by id
 * (what /link and /unlink do) needs no intent and is unaffected.
 */

const sessionLogger = require('./sessionLogger');

const PAGE_SIZE = 1000;
// 20 pages = 20k members; a guild that big would need a different approach anyway, and
// the cap is what stops a broken `after` cursor from paging forever.
const MAX_PAGES = 20;

let intentWarned = false;

/**
 * Does this error mean "the GuildMembers intent is off"?
 * 50001 is Missing Access, which is what the members list endpoint answers with when the
 * privileged intent is not enabled; a gateway fetch times out with GuildMembersTimeout.
 * @param {Error} error Whatever discord.js threw.
 * @returns {boolean} True when the missing intent explains it.
 */
function isMissingIntent(error) {
    if (!error) return false;
    if (error.code === 50001 || error.status === 403 || error.httpStatus === 403) return true;
    const text = `${error.code || ''} ${error.name || ''} ${error.message || ''}`;
    return /GuildMembersTimeout|disallowed intent|Missing Access|privileged/i.test(text);
}

/**
 * Lists every member of a guild over REST.
 * @param {object} guild A discord.js Guild.
 * @param {string} component Log component name of the caller.
 * @returns {Promise<{ok: boolean, members: object[], reason: string|null}>} `members` are
 *     plain `{id, premiumSince, roles}` rows (roles as ids), plus the discord.js member
 *     on `member` so a caller can act on it. Never throws.
 */
async function fetchGuildMembers(guild, component = 'RoleSync') {
    if (!guild || !guild.members || typeof guild.members.list !== 'function') {
        return { ok: false, members: [], reason: 'no-guild' };
    }

    const members = [];
    let after;

    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const batch = await guild.members.list({ limit: PAGE_SIZE, after: after, cache: false });
            const rows = [...batch.values()];
            for (const member of rows) {
                members.push({
                    id: String(member.id),
                    premiumSince: member.premiumSince || null,
                    roles: member.roles && member.roles.cache ? [...member.roles.cache.keys()] : [],
                    member: member
                });
            }
            if (rows.length < PAGE_SIZE) break;
            after = rows[rows.length - 1].id;
        }
    } catch (error) {
        if (isMissingIntent(error)) {
            if (!intentWarned) {
                intentWarned = true;
                sessionLogger.warn(component,
                    'Cannot read the guild member list - the GuildMembers privileged intent is not enabled for this bot. ' +
                    'Enable "Server Members Intent" in the Discord developer portal to turn role sync on; until then it does nothing.');
            }
            return { ok: false, members: [], reason: 'missing-intent' };
        }
        sessionLogger.error(component, 'Could not list guild members', error.message);
        return { ok: false, members: [], reason: 'error' };
    }

    return { ok: true, members: members, reason: null };
}

/**
 * Test seam: forget that the intent warning was already logged.
 * @returns {void}
 */
function resetIntentWarning() {
    intentWarned = false;
}

module.exports = { fetchGuildMembers, isMissingIntent, resetIntentWarning, PAGE_SIZE };
