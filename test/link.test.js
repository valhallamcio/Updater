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
 *
 * Every refusal has its own reply (util/linkFlow.js) and its own failure row, and the
 * row carries two characters of the code, never the code. `/link` with no code, the
 * panel's [Link account] and the reply's [Try again] all open the same code box.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const codes = require('../discord/commands/util/linkCode');
const verifiedRole = require('../discord/commands/util/verifiedRole');
const link = require('../discord/commands/link');
const unlink = require('../discord/commands/unlink');
const linked = require('../discord/commands/linked');
const linkFlow = require('../discord/commands/util/linkFlow');
const wrapped = require('../discord/commands/wrapped');
const mongo = require('../modules/mongo');
// captured before beforeEach stubs it out - the index test drives the real one
const ensureDiscordLinkIndexes = mongo.ensureDiscordLinkIndexes;

const NOW = new Date('2026-08-17T12:00:00Z');
const LATER = new Date(Date.now() + 10 * 60 * 1000);
const EARLIER = new Date(Date.now() - 60 * 1000);

let codeDocs;     // code -> doc in bifrost.discord_link_codes
let players;      // uuid -> bifrost.players doc
let identities;   // lowercased username -> doc for getPlayerIdentity
let sets;         // setBifrostDiscordLink calls
let unsets;       // unsetBifrostDiscordLink calls
let claims;       // claimLinkCode calls
let audits;       // insertLinkAudit docs
let failures;     // insertLinkFailure docs
let legacyReads;  // getPlayerByDiscordId calls (the old valhallamc.players lookup)
let roleCalls;    // {action, userId, roleId} from the fake guild
let roleFetchThrows;
let configuredRole;

beforeEach(() => {
    codeDocs = {
        ABC234: { code: 'ABC234', uuid: 'uuid-alp', username: 'Alp', usedAt: null, expiresAt: LATER }
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
    failures = [];
    legacyReads = [];
    roleCalls = [];
    roleFetchThrows = false;
    configuredRole = null;

    // the real one is ONE findOneAndUpdate: the read and the burn cannot interleave, so
    // this fake must not await before it mutates either
    mongo.claimLinkCode = async (code, discordId) => {
        const doc = codeDocs[code];
        // the real filter: {code, usedAt: null, expiresAt: {$gt: now}}
        if (!doc || doc.usedAt || !(doc.expiresAt > new Date())) return null;
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
    // the read-back after a failed claim sees the doc whatever its state
    mongo.findLinkCode = async (code) => (codeDocs[code] ? { ...codeDocs[code] } : null);
    mongo.insertLinkFailure = async (doc) => { failures.push(doc); return { insertedId: 'f' }; };
    mongo.getPlayerByDiscordId = async (discordId) => { legacyReads.push(discordId); return null; };
    mongo.ensureDiscordLinkIndexes = async () => {};

    verifiedRole.getVerifiedRoleId = () => configuredRole;
});

function interaction(options, opts = {}) {
    const replies = [];
    const modals = [];
    const user = { id: opts.userId || '4242', username: opts.username || 'alpdiscord' };
    let deferred = false;
    return {
        replies,
        modals,
        get deferred() { return deferred; },
        user: user,
        customId: opts.customId,
        isButton: () => opts.kind === 'button',
        isModalSubmit: () => opts.kind === 'modal',
        isAutocomplete: () => opts.kind === 'autocomplete',
        isChatInputCommand: () => !opts.kind,
        fields: { getTextInputValue: (name) => (name === 'code' ? options.modalCode : '') },
        showModal: async (modal) => {
            // Discord refuses a modal after a deferral: it has to be the first answer.
            if (deferred) throw new Error('a modal must be the first answer');
            modals.push(modal);
        },
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
        deferReply: async () => { deferred = true; },
        editReply: async (payload) => { replies.push(payload); return payload; },
        respond: async (choices) => { replies.push(choices); return choices; }
    };
}

/** A reply's text, whether it went out as a string or as `{content, components}`. */
function text(reply) {
    return typeof reply === 'string' ? reply : reply.content;
}

/** The custom ids on a reply's buttons. */
function buttonIds(reply) {
    return (reply.components || []).flatMap(row => row.toJSON().components.map(c => c.custom_id));
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
    assert.match(text(it.replies[0]), /Linked to \*\*Alp\*\*/);
});

test('/link: a typo gets its own reply, [Try again], and a failure row - never Mongo', async () => {
    let looked = 0;
    mongo.claimLinkCode = async () => { looked++; return null; };
    const it = interaction({ code: 'nope' });
    await link.execute(it);

    assert.strictEqual(looked, 0);
    assert.strictEqual(sets.length, 0);
    assert.match(text(it.replies[0]), /`nope` is not a link code/);
    assert.match(text(it.replies[0]), /6 letters and digits/);
    assert.deepStrictEqual(buttonIds(it.replies[0]), ['link:open'], '[Try again] opens the code box');
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].reason, 'format');
    assert.strictEqual(failures[0].via, 'command');
    assert.strictEqual(failures[0].discordId, '4242');
    assert.ok(failures[0].at instanceof Date);
});

test('/link: a code nobody minted is "no code exists"', async () => {
    const it = interaction({ code: 'ZZZ999' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0);
    assert.strictEqual(claims.length, 0);
    assert.match(text(it.replies[0]), /No code `ZZZ999` exists/);
    assert.match(text(it.replies[0]), /`\/link` in game/);
    assert.deepStrictEqual(failures.map(f => f.reason), ['unknown']);
});

test('/link: an expired code says so and sends them to /link in game', async () => {
    codeDocs.ABC234.expiresAt = EARLIER; // the claim filter skips it, the read-back still sees it
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0);
    assert.strictEqual(claims.length, 0);
    assert.strictEqual(audits.length, 0);
    assert.match(text(it.replies[0]), /expired/);
    assert.match(text(it.replies[0]), /Type `\/link` in game for a new one/);
    assert.deepStrictEqual(buttonIds(it.replies[0]), ['link:open']);
    assert.deepStrictEqual(failures.map(f => f.reason), ['expired']);
});

test('/link: a code someone else spent says so, and warns about posting it', async () => {
    codeDocs.ABC234.usedAt = NOW;
    codeDocs.ABC234.usedBy = '5555';
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0);
    assert.match(text(it.replies[0]), /Someone else already used this code/);
    assert.match(text(it.replies[0]), /Do not post your code/);
    assert.deepStrictEqual(failures.map(f => f.reason), ['used_other']);
});

test('/link: your own spent code is "already linked" only when the link is really there', async () => {
    codeDocs.ABC234.usedAt = NOW;
    codeDocs.ABC234.usedBy = '4242';

    const notLinked = interaction({ code: 'ABC234' });
    await link.execute(notLinked);
    assert.match(text(notLinked.replies[0]), /You already used this code/);
    assert.deepStrictEqual(buttonIds(notLinked.replies[0]), ['link:open']);

    players['uuid-alp'].discord_id = '4242';
    const isLinked = interaction({ code: 'ABC234' });
    await link.execute(isLinked);
    assert.match(text(isLinked.replies[0]), /\*\*Alp\*\* is already linked to this Discord/);
    assert.deepStrictEqual(buttonIds(isLinked.replies[0]), [], 'nothing to try again');

    assert.deepStrictEqual(failures.map(f => f.reason), ['used_self', 'already']);
    assert.strictEqual(sets.length, 0);
});

test('/link: a code the in-game /unlink burnt says why it stopped working', async () => {
    codeDocs.ABC234.usedAt = NOW;
    codeDocs.ABC234.usedBy = 'unlink';
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.match(text(it.replies[0]), /stopped working when the account was unlinked/);
    assert.deepStrictEqual(failures.map(f => f.reason), ['revoked']);
});

test('/link: a code for a player doc that is gone says so', async () => {
    codeDocs.GH0567 = { code: 'GH0567', uuid: 'uuid-gone', username: 'Gone', usedAt: null, expiresAt: LATER };
    const it = interaction({ code: 'GH0567' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0);
    assert.match(text(it.replies[0]), /no longer knows/);
    assert.deepStrictEqual(failures.map(f => f.reason), ['no_player']);
});

test('/link: a failure row keeps two characters of the code and never the code', async () => {
    await link.execute(interaction({ code: 'zzz-999' }));
    await link.execute(interaction({ code: 'nope' }));

    assert.deepStrictEqual(failures.map(f => f.codePrefix), ['ZZ', 'N0']);
    for (const row of failures) {
        assert.deepStrictEqual(Object.keys(row).sort(), ['at', 'codePrefix', 'discordId', 'reason', 'via']);
        assert.ok(!JSON.stringify(row).includes('ZZZ999'), 'the full code never lands in the row');
    }
    assert.deepStrictEqual(codes.buildLinkFailure({ discordId: 1, reason: 'unknown', code: 'ABC234', via: 'modal', now: NOW }), {
        discordId: '1', reason: 'unknown', codePrefix: 'AB', via: 'modal', at: NOW
    });
});

test('/link: a failure row that cannot be written still gets the player their reply', async () => {
    mongo.insertLinkFailure = async () => { throw new Error('no primary'); };
    const it = interaction({ code: 'ZZZ999' });
    await link.execute(it);
    assert.match(text(it.replies[0]), /No code `ZZZ999` exists/);
});

test('/link: success says no relog, carries no button, and logs no failure', async () => {
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.strictEqual(text(it.replies[0]), '✅ Linked to **Alp**. No relog needed.');
    assert.deepStrictEqual(buttonIds(it.replies[0]), []);
    assert.deepStrictEqual(failures, []);
});

test('/link refuses a Minecraft account already linked to another Discord', async () => {
    codeDocs.XYZ789 = { code: 'XYZ789', uuid: 'uuid-taken', username: 'Taken', usedAt: null, expiresAt: LATER };
    const it = interaction({ code: 'XYZ789' });
    await link.execute(it);

    assert.strictEqual(sets.length, 0, 'never overwrite someone else`s link');
    assert.strictEqual(audits.length, 0);
    assert.strictEqual(players['uuid-taken'].discord_id, '999');
    assert.strictEqual(claims.length, 1, 'the claim came first, so the code is spent');
    assert.match(text(it.replies[0]), /another Discord account/);
    assert.match(text(it.replies[0]), /unlink/);
    assert.match(text(it.replies[0]), /`\/link` for a new code/, 'the code is burnt - say how to get another');
    assert.deepStrictEqual(failures.map(f => f.reason), ['taken']);
});

test('/link with no code opens the code box and claims nothing', async () => {
    const it = interaction({});
    await link.execute(it);

    assert.strictEqual(it.modals.length, 1);
    const modal = it.modals[0].toJSON();
    assert.strictEqual(modal.custom_id, 'link:modal');
    const input = modal.components[0].components[0];
    assert.strictEqual(input.custom_id, 'code');
    assert.match(input.label, /\/link in game/);
    assert.match(input.placeholder, /No code yet\?/);
    assert.strictEqual(it.deferred, false, 'a modal has to be the first answer');
    assert.strictEqual(claims.length + failures.length + it.replies.length, 0);

    const blank = interaction({ code: '   ' });
    await link.execute(blank);
    assert.strictEqual(blank.modals.length, 1, 'a blank code is no code');
});

test('the code box, [Link account] and [My accounts] all go through the same flow', async () => {
    const open = interaction({}, { kind: 'button', customId: 'link:open' });
    assert.strictEqual(linkFlow.owns(open), true);
    await linkFlow.handleInteraction(open);
    assert.strictEqual(open.modals[0].toJSON().custom_id, 'link:modal');

    const submit = interaction({ modalCode: ' abc 234 ' }, { kind: 'modal', customId: 'link:modal' });
    assert.strictEqual(linkFlow.owns(submit), true);
    await linkFlow.handleInteraction(submit);
    assert.deepStrictEqual(claims, [{ code: 'ABC234', discordId: '4242' }]);
    assert.strictEqual(text(submit.replies[0]), '✅ Linked to **Alp**. No relog needed.');

    const again = interaction({ modalCode: 'ABC234' }, { kind: 'modal', customId: 'link:modal' });
    await linkFlow.handleInteraction(again);
    assert.match(text(again.replies[0]), /already linked/);
    assert.strictEqual(failures[0].via, 'modal');

    const mine = interaction({}, { kind: 'button', customId: 'link:mine' });
    await linkFlow.handleInteraction(mine);
    assert.match(mine.replies[0], /\*\*Alp\*\*/);
});

test('owns() takes our buttons and modal only', () => {
    assert.strictEqual(linkFlow.owns(interaction({}, { kind: 'button', customId: 'linkreq:approve:1' })), false);
    assert.strictEqual(linkFlow.owns(interaction({}, { kind: 'button', customId: 'chatflag:ban:1' })), false);
    assert.strictEqual(linkFlow.owns(interaction({}, { kind: 'button', customId: 'ske' })), false, 'a role button');
    assert.strictEqual(linkFlow.owns(interaction({}, { kind: 'autocomplete', customId: 'link:open' })), false);
    assert.strictEqual(linkFlow.owns(interaction({}, {})), false, 'a slash command has no customId');
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
    assert.match(text(loser.replies[0]), /Someone else already used this code/);
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
    assert.match(text(it.replies[0]), /another Discord account/);
});

test('/link twice from the same Discord is idempotent — one write, one audit', async () => {
    const first = interaction({ code: 'ABC234' });
    await link.execute(first);
    codeDocs.DEF567 = { code: 'DEF567', uuid: 'uuid-alp', username: 'Alp', usedAt: null, expiresAt: LATER };
    const second = interaction({ code: 'DEF567' });
    await link.execute(second);

    assert.strictEqual(sets.length, 1);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(claims.length, 2, 'the second code is still burnt');
    assert.match(text(second.replies[0]), /already linked/);
});

test('/link grants the Verified role when one is configured', async () => {
    configuredRole = 'role-1';
    const it = interaction({ code: 'ABC234' });
    await link.execute(it);

    assert.deepStrictEqual(roleCalls, [{ action: 'add', userId: '4242', roleId: 'role-1' }]);
    assert.match(text(it.replies[0]), /Linked to \*\*Alp\*\*/);
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
    assert.match(text(it.replies[0]), /Linked to \*\*Alp\*\*/);
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
    assert.match(empty.replies[0], /<#1552762887276335294>/, 'it names #link, where the button is');

    players['uuid-alp'].discord_id = '4242';
    players['uuid-alp'].discord_linked_at = NOW;
    const it = interaction({});
    await linked.execute(it);
    assert.match(it.replies[0], /\*\*Alp\*\*/);
    assert.match(it.replies[0], /<t:\d+:R>/);
});

test('/wrapped finds the account on bifrost.players, never the legacy collection', async () => {
    players['uuid-alp'].discord_id = '4242';
    players['uuid-alp'].discord_linked_at = new Date('2026-09-25T16:00:00Z');
    players['uuid-alt'] = {
        uuid: 'uuid-alt', username: 'AlpAlt', discord_id: '4242', discord_linked_at: new Date('2026-09-26T09:00:00Z')
    };

    const account = await wrapped._internals.findLinkedAccount('4242');
    assert.strictEqual(account.uuid, 'uuid-alp', 'the first account linked is the one Wrapped is about');
    assert.strictEqual(account.username, 'Alp');
    assert.strictEqual(await wrapped._internals.findLinkedAccount('5555'), null);
    assert.deepStrictEqual(legacyReads, [], 'valhallamc.players is not where links live any more');
});

test('/wrapped with no link points at #link and carries the [Link account] button', async () => {
    const it = interaction({}, { userId: '7777' });
    await wrapped.execute(it);

    assert.deepStrictEqual(legacyReads, []);
    const reply = it.replies[0];
    const description = reply.embeds[0].toJSON().description;
    assert.match(description, /<#1552762887276335294>/);
    assert.match(description, /Link account/);
    assert.ok(!description.includes('1103357751863812207'), 'the deleted #verify channel is gone');
    assert.ok(!/verification button/i.test(description));
    assert.deepStrictEqual(buttonIds(reply), ['link:open']);
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
