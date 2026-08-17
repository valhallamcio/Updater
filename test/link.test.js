/*
 * Unit tests for /link, /unlink and /linked — the docs written into the Bifrost
 * collections and the refusals that keep a link honest.
 * Run: npm test   (node --test test/)
 *
 * The proxy reads `discord_id` off bifrost.players and renders it in game, so the
 * contract is: a STRING snowflake, a Date for `discord_linked_at`, the code burnt so it
 * can only link once, and an audit row. A Minecraft account already linked to another
 * Discord is never overwritten, and the optional Verified role can fail all it likes -
 * the link is in Mongo and stays there.
 *
 * The two races are covered here because neither shows up in a single-caller test: the
 * code is claimed atomically (two Discords, one code, one link) and the player write is
 * filtered on the account still being free (an in-game link landing mid-flow wins).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const codes = require('../discord/commands/util/linkCode');
const verifiedRole = require('../discord/commands/util/verifiedRole');
const link = require('../discord/commands/link');
const unlink = require('../discord/commands/unlink');
const linked = require('../discord/commands/linked');
const mongo = require('../modules/mongo');
// captured before beforeEach stubs it out - the index test drives the real one
const ensureDiscordLinkIndexes = mongo.ensureDiscordLinkIndexes;

const NOW = new Date('2026-08-17T12:00:00Z');

let codeDocs;     // code -> doc in bifrost.discord_link_codes
let players;      // uuid -> bifrost.players doc
let identities;   // lowercased username -> doc for getPlayerIdentity
let sets;         // setBifrostDiscordLink calls
let unsets;       // unsetBifrostDiscordLink calls
let claims;       // claimLinkCode calls
let audits;       // insertLinkAudit docs
let roleCalls;    // {action, userId, roleId} from the fake guild
let roleFetchThrows;
let configuredRole;

beforeEach(() => {
    codeDocs = {
        ABC234: { code: 'ABC234', uuid: 'uuid-alp', username: 'Alp', usedAt: null }
    };
    players = {
        'uuid-alp': { uuid: 'uuid-alp', username: 'Alp' },
        'uuid-taken': { uuid: 'uuid-taken', username: 'Taken', discord_id: '999', discord_name: 'someone' }
    };
    identities = {};
    sets = [];
    unsets = [];
    claims = [];
    audits = [];
    roleCalls = [];
    roleFetchThrows = false;
    configuredRole = null;

    // the real one is ONE findOneAndUpdate: the read and the burn cannot interleave, so
    // this fake must not await before it mutates either
    mongo.claimLinkCode = async (code, discordId) => {
        const doc = codeDocs[code];
        if (!doc || doc.usedAt) return null;
        doc.usedAt = NOW;
        doc.usedBy = String(discordId);
        claims.push({ code, discordId });
        return doc;
    };
    mongo.getBifrostPlayerByUuid = async (uuid) => players[uuid] || null;
    mongo.getPlayerIdentity = async (name) => identities[String(name).toLowerCase()] || null;
    mongo.findBifrostPlayersByDiscordId = async (discordId) =>
        Object.values(players).filter(p => p.discord_id === String(discordId));
    mongo.setBifrostDiscordLink = async (uuid, linkFields) => {
        // the real filter is {uuid, discord_id: {$in: [null]}} - an account that is already
        // linked matches nothing, and that is what stops an overwrite
        const player = players[uuid];
        if (!player || player.discord_id != null) return { matchedCount: 0, modifiedCount: 0 };
        sets.push({ uuid, ...linkFields });
        // exactly what modules/mongo.js $sets - the field shape is the proxy's contract
        players[uuid] = { ...player, ...codes.buildLinkFields(linkFields) };
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.unsetBifrostDiscordLink = async (uuid) => {
        unsets.push(uuid);
        if (players[uuid]) {
            delete players[uuid].discord_id;
            delete players[uuid].discord_name;
            delete players[uuid].discord_linked_at;
        }
        return { modifiedCount: 1 };
    };
    mongo.insertLinkAudit = async (doc) => { audits.push(doc); return { insertedId: 'a' }; };
    mongo.ensureDiscordLinkIndexes = async () => {};

    verifiedRole.getVerifiedRoleId = () => configuredRole;
});

function interaction(options, opts = {}) {
    const replies = [];
    const user = { id: opts.userId || '4242', username: opts.username || 'alpdiscord' };
    return {
        replies,
        user: user,
        memberPermissions: { has: () => Boolean(opts.staff) },
        guild: {
            members: {
                fetch: async (id) => {
                    if (roleFetchThrows) throw new Error('Missing Permissions');
                    return {
                        id: id,
                        roles: {
                            add: async (roleId) => roleCalls.push({ action: 'add', userId: id, roleId }),
                            remove: async (roleId) => roleCalls.push({ action: 'remove', userId: id, roleId })
                        }
                    };
                }
            }
        },
        options: {
            getString: (name) => (typeof options[name] === 'string' ? options[name] : null),
            getFocused: () => ({ name: 'player', value: options.focused || '' })
        },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); return payload; },
        respond: async (choices) => { replies.push(choices); return choices; }
    };
}

test('link code normalisation: case, spaces, dashes, underscores and the O/I/L lookalikes', () => {
    const table = [
        ['abc-234', 'ABC234'],
        ['ABC 234', 'ABC234'],
        ['abc_234', 'ABC234', 'the proxy strips _ as well - a copied code often carries one'],
        ['ABC\u2010234', 'ABC234', 'U+2010, what a phone keyboard makes of a hyphen'],
        ['ABC\u2015234', 'ABC234', 'U+2015 is the top of the dash range'],
        [' abc-2 34 ', 'ABC234'],
        ['abc234', 'ABC234'],
        ['oil234', '011234'],
        [null, '']
    ];
    for (const [input, want, why] of table) {
        assert.strictEqual(codes.normalizeCode(input), want, why || JSON.stringify(input));
    }
});

test('link code validity: 6 Crockford chars, no I L O U', () => {
    assert.strictEqual(codes.isValidCode('ABC234'), true);
    assert.strictEqual(codes.isValidCode('011234'), true);
    assert.strictEqual(codes.isValidCode('ABC23'), false, 'too short');
    assert.strictEqual(codes.isValidCode('ABC2345'), false, 'too long');
    assert.strictEqual(codes.isValidCode('abc234'), false, 'normalise first');
    for (const bad of ['I', 'L', 'O', 'U']) {
        assert.strictEqual(codes.isValidCode(`ABC2${bad}4`), false, `${bad} is not in the alphabet`);
    }
    assert.strictEqual(codes.ALPHABET.length, 32);
    assert.ok(codes.ALPHABET.split('').every(c => codes.isValidCode(c.repeat(6))));
});

test('the player fields are a STRING snowflake and a Date - a number loses digits', () => {
    const fields = codes.buildLinkFields({ discordId: '1362840000000000123', discordName: 'alpdiscord', now: NOW });
    assert.deepStrictEqual(fields, {
        discord_id: '1362840000000000123',
        discord_name: 'alpdiscord',
        discord_linked_at: NOW
    });
    assert.strictEqual(typeof fields.discord_id, 'string');
    assert.notStrictEqual(String(Number(fields.discord_id)), fields.discord_id, 'past 2^53 - why it is a string');
    assert.strictEqual(codes.buildLinkFields({ discordId: 4242, now: NOW }).discord_id, '4242');
    assert.strictEqual(codes.buildLinkFields({ discordId: '1', now: NOW }).discord_name, '');
    assert.ok(codes.buildLinkFields({ discordId: '1' }).discord_linked_at instanceof Date);
});

test('the audit row carries an actor only when someone else did the unlinking', () => {
    assert.deepStrictEqual(codes.buildLinkAudit({
        uuid: 'uuid-alp', discordId: '4242', action: 'link', discordName: 'alpdiscord', now: NOW
    }), {
        uuid: 'uuid-alp', discordId: '4242', action: 'link', by: 'discord',
        discordName: 'alpdiscord', at: NOW
    });
    assert.strictEqual(codes.buildLinkAudit({
        uuid: 'u', discordId: '4242', action: 'unlink', actor: '4242', now: NOW
    }).actor, undefined, 'unlinking your own account is not a staff action');
    assert.strictEqual(codes.buildLinkAudit({
        uuid: 'u', discordId: '999', action: 'unlink', actor: '1111', now: NOW
    }).actor, '1111');
    assert.strictEqual(codes.buildLinkAudit({ uuid: 'u', discordId: '1', action: 'unlink' }).discordName, null);
});

test('/link writes discord_id as a STRING, burns the code and audits it', async () => {
    const it = interaction({ code: 'abc-234' });
    await link.execute(it);

    assert.deepStrictEqual(sets, [{ uuid: 'uuid-alp', discordId: '4242', discordName: 'alpdiscord' }]);
    assert.strictEqual(typeof players['uuid-alp'].discord_id, 'string', 'a snowflake never survives a JS number');
    assert.strictEqual(players['uuid-alp'].discord_id, '4242');
    assert.strictEqual(players['uuid-alp'].discord_name, 'alpdiscord');
    assert.ok(players['uuid-alp'].discord_linked_at instanceof Date);

    assert.deepStrictEqual(claims, [{ code: 'ABC234', discordId: '4242' }]);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].uuid, 'uuid-alp');
    assert.strictEqual(audits[0].discordId, '4242');
    assert.strictEqual(audits[0].action, 'link');
    assert.strictEqual(audits[0].by, 'discord');
    assert.strictEqual(audits[0].discordName, 'alpdiscord');
    assert.ok(audits[0].at instanceof Date);
    assert.match(it.replies[0], /Linked to \*\*Alp\*\*/);
});

test('/link refuses a malformed code before it reaches Mongo', async () => {
    let looked = 0;
    mongo.claimLinkCode = async () => { looked++; return null; };
    const it = interaction({ code: 'nope' });
    await link.execute(it);

    assert.strictEqual(looked, 0);
    assert.strictEqual(sets.length, 0);
    assert.match(it.replies[0], /not valid or has expired/);
});

test('/link refuses an expired or already-used code (the claim filters both)', async () => {
    codeDocs = {}; // the claim only matches usedAt:null and expiresAt in the future
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0);
    assert.strictEqual(claims.length, 0);
    assert.strictEqual(audits.length, 0);
    assert.match(it.replies[0], /not valid or has expired/);
});

test('/link refuses a Minecraft account already linked to another Discord', async () => {
    codeDocs.XYZ789 = { code: 'XYZ789', uuid: 'uuid-taken', username: 'Taken', usedAt: null };
    const it = interaction({ code: 'XYZ789' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0, 'never overwrite someone else`s link');
    assert.strictEqual(audits.length, 0);
    assert.strictEqual(players['uuid-taken'].discord_id, '999');
    assert.strictEqual(claims.length, 1, 'the claim came first, so the code is spent');
    assert.match(it.replies[0], /another Discord account/);
    assert.match(it.replies[0], /unlink/);
    assert.match(it.replies[0], /`\/link` again/, 'the code is burnt - say how to get another');
});

test('two Discords redeeming the same code: exactly one link and one role', async () => {
    configuredRole = 'role-1';
    const first = interaction({ code: 'ABC234' }, { userId: '4242', username: 'alpdiscord' });
    const second = interaction({ code: 'ABC234' }, { userId: '5555', username: 'someoneelse' });

    // reading the code and burning it afterwards let both of these through the check
    await Promise.all([link.execute(first), link.execute(second)]);

    assert.strictEqual(claims.length, 1, 'the claim is the atomic step - one of them wins it');
    assert.strictEqual(sets.length, 1);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(roleCalls.length, 1, 'the loser is not verified either');
    const winner = sets[0].discordId;
    assert.strictEqual(players['uuid-alp'].discord_id, winner);
    assert.deepStrictEqual(roleCalls, [{ action: 'add', userId: winner, roleId: 'role-1' }]);
    const loser = winner === '4242' ? second : first;
    assert.match(loser.replies[0], /not valid or has expired/);
});

test('a link landing between the claim and the write is refused, never overwritten', async () => {
    configuredRole = 'role-1';
    let reads = 0;
    mongo.getBifrostPlayerByUuid = async (uuid) => {
        const snapshot = players[uuid] ? { ...players[uuid] } : null;
        // in game /link (or the legacy import) lands right after this read
        if (++reads === 1) players[uuid] = { ...players[uuid], discord_id: '999', discord_name: 'someone' };
        return snapshot;
    };

    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0, 'the filtered write loses the race instead of winning it');
    assert.strictEqual(players['uuid-alp'].discord_id, '999');
    assert.strictEqual(players['uuid-alp'].discord_name, 'someone');
    assert.strictEqual(audits.length, 0);
    assert.deepStrictEqual(roleCalls, []);
    assert.match(it.replies[0], /another Discord account/);
});

test('/link twice from the same Discord is idempotent — one write, one audit', async () => {
    const first = interaction({ code: 'ABC234' });
    await link.execute(first);
    codeDocs.DEF567 = { code: 'DEF567', uuid: 'uuid-alp', username: 'Alp', usedAt: null };
    const second = interaction({ code: 'DEF567' });
    await link.execute(second);

    assert.strictEqual(sets.length, 1);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(claims.length, 2, 'the second code is still burnt');
    assert.match(second.replies[0], /already linked/);
});

test('/link grants the Verified role when one is configured', async () => {
    configuredRole = 'role-1';
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.deepStrictEqual(roleCalls, [{ action: 'add', userId: '4242', roleId: 'role-1' }]);
    assert.match(it.replies[0], /Linked to \*\*Alp\*\*/);
});

test('/link touches no role when none is configured', async () => {
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);
    assert.deepStrictEqual(roleCalls, []);
    assert.strictEqual(sets.length, 1);
});

test('a throwing role fetch does NOT fail the link', async () => {
    configuredRole = 'role-1';
    roleFetchThrows = true;
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.strictEqual(sets.length, 1, 'the link is in Mongo either way');
    assert.strictEqual(audits.length, 1);
    assert.deepStrictEqual(roleCalls, []);
    assert.match(it.replies[0], /Linked to \*\*Alp\*\*/);
});

test('/unlink drops the link, audits it and takes the role back when nothing is left', async () => {
    configuredRole = 'role-1';
    players['uuid-alp'].discord_id = '4242';
    players['uuid-alp'].discord_name = 'alpdiscord';

    const it = interaction({});
    await unlink.execute(it);

    assert.deepStrictEqual(unsets, ['uuid-alp']);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].action, 'unlink');
    assert.strictEqual(audits[0].by, 'discord');
    assert.strictEqual(audits[0].discordId, '4242');
    assert.strictEqual(audits[0].actor, undefined, 'unlinking your own account has no separate actor');
    assert.deepStrictEqual(roleCalls, [{ action: 'remove', userId: '4242', roleId: 'role-1' }]);
    assert.match(it.replies[0], /Alp/);
});

test('/unlink keeps the role while another account is still linked', async () => {
    configuredRole = 'role-1';
    players['uuid-alp'].discord_id = '4242';
    players['uuid-alt'] = { uuid: 'uuid-alt', username: 'AlpAlt', discord_id: '4242' };

    const it = interaction({ player: 'Alp' });
    await unlink.execute(it);

    assert.deepStrictEqual(unsets, ['uuid-alp']);
    assert.deepStrictEqual(roleCalls, [], 'AlpAlt is still linked');
});

test('/unlink with several accounts and no name asks which one', async () => {
    players['uuid-alp'].discord_id = '4242';
    players['uuid-alt'] = { uuid: 'uuid-alt', username: 'AlpAlt', discord_id: '4242' };

    const it = interaction({});
    await unlink.execute(it);

    assert.strictEqual(unsets.length, 0);
    assert.match(it.replies[0], /several accounts/);
});

test('/unlink refuses someone else`s account for a normal member', async () => {
    identities.taken = players['uuid-taken'];
    const it = interaction({ player: 'Taken' });
    await unlink.execute(it);

    assert.strictEqual(unsets.length, 0);
    assert.strictEqual(audits.length, 0);
    assert.strictEqual(players['uuid-taken'].discord_id, '999');
    assert.match(it.replies[0], /not linked to your Discord/);
});

test('/unlink lets a Manage Guild member undo anyone`s link, and records the actor', async () => {
    configuredRole = 'role-1';
    identities.taken = players['uuid-taken'];
    const it = interaction({ player: 'Taken' }, { staff: true, userId: '1111', username: 'mod' });
    await unlink.execute(it);

    assert.deepStrictEqual(unsets, ['uuid-taken']);
    assert.strictEqual(audits[0].discordId, '999', 'the link that was removed, not the staff member');
    assert.strictEqual(audits[0].actor, '1111');
    assert.deepStrictEqual(roleCalls, [{ action: 'remove', userId: '999', roleId: 'role-1' }]);
});

test('/unlink autocompletes over the caller`s own linked accounts only', async () => {
    players['uuid-alp'].discord_id = '4242';
    players['uuid-alt'] = { uuid: 'uuid-alt', username: 'AlpAlt', discord_id: '4242' };

    const it = interaction({ focused: 'alp' });
    await unlink.autocomplete(it);

    assert.deepStrictEqual(it.replies[0], [
        { name: 'Alp', value: 'Alp' },
        { name: 'AlpAlt', value: 'AlpAlt' }
    ]);
});

test('/linked lists the caller`s accounts, and says so when there are none', async () => {
    const empty = interaction({});
    await linked.execute(empty);
    assert.match(empty.replies[0], /No Minecraft accounts are linked/);

    players['uuid-alp'].discord_id = '4242';
    players['uuid-alp'].discord_linked_at = NOW;
    const it = interaction({});
    await linked.execute(it);
    assert.match(it.replies[0], /\*\*Alp\*\*/);
    assert.match(it.replies[0], /<t:\d+:R>/);
});

test('the discord-link indexes are the proxy`s specs, and one failure is retried', async () => {
    const calls = [];
    let failFirst = true;
    const db = {
        collection: (name) => ({
            createIndex: async (keys, options) => {
                calls.push({ collection: name, keys, options });
                if (failFirst && calls.length === 1) throw new Error('no primary');
                return name;
            }
        })
    };

    await ensureDiscordLinkIndexes(db);
    assert.deepStrictEqual(calls, [
        { collection: 'players', keys: { discord_id: 1 }, options: { sparse: true } },
        { collection: 'discord_link_codes', keys: { code: 1 }, options: { name: 'link_code', unique: true } },
        { collection: 'discord_link_codes', keys: { uuid: 1 }, options: { name: 'link_uuid' } },
        {
            collection: 'discord_link_codes',
            keys: { expiresAt: 1 },
            options: { name: 'link_ttl', expireAfterSeconds: 0 }
        }
    ], 'same names and options as src/plugins/discord-link, and a throw skips no later spec');

    failFirst = false;
    calls.length = 0;
    await ensureDiscordLinkIndexes(db);
    assert.strictEqual(calls.length, 4, 'nothing was marked ensured while one spec was missing');

    calls.length = 0;
    await ensureDiscordLinkIndexes(db);
    assert.deepStrictEqual(calls, [], 'all four landed - once per process is enough');
});
