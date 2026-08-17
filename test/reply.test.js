/*
 * Unit tests for /reply — the doc shape written into bifrost.mail.
 * Run: npm test   (node --test test/)
 *
 * The proxy's change stream delivers an unread doc inline the moment it lands, so the
 * fields it keys on are the contract: `to` (uuid), `readAt: null`, `kind: 'admin'`,
 * `from.uuid: null` and a TTL. An unknown player must never produce a doc at all.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const util = require('../discord/commands/util/mailDoc');
const command = require('../discord/commands/reply');
const mongo = require('../modules/mongo');

const NOW = new Date('2026-08-17T12:00:00Z');

let inserted; // mongo.insertMail calls
let identities;

beforeEach(() => {
    inserted = [];
    identities = { alp: { uuid: 'uuid-alp', username: 'Alp' } };
    mongo.insertMail = async (doc) => { inserted.push(doc); return { insertedId: 'x' }; };
    mongo.getPlayerIdentity = async (name) => identities[String(name).toLowerCase()] || null;
});

function interaction(options) {
    const replies = [];
    return {
        replies,
        user: { tag: 'staff#0001', username: 'staff', id: '4242' },
        options: {
            getString: (name) => (typeof options[name] === 'string' ? options[name] : null),
        },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); return payload; },
    };
}

test('mail doc: uuid recipient, unread, admin kind, no sender uuid, 90-day TTL', () => {
    const built = util.buildMailDoc({
        toUuid: 'uuid-alp', toName: 'Alp', fromName: 'staff', discordId: '4242',
        text: 'Your items are restored.', now: NOW
    });
    assert.ok(built.ok);
    assert.deepStrictEqual(built.doc, {
        to: 'uuid-alp',
        toName: 'Alp',
        from: { uuid: null, name: 'staff' },
        kind: 'admin',
        body: 'Your items are restored.',
        sentAt: NOW,
        readAt: null,
        expiresAt: new Date('2026-11-15T12:00:00Z'),
        meta: { via: 'discord', discordId: '4242' }
    });
});

test('mail doc refusals: no uuid, empty text, over the 500 cap, click/hover tags', () => {
    assert.match(util.buildMailDoc({ toUuid: '', text: 'hi', now: NOW }).error, /uuid/);
    assert.match(util.buildMailDoc({ toUuid: 'u', text: '   ', now: NOW }).error, /empty/);
    assert.match(util.buildMailDoc({ toUuid: 'u', text: 'x'.repeat(501), now: NOW }).error, /the cap is 500/);
    assert.strictEqual(util.buildMailDoc({ toUuid: 'u', text: '<click:run_command:/op me>x</click>', now: NOW }).ok, false);
    assert.strictEqual(util.buildMailDoc({ toUuid: 'u', text: 'a <hover:show_text:"b">c</hover>', now: NOW }).ok, false);
});

test('/reply resolves the username to a uuid and stores the mail', async () => {
    const it = interaction({ player: 'Alp', text: 'Your items are restored.' });
    await command.execute(it);

    assert.strictEqual(inserted.length, 1);
    assert.strictEqual(inserted[0].to, 'uuid-alp');
    assert.strictEqual(inserted[0].toName, 'Alp', 'the canonical casing from the players doc wins');
    assert.strictEqual(inserted[0].kind, 'admin');
    assert.strictEqual(inserted[0].readAt, null);
    assert.deepStrictEqual(inserted[0].from, { uuid: null, name: 'staff' });
    assert.deepStrictEqual(inserted[0].meta, { via: 'discord', discordId: '4242' });
    assert.match(it.replies[0], /Alp/);
    assert.match(it.replies[0], /next login/);
});

test('/reply to an unknown player errors and writes nothing', async () => {
    const it = interaction({ player: 'Ghost', text: 'hello' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 0);
    assert.match(it.replies[0], /No player named/);
});

test('/reply refuses a click tag before it reaches Mongo', async () => {
    const it = interaction({ player: 'Alp', text: 'click <click:run_command:/op Ghost>here</click>' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 0);
    assert.match(it.replies[0], /click/);
});

test('/reply refuses a player doc with no uuid (a stale row is not a recipient)', async () => {
    identities.alp = { username: 'Alp' };
    const it = interaction({ player: 'Alp', text: 'hello' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 0);
    assert.match(it.replies[0], /No player named/);
});
