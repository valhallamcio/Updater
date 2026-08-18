/*
 * File: roleSyncPlan.js
 * Project: valhalla-updater
 * -----
 * The maths behind the role sync, with no Discord and no Mongo in it: hand it a guild
 * member list and the linked player docs, get back what to grant and what to revoke.
 * Everything that can go wrong here is a wrong grant or a wrong revoke, so it is pure
 * and the tests drive it directly - the scheduler only does the I/O around it.
 *
 * Two rules run through all of it:
 *
 *  - An EMPTY linked-player list is treated as a fault, not as reality. A Mongo read
 *    that came back empty would otherwise strip the Verified role off the whole guild
 *    and every booster with it, so both planners bail and change nothing.
 *  - The booster sync only ever takes back entries IT wrote. A permission entry carries
 *    `context: [{key: 'source', value: 'discord-boost'}]`, which Bifrost ignores while
 *    resolving (only a `server` context scopes an entry - src/plugins/permission-api/
 *    index.ts isEntryActive), so a hand-made booster grant survives every pass.
 */

/** Marks the group entries this sync owns. Anything without it is somebody's manual grant. */
const BOOSTER_SOURCE = 'discord-boost';

/**
 * The permission entry a booster gets. This is Bifrost's group-membership shape:
 * `group.<name>` with value TRUE - a false entry is an explicit denial, not a membership.
 * @param {string} group Permission group name (config `boosterGroup`).
 * @returns {object} `{key, value, context}` ready for the players doc's `permissions` array.
 */
function boosterEntry(group) {
    return {
        key: groupKey(group),
        value: true,
        context: [{ key: 'source', value: BOOSTER_SOURCE }]
    };
}

/**
 * @param {string} group Permission group name.
 * @returns {string} The `group.<name>` key.
 */
function groupKey(group) {
    return `group.${group}`;
}

/**
 * Is this entry one the sync wrote (and may therefore take back)?
 * @param {object} entry A permission entry off the players doc.
 * @returns {boolean} True only for our own marked entries.
 */
function isSyncOwned(entry) {
    if (!entry || !Array.isArray(entry.context)) return false;
    return entry.context.some(c => c && c.key === 'source' && c.value === BOOSTER_SOURCE);
}

/**
 * Finds a player's membership entry for a group, whoever wrote it.
 * @param {object[]} permissions The doc's `permissions` array (may be missing).
 * @param {string} group Permission group name.
 * @returns {object|null} The entry, or null.
 */
function findGroupEntry(permissions, group) {
    if (!Array.isArray(permissions)) return null;
    const key = groupKey(group);
    return permissions.find(e => e && e.key === key) || null;
}

/**
 * Which Discord ids are boosting right now.
 * @param {object[]} members `{id, premiumSince}` per guild member.
 * @returns {Set<string>} Boosting ids as strings.
 */
function boostingIds(members) {
    const boosting = new Set();
    for (const member of members || []) {
        if (member && member.id != null && member.premiumSince) boosting.add(String(member.id));
    }
    return boosting;
}

/**
 * Plans the booster group sync.
 *
 * A grant only happens when the account has NO `group.<booster>` entry at all - an
 * existing one is either a manual grant (leave it) or an explicit `false` denial
 * (definitely leave it). A revoke only happens on our own marked entries, and covers
 * both "stopped boosting" and "left the guild".
 *
 * @param {object} input `{members, players, group}`; members are `{id, premiumSince}`,
 *     players are bifrost.players docs with `discord_id` and `permissions`.
 * @returns {{grants: object[], revokes: object[], skipped: object[]}} Grants and revokes
 *     as `{uuid, username, discordId}`; `skipped` are boosters we left alone because
 *     somebody else owns their entry.
 */
function planBoosterSync({ members, players, group }) {
    const empty = { grants: [], revokes: [], skipped: [] };
    if (!group || !Array.isArray(players) || players.length === 0) return empty;

    const boosting = boostingIds(members);
    const grants = [];
    const revokes = [];
    const skipped = [];

    for (const player of players) {
        if (!player || !player.uuid || player.discord_id == null) continue;
        const discordId = String(player.discord_id);
        const entry = findGroupEntry(player.permissions, group);
        const row = { uuid: player.uuid, username: player.username || player.uuid, discordId };

        if (boosting.has(discordId)) {
            if (!entry) grants.push(row);
            else if (!isSyncOwned(entry)) skipped.push(row);
            continue;
        }

        // Not boosting (or not in the guild any more) - only our own entry comes off.
        if (entry && isSyncOwned(entry)) revokes.push(row);
    }

    return { grants, revokes, skipped };
}

/**
 * Plans the Verified role reconcile: linked accounts hold the role, everybody else
 * does not. /link and /unlink already do this per event - this is what converges a role
 * somebody added or removed by hand, or a link that was made while the bot was down.
 *
 * @param {object} input `{members, players, roleId}`; members are `{id, roles}` with
 *     roles as an array of role ids.
 * @returns {{grants: object[], revokes: object[]}} `{discordId}` rows.
 */
function planVerifiedSync({ members, players, roleId }) {
    const empty = { grants: [], revokes: [] };
    if (!roleId || !Array.isArray(players) || players.length === 0) return empty;

    const linked = new Set();
    for (const player of players) {
        if (player && player.discord_id != null) linked.add(String(player.discord_id));
    }

    const grants = [];
    const revokes = [];
    for (const member of members || []) {
        if (!member || member.id == null) continue;
        const id = String(member.id);
        const hasRole = Array.isArray(member.roles) && member.roles.some(r => String(r) === String(roleId));
        if (linked.has(id) && !hasRole) grants.push({ discordId: id });
        if (!linked.has(id) && hasRole) revokes.push({ discordId: id });
    }

    return { grants, revokes };
}

/**
 * Builds the per-pack ping role report: who would qualify for which pack's role.
 * Read-only by design - pack roles stay opt-in through the role assigner buttons, this
 * only tells staff who is playing enough to be worth pinging.
 *
 * `playtime` on a Bifrost player doc is keyed by pack tag and counted in MILLISECONDS
 * (player-data $incs raw ms), so the threshold is converted here, once.
 *
 * @param {object} input `{servers, players, minHours, memberRoles}`; servers are the
 *     Yggdrasil docs (`tag`, `name`, `discordRoleId`), memberRoles is an optional
 *     `Map<discordId, string[]>` - without it the report cannot say who already holds
 *     the role (that needs the GuildMembers intent).
 * @returns {object[]} `{tag, name, roleId, qualified: [{discordId, username, hours, hasRole}]}`
 *     per pack that has a role, packs with nobody qualifying dropped.
 */
function planPingRoles({ servers, players, minHours, memberRoles }) {
    const minMs = Math.max(0, Number(minHours) || 0) * 60 * 60 * 1000;
    if (!Array.isArray(servers) || !Array.isArray(players)) return [];

    const seen = new Set();
    const report = [];

    for (const server of servers) {
        if (!server || !server.tag) continue;
        const roleId = server.discordRoleId || server.discord_role_id;
        if (!roleId) continue;
        // Instances of one pack share a tag and a role - report the pack once.
        if (seen.has(server.tag)) continue;
        seen.add(server.tag);

        const qualified = [];
        for (const player of players) {
            if (!player || player.discord_id == null) continue;
            const ms = (player.playtime && Number(player.playtime[server.tag])) || 0;
            if (ms < minMs || ms <= 0) continue;
            const discordId = String(player.discord_id);
            const roles = memberRoles ? (memberRoles.get(discordId) || []) : null;
            qualified.push({
                discordId: discordId,
                username: player.username || player.uuid,
                hours: Math.round(ms / 3600000 * 10) / 10,
                hasRole: roles ? roles.some(r => String(r) === String(roleId)) : null
            });
        }

        if (qualified.length === 0) continue;
        qualified.sort((a, b) => b.hours - a.hours);
        report.push({ tag: server.tag, name: server.name || server.tag, roleId: String(roleId), qualified });
    }

    report.sort((a, b) => b.qualified.length - a.qualified.length);
    return report;
}

module.exports = {
    BOOSTER_SOURCE,
    boosterEntry,
    groupKey,
    isSyncOwned,
    findGroupEntry,
    planBoosterSync,
    planVerifiedSync,
    planPingRoles
};
