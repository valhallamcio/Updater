/*
 * Unit tests for the pack roles: 15 minutes of ACTIVE playtime on a pack and a linked
 * player holds that pack's Discord role.
 * Run: npm test   (node --test test/)
 *
 * The contract:
 *
 *  - active time is `playtime.<tag>` minus `afk_time.<tag>`, both millisecond maps keyed
 *    by the server TAG. Playtime on its own would pay somebody for standing still.
 *  - GRANTS ONLY. The #role-assignment buttons are how a member says no, so every removal
 *    made with one is remembered in pack_role_optouts and this leaves it alone. A sync
 *    that revoked would be fighting the buttons every interval.
 *  - one person, one role: several Minecraft accounts on one Discord earn it once, and
 *    the Discord id is what everything per-person is keyed on.
 *  - the member list is the same gate as everywhere else - without it (the GuildMembers
 *    intent is off on this app) nothing is granted at all.
 *  - `maxChangesPerRun` is ONE budget across all three halves of the reconcile.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const plan = require('../modules/roleSyncPlan');
const roleSync = require('../schedulers/roleSync');
const mongo = require('../modules/mongo');
const yggdrasil = require('../modules/yggdrasil');

const MIN = 15 * 60 * 1000;
const ROLE = 'role-verified';
const ARC = 'role-arc';
const SERVERS = [
    { tag: 'arc', name: 'Arcadia', discordRoleId: ARC },
    { tag: 'arc', name: 'Arcadia Supporter', discordRoleId: ARC },
    { tag: 'gtnh', name: 'GTNH', discordRoleId: 'role-gtnh' },
    { tag: 'noroles', name: 'No role yet', discordRoleId: '' }
];
const CONFIG = {
    enabled: true,
    guildId: 'guild-1',
    verifiedRoleId: ROLE,
    boosterGroup: 'booster',
    packRoles: { enabled: true, minActiveMinutes: 15 },
    dryRun: false,
    interval: 30,
    maxChangesPerRun: 50
};

let players;
let optOuts;
let roleCalls;
let playerReadOptions;

beforeEach(() => {
    players = [];
    optOuts = [];
    roleCalls = [];
    playerReadOptions = [];

    mongo.findLinkedBifrostPlayers = async (options) => {
        playerReadOptions.push(options);
        return players.map(p => ({ ...p }));
    };
    mongo.getPermissionGroup = async () => ({ _id: 'booster', permissions: [] });
    mongo.addPlayerGroupEntry = async () => ({ matchedCount: 1, modifiedCount: 1 });
    mongo.removeSyncedPlayerGroupEntry = async () => ({ matchedCount: 1, modifiedCount: 1 });
    mongo.findPlayersWithSyncedGroupEntry = async () => [];
    mongo.findPackRoleOptOuts = async () => optOuts.map(o => ({ ...o }));
    yggdrasil.getServers = async () => SERVERS.map(s => ({ ...s }));
});

/** A member the way discord.js hands one over, with just the surface the code touches. */
function member(id, roles = []) {
    return {
        id: id,
        premiumSince: null,
        roles: {
            cache: new Map(roles.map(r => [r, { id: r }])),
            add: async (roleId) => roleCalls.push({ action: 'add', userId: id, roleId }),
            remove: async (roleId) => roleCalls.push({ action: 'remove', userId: id, roleId })
        }
    };
}

/** A guild whose member list pages exactly like the REST endpoint does. */
function guild(members) {
    return {
        members: {
            list: async (options) => {
                const start = options.after ? members.findIndex(m => m.id === options.after) + 1 : 0;
                const page = members.slice(start, start + options.limit);
                return new Map(page.map(m => [m.id, m]));
            }
        }
    };
}

/** The Map the planner wants: discord id -> role ids. */
function roleMap(rows) {
    return new Map(rows);
}

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

test('15 minutes exactly qualifies, a millisecond under does not', () => {
    const at = (ms) => plan.planPackRoles({
        servers: [{ tag: 'arc', name: 'Arcadia', discordRoleId: ARC }],
        players: [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', playtime: { arc: ms } }],
        minActiveMs: MIN,
        memberRoles: roleMap([['d-1', []]]),
        optOuts: new Set()
    });

    assert.deepStrictEqual(at(MIN).map(g => g.tag), ['arc'], '15 minutes is enough');
    assert.deepStrictEqual(at(MIN - 1), [], 'a millisecond under is not');
    assert.deepStrictEqual(at(0), [], 'and nobody earns a role for never playing');
    assert.strictEqual(at(MIN)[0].roleId, ARC);
    assert.strictEqual(at(MIN)[0].discordId, 'd-1');
});

test('AFK time comes off the playtime before the threshold is read', () => {
    const grants = plan.planPackRoles({
        servers: [{ tag: 'arc', name: 'Arcadia', discordRoleId: ARC }],
        players: [
            { uuid: 'u-1', username: 'Afk', discord_id: 'd-1', playtime: { arc: 60 * 60 * 1000 }, afk_time: { arc: 59 * 60 * 1000 } },
            { uuid: 'u-2', username: 'Playing', discord_id: 'd-2', playtime: { arc: 60 * 60 * 1000 }, afk_time: { arc: 10 * 60 * 1000 } }
        ],
        minActiveMs: MIN,
        memberRoles: roleMap([['d-1', []], ['d-2', []]]),
        optOuts: new Set()
    });

    assert.deepStrictEqual(grants.map(g => g.username), ['Playing'],
        'an hour with 59 minutes of it AFK is one active minute');
    assert.strictEqual(plan.activePlaytimeMs({ playtime: { arc: 100 }, afk_time: { arc: 400 } }, 'arc'), 0,
        'more AFK than playtime is zero, never negative');
});

test('an opt-out is honoured - the buttons are how somebody says no', () => {
    const input = {
        servers: [{ tag: 'arc', name: 'Arcadia', discordRoleId: ARC }],
        players: [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', playtime: { arc: MIN } }],
        minActiveMs: MIN,
        memberRoles: roleMap([['d-1', []]])
    };

    assert.strictEqual(plan.planPackRoles({ ...input, optOuts: new Set() }).length, 1);
    assert.deepStrictEqual(plan.planPackRoles({ ...input, optOuts: new Set(['d-1:arc']) }), [],
        'they took this one off themselves');
    assert.strictEqual(plan.planPackRoles({ ...input, optOuts: new Set(['d-1:gtnh']) }).length, 1,
        'an opt-out is per pack, not per person');
});

test('nothing is planned for a role somebody already holds, a pack with no role, or an unlinked account', () => {
    const grants = plan.planPackRoles({
        servers: SERVERS,
        players: [
            { uuid: 'u-1', username: 'Has', discord_id: 'd-has', playtime: { arc: MIN, gtnh: MIN, noroles: MIN } },
            { uuid: 'u-2', username: 'Wants', discord_id: 'd-wants', playtime: { arc: MIN } },
            { uuid: 'u-3', username: 'Nolink', playtime: { arc: 10 * MIN } }
        ],
        minActiveMs: MIN,
        memberRoles: roleMap([['d-has', [ARC, 'role-gtnh']], ['d-wants', []]]),
        optOuts: new Set()
    });

    assert.deepStrictEqual(grants.map(g => `${g.discordId}:${g.tag}`), ['d-wants:arc'],
        'the pack with no discordRoleId is skipped, and so is the player with no discord_id');
    assert.strictEqual(grants.filter(g => g.tag === 'arc').length, 1,
        'Arcadia has two instances on one tag - the pack is decided once');
});

test('one Discord with several Minecraft accounts earns the role once', () => {
    const grants = plan.planPackRoles({
        servers: [{ tag: 'arc', name: 'Arcadia', discordRoleId: ARC }],
        players: [
            { uuid: 'u-main', username: 'Alp', discord_id: 'd-1', playtime: { arc: MIN } },
            { uuid: 'u-alt', username: 'AlpAlt', discord_id: 'd-1', playtime: { arc: 5 * MIN } }
        ],
        minActiveMs: MIN,
        memberRoles: roleMap([['d-1', []]]),
        optOuts: new Set()
    });

    assert.strictEqual(grants.length, 1, 'anything per-person keys on the Discord id');
});

test('a member list that is not there grants nothing, and one that is short only grants what it covers', () => {
    const input = {
        servers: [{ tag: 'arc', name: 'Arcadia', discordRoleId: ARC }],
        players: [
            { uuid: 'u-1', username: 'Read', discord_id: 'd-read', playtime: { arc: MIN } },
            { uuid: 'u-2', username: 'Missed', discord_id: 'd-missed', playtime: { arc: MIN } }
        ],
        minActiveMs: MIN,
        optOuts: new Set()
    };

    assert.deepStrictEqual(plan.planPackRoles({ ...input, memberRoles: null }), [],
        'no GuildMembers intent, no idea who holds what - so no grants');

    const partial = plan.planPackRoles({ ...input, memberRoles: roleMap([['d-read', []]]), complete: false });
    assert.deepStrictEqual(partial.map(g => g.discordId), ['d-read'],
        'the member the truncated read missed is left for the next pass');
});

// ---------------------------------------------------------------------------
// The scheduler half
// ---------------------------------------------------------------------------

test('a run gives the pack role to whoever earned it, and asks Mongo for the AFK map', async () => {
    players = [
        { uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [], playtime: { arc: 20 * 60 * 1000 }, afk_time: { arc: 60 * 1000 } },
        { uuid: 'u-2', username: 'Bob', discord_id: 'd-2', permissions: [], playtime: { arc: 20 * 60 * 1000 }, afk_time: { arc: 19 * 60 * 1000 } }
    ];
    const summary = await roleSync.runOnce(CONFIG, {
        guild: guild([member('d-1', [ROLE]), member('d-2', [ROLE])])
    });

    assert.deepStrictEqual(roleCalls, [{ action: 'add', userId: 'd-1', roleId: ARC }],
        'Bob was AFK for all but a minute of it');
    assert.deepStrictEqual(summary.packRoles, { granted: 1, planned: 1 });
    assert.deepStrictEqual(playerReadOptions, [{ withPlaytime: true }],
        'without withPlaytime the docs come back with no playtime map at all');
});

test('the pack roles are off by default and write nothing', async () => {
    players = [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [], playtime: { arc: 10 * 60 * 60 * 1000 } }];
    const resolved = roleSync.resolveConfig({ enabled: true, guildId: 'guild-1' });
    assert.deepStrictEqual(resolved.packRoles, { enabled: false, minActiveMinutes: 15 });

    const summary = await roleSync.runOnce({ ...CONFIG, packRoles: { enabled: false, minActiveMinutes: 15 } }, {
        guild: guild([member('d-1', [ROLE])])
    });

    assert.deepStrictEqual(roleCalls, []);
    assert.deepStrictEqual(summary.packRoles, { granted: 0, planned: 0 });
    assert.deepStrictEqual(playerReadOptions, [{ withPlaytime: false }], 'and the maps stay off the wire');
});

test('a half-set packRoles config still gets the 15 minute default', () => {
    const resolved = roleSync.resolveConfig({ enabled: true, guildId: 'guild-1', packRoles: { enabled: true } });
    assert.deepStrictEqual(resolved.packRoles, { enabled: true, minActiveMinutes: 15 });
});

test('an opt-out read that failed costs the pass rather than undoing everybody`s opt-out', async () => {
    players = [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [], playtime: { arc: 5 * MIN } }];
    mongo.findPackRoleOptOuts = async () => { throw new Error('no primary'); };

    const summary = await roleSync.runOnce(CONFIG, { guild: guild([member('d-1', [ROLE])]) });

    assert.deepStrictEqual(roleCalls, []);
    assert.deepStrictEqual(summary.packRoles, { granted: 0, planned: 0 });
});

test('dryRun plans the pack roles and touches nothing', async () => {
    players = [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [], playtime: { arc: 5 * MIN } }];
    const summary = await roleSync.runOnce({ ...CONFIG, dryRun: true }, {
        guild: guild([member('d-1', [ROLE])])
    });

    assert.deepStrictEqual(roleCalls, []);
    assert.deepStrictEqual(summary.packRoles, { granted: 1, planned: 1 }, 'it still reports the plan');
});

test('all three halves share one budget - the pack roles cannot spend it twice', async () => {
    players = [
        { uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [], playtime: { arc: 5 * MIN } },
        { uuid: 'u-2', username: 'Bob', discord_id: 'd-2', permissions: [], playtime: { arc: 5 * MIN } }
    ];
    // Neither holds the Verified role, so the first half wants two changes on its own.
    const members = () => guild([member('d-1'), member('d-2')]);

    const first = await roleSync.runOnce({ ...CONFIG, maxChangesPerRun: 3 }, { guild: members() });

    assert.strictEqual(first.verified.granted, 2);
    assert.strictEqual(first.packRoles.planned, 2, 'it still sees the whole plan');
    assert.strictEqual(first.packRoles.granted, 1, 'and takes only what is left of the budget');
    assert.strictEqual(first.deferred, 1, 'the rest goes next pass instead of never');
    assert.strictEqual(roleCalls.length, 3, 'three changes, three writes');

    roleCalls = [];
    const second = await roleSync.runOnce({ ...CONFIG, maxChangesPerRun: 3 }, {
        guild: guild([member('d-1', [ROLE]), member('d-2', [ROLE])])
    });
    assert.strictEqual(second.packRoles.granted, 2, 'the next pass picks up what did not fit');
    assert.strictEqual(second.deferred, 0);
});
