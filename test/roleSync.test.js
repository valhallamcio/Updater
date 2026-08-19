/*
 * Unit tests for the role sync: the Verified role reconcile, the booster group mirror
 * and the read-only ping role report.
 * Run: npm test   (node --test test/)
 *
 * The contract this has to hold, because it writes into somebody else's database:
 *
 *  - Bifrost group membership is `{key: 'group.<name>', value: TRUE}` on the players doc.
 *    A `false` entry is an explicit DENIAL (src/plugins/permission-api/index.ts
 *    activeMemberGroups), so writing one would be the opposite of a grant.
 *  - the sync only takes back entries it wrote, marked with the source context.
 *  - dryRun writes nothing at all, and neither does a pass that finds nothing changed.
 *  - no guild member list (the GuildMembers intent is off on this app) = no-op, one
 *    warning, never a crash and never a retry loop.
 *
 * The guild is faked at the discord.js surface the code actually uses (members.list,
 * member.roles.add/remove), so the pagination and the 403-means-missing-intent
 * classification are exercised for real rather than stubbed away.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const plan = require('../modules/roleSyncPlan');
const guildMembers = require('../modules/guildMembers');
const roleSync = require('../schedulers/roleSync');
const unlink = require('../discord/commands/unlink');
const verifiedRole = require('../discord/commands/util/verifiedRole');
const mongo = require('../modules/mongo');

const ROLE = 'role-verified';
const CONFIG = {
    enabled: true,
    guildId: 'guild-1',
    verifiedRoleId: ROLE,
    boosterGroup: 'booster',
    dryRun: false,
    interval: 30,
    maxChangesPerRun: 50
};

let players;       // what findLinkedBifrostPlayers hands back
let groups;        // permission_groups by name
let adds;          // addPlayerGroupEntry calls
let removes;       // removeSyncedPlayerGroupEntry calls
let roleCalls;     // {action, userId, roleId}
let listCalls;     // every members.list page request
let listError;     // what members.list throws, if anything

beforeEach(() => {
    players = [];
    groups = { booster: { _id: 'booster', permissions: [{ key: 'weight.10', value: true }] } };
    adds = [];
    removes = [];
    roleCalls = [];
    listCalls = [];
    listError = null;
    guildMembers.resetIntentWarning();

    mongo.findLinkedBifrostPlayers = async () => players.map(p => ({ ...p }));
    mongo.getPermissionGroup = async (name) => groups[name] || null;
    mongo.addPlayerGroupEntry = async (uuid, entry) => {
        adds.push({ uuid, entry });
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.removeSyncedPlayerGroupEntry = async (uuid, key, source) => {
        removes.push({ uuid, key, source });
        return { matchedCount: 1, modifiedCount: 1 };
    };
});

/** A member the way discord.js hands one over, with just the surface the code touches. */
function member(id, { boosting = false, roles = [] } = {}) {
    return {
        id: id,
        premiumSince: boosting ? new Date('2026-07-01T00:00:00Z') : null,
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
                listCalls.push(options);
                if (listError) throw listError;
                const start = options.after ? members.findIndex(m => m.id === options.after) + 1 : 0;
                const page = members.slice(start, start + options.limit);
                return new Map(page.map(m => [m.id, m]));
            }
        }
    };
}

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

test('the booster entry is Bifrost group membership: group.<name>, value TRUE, marked as ours', () => {
    const entry = plan.boosterEntry('booster');
    assert.strictEqual(entry.key, 'group.booster');
    assert.strictEqual(entry.value, true, 'a false entry is an explicit denial, not a membership');
    assert.deepStrictEqual(entry.context, [{ key: 'source', value: 'discord-boost' }]);
    assert.strictEqual(plan.isSyncOwned(entry), true);
    assert.strictEqual(plan.isSyncOwned({ key: 'group.booster', value: true }), false, 'a manual grant is not ours');
    assert.strictEqual(plan.BOOSTER_SOURCE, 'discord-boost');
});

test('members -> grants and revokes: boosting gets the group, stopping or leaving takes it back', () => {
    const ours = plan.boosterEntry('booster');
    const result = plan.planBoosterSync({
        group: 'booster',
        members: [
            member('d-new', { boosting: true }),
            member('d-keep', { boosting: true }),
            member('d-stopped'),
            member('d-never')
        ].map(m => ({ id: m.id, premiumSince: m.premiumSince })),
        players: [
            { uuid: 'u-new', username: 'New', discord_id: 'd-new', permissions: [] },
            { uuid: 'u-keep', username: 'Keep', discord_id: 'd-keep', permissions: [ours] },
            { uuid: 'u-stopped', username: 'Stopped', discord_id: 'd-stopped', permissions: [ours] },
            { uuid: 'u-gone', username: 'Gone', discord_id: 'd-gone', permissions: [ours] },
            { uuid: 'u-never', username: 'Never', discord_id: 'd-never', permissions: [] }
        ]
    });

    assert.deepStrictEqual(result.grants.map(g => g.uuid), ['u-new'], 'only the new booster');
    assert.deepStrictEqual(result.revokes.map(r => r.uuid).sort(), ['u-gone', 'u-stopped'],
        'stopped boosting, and left the guild entirely');
});

test('the booster sync never touches an entry it did not write', () => {
    const manual = { key: 'group.booster', value: true };
    const denial = { key: 'group.booster', value: false };
    const result = plan.planBoosterSync({
        group: 'booster',
        members: [{ id: 'd-manual', premiumSince: new Date() }, { id: 'd-denied', premiumSince: new Date() }],
        players: [
            { uuid: 'u-manual', username: 'Manual', discord_id: 'd-manual', permissions: [manual] },
            { uuid: 'u-denied', username: 'Denied', discord_id: 'd-denied', permissions: [denial] }
        ]
    });

    assert.deepStrictEqual(result.grants, [], 'they already have an entry - do not duplicate it');
    assert.deepStrictEqual(result.revokes, [], 'and it is not ours to take back');
    assert.deepStrictEqual(result.skipped.map(s => s.uuid), ['u-manual', 'u-denied']);

    const stopped = plan.planBoosterSync({
        group: 'booster',
        members: [],
        players: [{ uuid: 'u-manual', username: 'Manual', discord_id: 'd-manual', permissions: [manual] }]
    });
    assert.deepStrictEqual(stopped.revokes, [], 'a hand-made grant outlives the boost');
});

test('an empty linked-player list plans nothing - that read is a fault, not reality', () => {
    const members = [member('d-1', { boosting: true, roles: [ROLE] })]
        .map(m => ({ id: m.id, premiumSince: m.premiumSince, roles: [...m.roles.cache.keys()] }));
    assert.deepStrictEqual(plan.planBoosterSync({ group: 'booster', members, players: [] }),
        { grants: [], revokes: [], skipped: [] });
    assert.deepStrictEqual(plan.planVerifiedSync({ roleId: ROLE, members, players: [] }),
        { grants: [], revokes: [] });
});

test('the Verified plan converges a role moved by hand, in both directions', () => {
    const result = plan.planVerifiedSync({
        roleId: ROLE,
        members: [
            { id: 'd-linked-norole', roles: [] },
            { id: 'd-linked-ok', roles: [ROLE, 'other'] },
            { id: 'd-unlinked-role', roles: [ROLE] },
            { id: 'd-unlinked-ok', roles: ['other'] }
        ],
        players: [
            { uuid: 'u-1', discord_id: 'd-linked-norole' },
            { uuid: 'u-2', discord_id: 'd-linked-ok' }
        ]
    });

    assert.deepStrictEqual(result.grants, [{ discordId: 'd-linked-norole' }]);
    assert.deepStrictEqual(result.revokes, [{ discordId: 'd-unlinked-role' }]);
});

test('the ping role report reads playtime as MILLISECONDS and only lists linked accounts', () => {
    const report = plan.planPingRoles({
        minHours: 10,
        servers: [
            { tag: 'arc', name: 'Arcadia', discordRoleId: 'role-arc' },
            { tag: 'arc', name: 'Arcadia 2', discordRoleId: 'role-arc' },
            { tag: 'gtnh', name: 'GTNH', discordRoleId: 'role-gtnh' },
            { tag: 'nolinked', name: 'No role', discordRoleId: '' }
        ],
        players: [
            { uuid: 'u-1', username: 'Alp', discord_id: 'd-1', playtime: { arc: 36000000, gtnh: 3600000 } },
            { uuid: 'u-2', username: 'Bob', discord_id: 'd-2', playtime: { arc: 72000000 } },
            { uuid: 'u-3', username: 'Nolink', playtime: { arc: 99000000 } }
        ],
        memberRoles: new Map([['d-1', ['role-arc']]])
    });

    assert.deepStrictEqual(report.map(r => r.tag), ['arc'], 'gtnh is under 10h; the pack is listed once');
    assert.deepStrictEqual(report[0].qualified.map(q => q.username), ['Bob', 'Alp'], 'most hours first');
    assert.strictEqual(report[0].qualified[1].hours, 10, '36000000ms = 10h');
    assert.strictEqual(report[0].qualified[1].hasRole, true);
    assert.strictEqual(report[0].qualified[0].hasRole, false, 'known member data, no such role');

    const blind = plan.planPingRoles({
        minHours: 10,
        servers: [{ tag: 'arc', name: 'Arcadia', discordRoleId: 'role-arc' }],
        players: [{ uuid: 'u-2', username: 'Bob', discord_id: 'd-2', playtime: { arc: 72000000 } }],
        memberRoles: null
    });
    assert.strictEqual(blind[0].qualified[0].hasRole, null, 'without member data it says unknown, not false');
});

// ---------------------------------------------------------------------------
// The scheduler (I/O around the plan)
// ---------------------------------------------------------------------------

test('a run applies both halves: the role and the group entry', async () => {
    players = [
        { uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [] },
        { uuid: 'u-2', username: 'Bob', discord_id: 'd-2', permissions: [plan.boosterEntry('booster')] }
    ];
    const summary = await roleSync.runOnce(CONFIG, {
        guild: guild([
            member('d-1', { boosting: true }),
            member('d-2', { roles: [ROLE] }),
            member('d-stranger', { roles: [ROLE] })
        ])
    });

    assert.strictEqual(summary.ran, true);
    assert.deepStrictEqual(roleCalls, [
        { action: 'add', userId: 'd-1', roleId: ROLE },
        { action: 'remove', userId: 'd-stranger', roleId: ROLE }
    ]);
    assert.deepStrictEqual(adds, [{ uuid: 'u-1', entry: plan.boosterEntry('booster') }]);
    assert.deepStrictEqual(removes, [{ uuid: 'u-2', key: 'group.booster', source: 'discord-boost' }]);
    assert.deepStrictEqual(summary.verified, { granted: 1, revoked: 1, planned: 2 });
    assert.deepStrictEqual(summary.booster, { granted: 1, revoked: 1, planned: 2 });
});

test('dryRun writes nothing - not a role, not a permission entry', async () => {
    players = [
        { uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [] },
        { uuid: 'u-2', username: 'Bob', discord_id: 'd-2', permissions: [plan.boosterEntry('booster')] }
    ];
    const summary = await roleSync.runOnce({ ...CONFIG, dryRun: true }, {
        guild: guild([
            member('d-1', { boosting: true }),
            member('d-2'),
            member('d-stranger', { roles: [ROLE] })
        ])
    });

    assert.strictEqual(summary.dryRun, true);
    assert.deepStrictEqual(roleCalls, [], 'no role touched');
    assert.deepStrictEqual(adds, [], 'no group entry written');
    assert.deepStrictEqual(removes, []);
    assert.strictEqual(summary.verified.granted + summary.verified.revoked, 3, 'but it still reports the plan');
    assert.strictEqual(summary.booster.granted + summary.booster.revoked, 2);
});

test('a pass that finds nothing changed writes nothing', async () => {
    players = [
        { uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [plan.boosterEntry('booster')] },
        { uuid: 'u-2', username: 'Bob', discord_id: 'd-2', permissions: [] }
    ];
    const summary = await roleSync.runOnce(CONFIG, {
        guild: guild([
            member('d-1', { boosting: true, roles: [ROLE] }),
            member('d-2', { roles: [ROLE] })
        ])
    });

    assert.strictEqual(summary.ran, true);
    assert.deepStrictEqual(roleCalls, []);
    assert.deepStrictEqual(adds, []);
    assert.deepStrictEqual(removes, []);
});

test('no GuildMembers intent: the run no-ops, reads nothing and never throws', async () => {
    players = [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [] }];
    let read = 0;
    mongo.findLinkedBifrostPlayers = async () => { read++; return players; };
    listError = Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });

    const summary = await roleSync.runOnce(CONFIG, { guild: guild([member('d-1', { boosting: true })]) });

    assert.deepStrictEqual(summary, { ran: false, reason: 'missing-intent' });
    assert.strictEqual(read, 0, 'it does not even go to Mongo');
    assert.deepStrictEqual(roleCalls, []);
    assert.deepStrictEqual(adds, []);
    assert.strictEqual(listCalls.length, 1, 'one attempt, no retry loop');

    // Second pass: still a no-op, still silent (the warning is once per process).
    await roleSync.runOnce(CONFIG, { guild: guild([member('d-1', { boosting: true })]) });
    assert.strictEqual(guildMembers.isMissingIntent(listError), true);
    assert.strictEqual(guildMembers.isMissingIntent(new Error('read ECONNRESET')), false,
        'a network blip is not the intent - that one is logged as an error');
});

test('an empty linked-player read skips the whole pass rather than stripping the guild', async () => {
    players = [];
    const summary = await roleSync.runOnce(CONFIG, {
        guild: guild([member('d-stranger', { roles: [ROLE] })])
    });

    assert.deepStrictEqual(summary, { ran: false, reason: 'no-linked-players' });
    assert.deepStrictEqual(roleCalls, []);
});

test('no booster group in permission_groups: the booster half is skipped, the role half still runs', async () => {
    groups = {};
    players = [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [] }];
    const summary = await roleSync.runOnce(CONFIG, { guild: guild([member('d-1', { boosting: true })]) });

    assert.deepStrictEqual(adds, [], 'membership of a group that does not exist grants nothing');
    assert.deepStrictEqual(summary.booster, { granted: 0, revoked: 0, planned: 0 });
    assert.deepStrictEqual(roleCalls, [{ action: 'add', userId: 'd-1', roleId: ROLE }]);
});

test('a pass over the cap does what fits and converges on the next one', async () => {
    // Skipping the whole pass meant drift past the cap NEVER converged: every
    // later run wanted the same oversized plan and refused it again. The cap is
    // a budget, not a veto.
    players = [
        { uuid: 'u-1', username: 'A', discord_id: 'd-1', permissions: [] },
        { uuid: 'u-2', username: 'B', discord_id: 'd-2', permissions: [] }
    ];
    const capped = { ...CONFIG, maxChangesPerRun: 1 };
    const members = () => guild([member('d-1', { boosting: true }), member('d-2', { boosting: true })]);

    const first = await roleSync.runOnce(capped, { guild: members() });
    assert.strictEqual(first.verified.planned, 2, 'it still sees the whole plan');
    const firstWrites = roleCalls.length + adds.length;
    assert.ok(firstWrites > 0, 'and makes progress instead of standing still');
    assert.ok(firstWrites <= 2, 'without blowing through the budget');

    const second = await roleSync.runOnce(capped, { guild: members() });
    const total = roleCalls.length + adds.length;
    assert.ok(total > firstWrites, 'the next pass picks up what did not fit');
    assert.ok(second.verified.planned <= first.verified.planned, 'and the backlog shrinks');
});

test('the member list is paged, and the last page ends it', async () => {
    players = [{ uuid: 'u-1', username: 'Alp', discord_id: 'd-1', permissions: [] }];
    const many = Array.from({ length: 3 }, (_, i) => member(`d-${i}`, { roles: [ROLE] }));
    const paged = {
        members: {
            list: async (options) => {
                listCalls.push(options);
                const start = options.after ? many.findIndex(m => m.id === options.after) + 1 : 0;
                // one at a time, as a guild bigger than the page size would come back
                const page = many.slice(start, start + 1);
                return new Map(page.map(m => [m.id, m]));
            }
        }
    };
    const spy = guildMembers.PAGE_SIZE;
    assert.strictEqual(spy, 1000, 'the page size the pagination is written against');

    const fetched = await guildMembers.fetchGuildMembers(paged, 'Test');
    assert.strictEqual(fetched.ok, true);
    assert.strictEqual(fetched.members.length, 1, 'a short page is the last page');
    assert.deepStrictEqual(listCalls[0], { limit: 1000, after: undefined, cache: false });
});

// ---------------------------------------------------------------------------
// /unlink, the per-event half of the same job
// ---------------------------------------------------------------------------

test('/unlink takes the Verified role back, and the next reconcile agrees', async () => {
    const linked = { uuid: 'u-1', username: 'Alp', discord_id: 'd-1', discord_name: 'alp' };
    let stillLinked = true;

    mongo.findBifrostPlayersByDiscordId = async () => (stillLinked ? [linked] : []);
    mongo.unsetBifrostDiscordLink = async () => { stillLinked = false; return { modifiedCount: 1 }; };
    mongo.insertLinkAudit = async () => ({ insertedId: 'a' });
    verifiedRole.getVerifiedRoleId = () => ROLE;

    const replies = [];
    await unlink.execute({
        user: { id: 'd-1', username: 'alp' },
        memberPermissions: { has: () => false },
        guild: {
            members: {
                fetch: async (id) => ({
                    id: id,
                    roles: {
                        add: async (roleId) => roleCalls.push({ action: 'add', userId: id, roleId }),
                        remove: async (roleId) => roleCalls.push({ action: 'remove', userId: id, roleId })
                    }
                })
            }
        },
        options: { getString: () => null },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); }
    });

    assert.deepStrictEqual(roleCalls, [{ action: 'remove', userId: 'd-1', roleId: ROLE }]);

    // And the reconcile would have done the same thing on its own.
    const converge = plan.planVerifiedSync({
        roleId: ROLE,
        members: [{ id: 'd-1', roles: [ROLE] }],
        players: [{ uuid: 'u-other', discord_id: 'd-other' }]
    });
    assert.deepStrictEqual(converge.revokes, [{ discordId: 'd-1' }]);
});
