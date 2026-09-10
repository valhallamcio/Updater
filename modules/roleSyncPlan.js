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
 *    and every booster with it, so both planners bail and change nothing. Same for a
 *    member list that is not KNOWN to be whole (`complete: false`): everyone the read
 *    missed looks like they left, so an incomplete read plans grants and NO revokes.
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
 * "stopped boosting", "left the guild" and "unlinked" - a doc with no `discord_id` left
 * on it has nothing holding our entry up, which is how an unlinked account stops being
 * a booster (the scheduler feeds those in by our own marker, since an unlinked doc is
 * gone from the linked read forever).
 *
 * @param {object} input `{members, players, group, complete}`; members are
 *     `{id, premiumSince}`, players are bifrost.players docs with `discord_id` and
 *     `permissions`, `complete` says the member list is whole (default true).
 * @returns {{grants: object[], revokes: object[], skipped: object[]}} Grants and revokes
 *     as `{uuid, username, discordId}`; `skipped` are boosters we left alone because
 *     somebody else owns their entry.
 */
function planBoosterSync({ members, players, group, complete = true }) {
    const empty = { grants: [], revokes: [], skipped: [] };
    if (!group || !Array.isArray(players) || players.length === 0) return empty;

    const boosting = boostingIds(members);
    const grants = [];
    const revokes = [];
    const skipped = [];

    for (const player of players) {
        if (!player || !player.uuid) continue;
        const discordId = player.discord_id == null ? null : String(player.discord_id);
        const entry = findGroupEntry(player.permissions, group);
        const row = { uuid: player.uuid, username: player.username || player.uuid, discordId };

        if (discordId !== null && boosting.has(discordId)) {
            if (!entry) grants.push(row);
            else if (!isSyncOwned(entry)) skipped.push(row);
            continue;
        }

        // Not boosting, not in the guild any more, or not linked any more - only our own
        // entry comes off.
        if (entry && isSyncOwned(entry)) revokes.push(row);
    }

    return { grants, revokes: complete ? revokes : [], skipped };
}

/**
 * Plans the Verified role reconcile: linked accounts hold the role, everybody else
 * does not. /link and /unlink already do this per event - this is what converges a role
 * somebody added or removed by hand, or a link that was made while the bot was down.
 *
 * @param {object} input `{members, players, roleId, complete}`; members are `{id, roles}`
 *     with roles as an array of role ids, `complete` says the member list is whole
 *     (default true) - a partial read only ever plans grants.
 * @returns {{grants: object[], revokes: object[]}} `{discordId}` rows.
 */
function planVerifiedSync({ members, players, roleId, complete = true }) {
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

    return { grants, revokes: complete ? revokes : [] };
}

/**
 * Builds the per-pack ping role report: who would qualify for which pack's role.
 * Read-only by design - pack roles stay opt-in through the role assigner buttons, this
 * only tells staff who is playing enough to be worth pinging.
 *
 * `playtime` on a Bifrost player doc is keyed by pack tag and counted in MILLISECONDS
 * (player-data $incs raw ms), so the threshold is converted here, once.
 *
 * ACTIVE playtime, the same measure planPackRoles grants on. Raw playtime would name a
 * different set of people than the assigner does, and staff read the two side by side.
 *
 * @param {object} input `{servers, players, minHours, memberRoles}`; servers are the
 *     Yggdrasil docs (`tag`, `name`, `discordRoleId`), memberRoles is an optional
 *     `Map<discordId, string[]>` - without it the report cannot say who already holds
 *     the role (that needs the GuildMembers intent).
 * @returns {object[]} `{tag, name, roleId, qualified: [{discordId, username, hours, hasRole}]}`
 *     per pack that has a role, `hours` being active hours; packs with nobody
 *     qualifying dropped.
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
            const ms = activePlaytimeMs(player, server.tag);
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

/**
 * Active playtime on one pack, in milliseconds. Both maps sit on the player doc keyed by
 * server TAG, and both are raw milliseconds.
 * @param {object} player A bifrost.players doc.
 * @param {string} tag Pack tag.
 * @returns {number} `playtime[tag]` minus `afk_time[tag]`, never below zero.
 */
function activePlaytimeMs(player, tag) {
    const played = (player.playtime && Number(player.playtime[tag])) || 0;
    const afk = (player.afk_time && Number(player.afk_time[tag])) || 0;
    return Math.max(0, played - afk);
}

/**
 * Plans the pack roles a linked player has earned: enough active playtime on a pack and
 * they hold that pack's Discord role.
 *
 * GRANTS ONLY. The #role-assignment buttons are how somebody says no to a pack role, so a
 * sync that revoked would be fighting them - `optOuts` carries what those buttons removed
 * and this leaves those alone. A member the read did not cover is skipped rather than
 * granted: without their roles there is no way to tell a new role from one they already
 * hold, and one person's several Minecraft accounts only ever earn the role once.
 *
 * @param {object} input `{servers, players, minActiveMs, memberRoles, optOuts, complete}`;
 *     servers are the Yggdrasil docs (`tag`, `name`, `discordRoleId`), memberRoles is a
 *     `Map<discordId, string[]>` (no map at all = the GuildMembers intent is off, and
 *     nothing is granted), optOuts is a `Set` of `"<discordId>:<tag>"`. `complete` is here
 *     for the same reason the other planners take it; nothing here revokes, so a partial
 *     member list only grants less.
 * @returns {object[]} `{discordId, tag, roleId, name, username, activeMs}` per grant.
 */
function planPackRoles({ servers, players, minActiveMs, memberRoles, optOuts, complete = true }) {
    if (!Array.isArray(servers) || !Array.isArray(players) || !memberRoles) return [];
    const minMs = Math.max(0, Number(minActiveMs) || 0);

    const seen = new Set();
    const granted = new Set();
    const grants = [];

    for (const server of servers) {
        if (!server || !server.tag) continue;
        const roleId = server.discordRoleId || server.discord_role_id;
        if (!roleId) continue;
        // Instances of one pack share a tag and a role - decide the pack once.
        if (seen.has(server.tag)) continue;
        seen.add(server.tag);

        for (const player of players) {
            if (!player || player.discord_id == null) continue;
            const active = activePlaytimeMs(player, server.tag);
            if (active <= 0 || active < minMs) continue;

            const discordId = String(player.discord_id);
            const key = `${discordId}:${server.tag}`;
            if (granted.has(key)) continue;
            if (optOuts && optOuts.has(key)) continue;

            const roles = memberRoles.get(discordId);
            if (!roles) continue;
            if (roles.some(r => String(r) === String(roleId))) continue;

            granted.add(key);
            grants.push({
                discordId: discordId,
                tag: server.tag,
                roleId: String(roleId),
                name: server.name || server.tag,
                username: player.username || player.uuid,
                activeMs: active
            });
        }
    }

    return grants;
}

module.exports = {
    BOOSTER_SOURCE,
    boosterEntry,
    groupKey,
    isSyncOwned,
    findGroupEntry,
    activePlaytimeMs,
    planBoosterSync,
    planVerifiedSync,
    planPingRoles,
    planPackRoles
};
