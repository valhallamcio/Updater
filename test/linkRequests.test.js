/*
 * Unit tests for the /link request approvals — the embed staff decide on, and the two
 * writes an approval makes.
 * Run: npm test   (node --test test/)
 *
 * The contract, because the proxy acts on what lands here:
 *
 *  - the request leaves `open` BEFORE the player doc is touched, on a filter that only
 *    matches while it is open, so a double click can never write the exemption twice,
 *  - the loser of that race is told and writes nothing,
 *  - `discord_link_exempt` carries who approved it, their name, the player's own reason
 *    and when - the proxy reads that doc and stops asking the account to link,
 *  - somebody without the staff role is refused before any of it.
 *
 * Mongo is faked at the module surface, the way test/link.test.js does it: the claim is
 * ONE filtered update, so the fake must not await before it mutates.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { PermissionFlagsBits } = require('discord.js');
const linkRequests = require('../schedulers/linkRequests');
const mongo = require('../modules/mongo');

const CONFIG = { interval: 1, channelId: 'chan-1', staffRoleIds: ['role-staff'] };

let requests;   // _id -> bifrost.link_requests doc
let exempts;    // setBifrostLinkExempt calls
let writes;     // every write, in the order it was issued
let posted;     // markLinkRequestPosted calls
let sent;       // channel.send payloads

beforeEach(() => {
    requests = {
        'req-1': {
            _id: 'req-1',
            uuid: 'uuid-alp',
            username: 'Alp',
            reason: 'Discord is blocked where I live',
            country: 'Iran',
            cannotLink: true,
            status: 'open',
            createdAt: new Date('2026-09-01T10:00:00Z'),
            postedAt: null,
            messageId: null
        }
    };
    exempts = [];
    writes = [];
    posted = [];
    sent = [];

    mongo.findOpenLinkRequests = async () =>
        Object.values(requests).filter(r => r.status === 'open' && r.postedAt === null);
    mongo.markLinkRequestPosted = async (id, messageId) => {
        posted.push({ id, messageId });
        requests[id].postedAt = new Date();
        requests[id].messageId = messageId;
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.getLinkRequest = async (id) => (requests[id] ? { ...requests[id] } : null);
    // the real one is a single updateOne filtered on status:'open' - the read and the flip
    // cannot interleave, so this must not await before it mutates
    mongo.claimLinkRequest = async (id, status, decidedBy, decidedName) => {
        const doc = requests[id];
        if (!doc || doc.status !== 'open') return { matchedCount: 0, modifiedCount: 0 };
        doc.status = status;
        doc.decidedBy = String(decidedBy);
        doc.decidedName = String(decidedName);
        doc.decidedAt = new Date();
        writes.push('claim');
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.setBifrostLinkExempt = async (uuid, exempt) => {
        exempts.push({ uuid, exempt });
        writes.push('exempt');
        return { matchedCount: 1, modifiedCount: 1 };
    };
});

/** A button interaction with just the surface the scheduler touches. */
function click(action, id, opts = {}) {
    const replies = [];
    const edits = [];
    return {
        replies,
        edits,
        customId: `linkreq:${action}:${id}`,
        user: { id: opts.userId || 'd-mod', username: opts.username || 'mod' },
        member: { roles: { cache: new Map((opts.roles || ['role-staff']).map(r => [r, { id: r }])) } },
        memberPermissions: { has: (flag) => Boolean(opts.manageGuild) && flag === PermissionFlagsBits.ManageGuild },
        message: {
            id: 'msg-1',
            edit: async (payload) => { edits.push(payload); return payload; }
        },
        reply: async (payload) => { replies.push(payload); return payload; },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); return payload; }
    };
}

/** A channel that hands back a message id, the way discord.js does. */
function channel() {
    return {
        send: async (payload) => {
            sent.push(payload);
            return { id: `msg-${sent.length}` };
        }
    };
}

test('an open request is posted once, with the request id on both buttons', async () => {
    const result = await linkRequests.postOpenRequests(CONFIG, { channel: channel() });

    assert.strictEqual(result.posted, 1);
    assert.deepStrictEqual(posted, [{ id: 'req-1', messageId: 'msg-1' }]);

    const embed = sent[0].embeds[0].toJSON();
    assert.strictEqual(embed.title, 'Link request');
    assert.strictEqual(embed.footer.text, 'Request req-1');
    const fields = new Map(embed.fields.map(f => [f.name, f.value]));
    assert.strictEqual(fields.get('Minecraft name'), 'Alp');
    assert.strictEqual(fields.get('UUID'), '`uuid-alp`');
    assert.match(fields.get('Country'), /^Iran/);
    assert.match(fields.get('Country'), /cannot use Discord/, 'cannotLink is on the card, not just in the doc');
    assert.strictEqual(fields.get('Reason'), 'Discord is blocked where I live');

    const buttons = sent[0].components[0].toJSON().components;
    assert.deepStrictEqual(buttons.map(b => b.custom_id), ['linkreq:approve:req-1', 'linkreq:deny:req-1']);
    assert.strictEqual(buttons[0].style, 3, 'Approve is Success');
    assert.strictEqual(buttons[1].style, 2, 'Deny is Secondary');
    assert.deepStrictEqual(buttons.map(b => b.disabled), [false, false]);

    // Second pass: it is marked as posted, so nothing goes out again.
    const again = await linkRequests.postOpenRequests(CONFIG, { channel: channel() });
    assert.strictEqual(again.posted, 0);
    assert.strictEqual(sent.length, 1);
});

test('approve writes the exemption the proxy reads, and closes the card', async () => {
    const it = click('approve', 'req-1');
    await linkRequests.handleButton(it, CONFIG);

    assert.strictEqual(exempts.length, 1);
    assert.strictEqual(exempts[0].uuid, 'uuid-alp');
    assert.strictEqual(exempts[0].exempt.by, 'd-mod');
    assert.strictEqual(exempts[0].exempt.byName, 'mod');
    assert.strictEqual(exempts[0].exempt.reason, 'Discord is blocked where I live',
        'the player`s own reason, kept with the approval');
    assert.ok(exempts[0].exempt.at instanceof Date);

    assert.strictEqual(requests['req-1'].status, 'approved');
    assert.strictEqual(requests['req-1'].decidedBy, 'd-mod');
    assert.strictEqual(requests['req-1'].decidedName, 'mod');
    assert.ok(requests['req-1'].decidedAt instanceof Date);

    const edited = it.edits[0];
    assert.deepStrictEqual(edited.components[0].toJSON().components.map(b => b.disabled), [true, true],
        'both buttons are out of service once it is decided');
    const fields = edited.embeds[0].toJSON().fields.map(f => f.name);
    assert.ok(fields.includes('Approved by'), 'the card says who decided it');
    assert.match(it.replies[0], /Alp/);
});

test('the status moves BEFORE the player doc - that order is what makes a double click safe', async () => {
    await linkRequests.handleButton(click('approve', 'req-1'), CONFIG);
    assert.deepStrictEqual(writes, ['claim', 'exempt'],
        'the other way round, two clicks racing would both pass the check and both write');
});

test('two clicks on the same request: one decision, one exemption, and the loser is told', async () => {
    const first = click('approve', 'req-1', { userId: 'd-a', username: 'moda' });
    const second = click('approve', 'req-1', { userId: 'd-b', username: 'modb' });

    await Promise.all([
        linkRequests.handleButton(first, CONFIG),
        linkRequests.handleButton(second, CONFIG)
    ]);

    assert.strictEqual(exempts.length, 1, 'the claim is the atomic step - only one of them gets past it');
    assert.strictEqual(writes.filter(w => w === 'claim').length, 1);
    const loser = requests['req-1'].decidedBy === 'd-a' ? second : first;
    assert.match(loser.replies[0], /already decided/);
    assert.strictEqual(loser.edits.length, 0, 'and the loser does not rewrite the card either');
});

test('a uuid with no player doc is an approval that wrote nothing, and the clicker is told', async () => {
    // setBifrostLinkExempt has no upsert, so an unknown uuid matches nothing and throws
    // nothing. The request has already left `open` and can never be posted again, so a
    // silent miss is a player who is approved on the card and never approved in game.
    mongo.setBifrostLinkExempt = async (uuid, exempt) => {
        exempts.push({ uuid, exempt });
        writes.push('exempt');
        return { matchedCount: 0, modifiedCount: 0 };
    };

    const it = click('approve', 'req-1');
    await linkRequests.handleButton(it, CONFIG);

    assert.strictEqual(exempts.length, 1, 'the write was attempted');
    assert.match(it.replies[0], /did not save/,
        'staff must not read the success line off a write that matched no document');
    assert.doesNotMatch(it.replies[0], /can play without linking/);
    assert.ok(it.edits.length > 0, 'the card is still closed - the request IS decided');
});

test('deny moves the request and never touches the player doc', async () => {
    const it = click('deny', 'req-1');
    await linkRequests.handleButton(it, CONFIG);

    assert.strictEqual(requests['req-1'].status, 'denied');
    assert.deepStrictEqual(exempts, [], 'a denial is not an exemption');
    assert.deepStrictEqual(writes, ['claim']);
    assert.ok(it.edits[0].embeds[0].toJSON().fields.some(f => f.name === 'Denied by'));
});

test('somebody without the staff role is refused, and nothing is written', async () => {
    const it = click('approve', 'req-1', { roles: ['role-member'] });
    await linkRequests.handleButton(it, CONFIG);

    assert.deepStrictEqual(writes, [], 'the refusal comes first - before the claim, before the player doc');
    assert.strictEqual(requests['req-1'].status, 'open');
    assert.strictEqual(it.replies.length, 1);
    assert.strictEqual(it.replies[0].ephemeral, true);
    assert.match(it.replies[0].content, /staff/);
});

test('an empty staffRoleIds list falls back to Manage Guild', () => {
    const open = { ...CONFIG, staffRoleIds: [] };
    assert.strictEqual(linkRequests.isStaff(click('approve', 'req-1', { manageGuild: true }), open.staffRoleIds), true);
    assert.strictEqual(linkRequests.isStaff(click('approve', 'req-1', { roles: [] }), open.staffRoleIds), false,
        'no role list and no Manage Guild is not staff');
    assert.strictEqual(linkRequests.isStaff(click('approve', 'req-1', { manageGuild: true, roles: [] }),
        CONFIG.staffRoleIds), false, 'with a role list configured, the role is what counts');
});

test('a request that vanished between the post and the click is refused', async () => {
    const it = click('approve', 'gone');
    await linkRequests.handleButton(it, CONFIG);

    assert.deepStrictEqual(writes, []);
    assert.match(it.replies[0], /no longer in the database/);
});
