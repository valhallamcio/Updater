/*
 * Unit tests for the image scam filter (schedulers/imageScamFilter.js) and its SubQ client.
 * Run: npm test   (node --test test/)
 *
 * The contract, because a hit deletes messages and times a member out:
 *
 *  - a score at or over the threshold deletes the message, times the author out for
 *    timeoutMinutes with the scam kind and score in the reason, and posts one card,
 *  - a score under it does nothing, and log mode only posts the card,
 *  - bots, webhooks, staff (Manage Messages or a staff role) and ignored channels, their
 *    categories and their threads are never scored,
 *  - SubQ errors and timeouts let the message through, and a run of them posts one notice,
 *  - a message is scored once per image and acted on once,
 *  - the request has the images in the top-level images field as plain base64,
 *  - after a hit the author's later image or link messages go without SubQ and edit the card,
 *  - the sweep deletes the author's messages of the last sweepMinutes in every readable,
 *    not ignored channel, fetches only where the cache is short, and the card counts them.
 *
 * SubQ, the image download and every Discord object are fakes passed in as deps, so nothing
 * here can reach SubQ or Discord.
 */

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { PermissionFlagsBits, SnowflakeUtil } = require('discord.js');
const filter = require('../schedulers/imageScamFilter');
const subq = require('../modules/subq');
const sessionLogger = require('../modules/sessionLogger');

const NOW = Date.UTC(2026, 10, 19, 13, 0, 0);
const MINUTE = 60000;
const CONFIG = filter.settings({
    active: true,
    mode: 'enforce',
    threshold: 0.3,
    timeoutMinutes: 1440,
    alertChannelId: 'alert-1',
    ignoreChannelIds: ['ignored-1', 'cat-ignored'],
    staffRoleIds: ['role-staff'],
    rememberMinutes: 30,
    sweepMinutes: 10
});

let PNG, GIF;
let clock, seq, logs, scores, calls, alert, guild, user;

before(async () => {
    PNG = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#cc0000' } }).png().toBuffer();
    GIF = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#00cc00' } }).gif().toBuffer();
});

beforeEach(() => {
    filter._reset();
    clock = NOW;
    seq = 0;
    logs = [];
    scores = [];
    calls = [];
    for (const level of ['info', 'warn', 'error', 'debug']) {
        sessionLogger[level] = (...args) => logs.push([level, ...args].join(' '));
    }
    alert = {
        sent: [],
        send: async payload => {
            const message = { payload, edits: [], edit: async next => { message.edits.push(next); } };
            alert.sent.push(message);
            return message;
        }
    };
    guild = { id: 'guild-1', members: { me: { id: 'bot-1' } }, channels: { cache: new Map() } };
    user = { id: 'user-1', tag: 'hacked#0001', bot: false, createdTimestamp: NOW - 400 * 86400000 };
});

/** One SubQ answer per call, in order. A number is a score, an Error is thrown. */
const fakeSubq = {
    decide: async body => {
        calls.push(body);
        const next = scores.length ? scores.shift() : 0.01;
        if (next instanceof Error) throw next;
        return {
            answers: {
                scam: { type: 'noul', noul: next },
                kind: { type: 'choice', choice: 'fake_payout', probabilities: { fake_payout: 0.9, none: 0.1 } }
            },
            usage: { input_tokens: 700, output_tokens: 0 }
        };
    }
};

function deps(extra = {}) {
    return Object.assign({
        subq: fakeSubq,
        fetchImage: async url => (url.endsWith('.gif') ? GIF : PNG),
        alertChannel: alert,
        now: () => clock
    }, extra);
}

function snowflake(at) {
    return SnowflakeUtil.generate({ timestamp: at }).toString();
}

function makeChannel(id, { parentId = null, parent = null, lastAt = NOW, cached = [], fetchable = [], readable = true } = {}) {
    const channel = {
        id,
        parentId,
        parent,
        lastMessageId: lastAt ? snowflake(lastAt) : null,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => readable }),
        bulkDeleted: [],
        bulkDelete: async ids => {
            channel.bulkDeleted.push(ids);
            return new Map(ids.map(messageId => [messageId, {}]));
        },
        messages: {
            cache: new Map(),
            fetches: [],
            deleted: [],
            fetch: async options => {
                channel.messages.fetches.push(options);
                return new Map(fetchable.map(message => [message.id, message]));
            },
            delete: async messageId => { channel.messages.deleted.push(messageId); }
        }
    };
    for (const message of cached) channel.messages.cache.set(message.id, message);
    guild.channels.cache.set(id, channel);
    return channel;
}

function attachment(name = 'scam.png', contentType = 'image/png') {
    const id = 'att-' + (++seq);
    return { id, name, contentType, size: 2000, url: 'https://cdn.discordapp.com/attachments/1/' + id + '/' + name };
}

function makeMember({ staff = false, roles = [] } = {}) {
    const member = {
        joinedTimestamp: NOW - 2 * 86400000,
        timeouts: [],
        permissions: { has: permission => staff && permission === PermissionFlagsBits.ManageMessages },
        roles: { cache: new Map(roles.map(role => [role, {}])) },
        isCommunicationDisabled: () => false,
        timeout: async (ms, reason) => { member.timeouts.push({ ms, reason }); }
    };
    return member;
}

function makeMessage(channel, { author = user, member = makeMember(), content = '', attachments = [attachment()], embeds = [], at = NOW } = {}) {
    const id = snowflake(at - (++seq));
    const message = {
        id,
        guildId: guild.id,
        guild,
        channelId: channel.id,
        channel,
        author,
        member,
        content,
        attachments: new Map(attachments.map(item => [item.id, item])),
        embeds,
        webhookId: null,
        system: false,
        partial: false,
        createdTimestamp: at,
        url: 'https://discord.com/channels/' + guild.id + '/' + channel.id + '/' + id,
        inGuild: () => true,
        deleted: false,
        delete: async () => { message.deleted = true; }
    };
    return message;
}

function field(payload, name) {
    const found = payload.embeds[0].toJSON().fields.find(item => item.name === name);
    return found ? found.value : undefined;
}

function lastCard() {
    const card = alert.sent[0];
    return card.edits.length ? card.edits[card.edits.length - 1] : card.payload;
}

test('a hit deletes the message, times the author out and posts one card', async () => {
    const channel = makeChannel('chan-1', { cached: [] });
    const member = makeMember();
    const message = makeMessage(channel, { member, content: 'look @everyone' });
    scores.push(0.97);

    const result = await filter.onMessage(message, CONFIG, deps());

    assert.strictEqual(result.acted, true);
    assert.strictEqual(message.deleted, true);
    assert.deepStrictEqual(member.timeouts.map(item => item.ms), [1440 * MINUTE]);
    assert.match(member.timeouts[0].reason, /Fake payout or wallet screenshot/);
    assert.match(member.timeouts[0].reason, /0\.97/);
    assert.strictEqual(alert.sent.length, 1);
    const card = alert.sent[0].payload;
    assert.deepStrictEqual(card.allowedMentions, { parse: [] });
    assert.match(card.embeds[0].toJSON().title, /Fake payout or wallet screenshot/);
    assert.match(field(card, 'User'), /<@user-1> .user-1./);
    assert.match(field(card, 'Account created'), /<t:\d+:R>/);
    assert.match(field(card, 'Joined the server'), /<t:\d+:R>/);
    assert.strictEqual(field(card, 'Channel'), '<#chan-1>');
    assert.match(field(card, 'Score'), /^0\.970 \(threshold 0\.3\)/);
    assert.match(field(card, 'Images'), /scam\.png/);
    assert.match(field(card, 'Action'), /Message deleted\nTimed out for 1 day/);
    assert.strictEqual(card.files.length, 1);
    assert.match(card.embeds[0].toJSON().description, /look @everyone/);
});

test('a score under the threshold does nothing', async () => {
    const channel = makeChannel('chan-1');
    const member = makeMember();
    const message = makeMessage(channel, { member });
    scores.push(0.29);

    const result = await filter.onMessage(message, CONFIG, deps());

    assert.strictEqual(result.score, 0.29);
    assert.strictEqual(message.deleted, false);
    assert.strictEqual(member.timeouts.length, 0);
    assert.strictEqual(alert.sent.length, 0);
});

test('staff are skipped: Manage Messages or a staff role', async () => {
    const channel = makeChannel('chan-1');
    scores.push(0.99, 0.99);
    const byPermission = await filter.onMessage(makeMessage(channel, { member: makeMember({ staff: true }) }), CONFIG, deps());
    const byRole = await filter.onMessage(makeMessage(channel, { member: makeMember({ roles: ['role-staff'] }) }), CONFIG, deps());

    assert.strictEqual(byPermission.skipped, 'staff');
    assert.strictEqual(byRole.skipped, 'staff');
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(alert.sent.length, 0);
});

test('bots and webhooks are skipped', async () => {
    const channel = makeChannel('chan-1');
    const fromBot = makeMessage(channel, { author: Object.assign({}, user, { bot: true }) });
    const fromWebhook = makeMessage(channel);
    fromWebhook.webhookId = 'hook-1';
    scores.push(0.99, 0.99);

    assert.strictEqual((await filter.onMessage(fromBot, CONFIG, deps())).skipped, 'bot');
    assert.strictEqual((await filter.onMessage(fromWebhook, CONFIG, deps())).skipped, 'bot');
    assert.strictEqual(calls.length, 0);
});

test('ignored channels, their categories and their threads are skipped', async () => {
    const ignored = makeChannel('ignored-1');
    const inCategory = makeChannel('chan-2', { parentId: 'cat-ignored' });
    const thread = makeChannel('thread-1', { parentId: 'chan-2', parent: inCategory });
    scores.push(0.99, 0.99, 0.99);

    for (const channel of [ignored, inCategory, thread]) {
        assert.strictEqual((await filter.onMessage(makeMessage(channel), CONFIG, deps())).skipped, 'ignored-channel');
    }
    assert.strictEqual(calls.length, 0);
});

test('a SubQ 5xx lets the message through, and a run of failures posts one notice', async () => {
    const http = { post: async () => ({ status: 503, data: { detail: { error_type: 'unavailable', message: 'try later' } } }) };
    const client = subq.createClient({ apiKey: 'test-key-123', http });
    const channel = makeChannel('chan-1');
    const messages = [1, 2, 3, 4, 5].map(() => makeMessage(channel));

    for (const message of messages) {
        const result = await filter.onMessage(message, CONFIG, deps({ subq: client }));
        assert.match(result.failed, /SubQ answered 503: try later/);
        assert.strictEqual(message.deleted, false);
    }
    assert.strictEqual(alert.sent.length, 1);
    assert.match(alert.sent[0].payload.content, /SubQ failed 3 times in a row/);
    assert.ok(!logs.join('\n').includes('test-key-123'));
    assert.ok(!alert.sent[0].payload.content.includes('test-key-123'));

    clock += 61 * MINUTE;
    await filter.onMessage(makeMessage(channel), CONFIG, deps({ subq: client }));
    assert.strictEqual(alert.sent.length, 2);
});

test('a SubQ timeout lets the message through and the error has no key in it', async () => {
    const http = {
        post: async () => {
            const error = new Error('timeout of 15000ms exceeded');
            error.code = 'ECONNABORTED';
            error.config = { headers: { Authorization: 'Bearer test-key-123' } };
            throw error;
        }
    };
    const client = subq.createClient({ apiKey: 'test-key-123', timeoutMs: 15000, http });
    const message = makeMessage(makeChannel('chan-1'));

    const result = await filter.onMessage(message, CONFIG, deps({ subq: client }));

    assert.match(result.failed, /timed out after 15000 ms/);
    assert.strictEqual(message.deleted, false);
    assert.ok(!logs.join('\n').includes('test-key-123'));
});

test('the SubQ client posts the body to systemone with the bearer key and returns the answer', async () => {
    const seen = [];
    const http = { post: async (url, body, options) => { seen.push({ url, body, options }); return { status: 200, data: { answers: {} } }; } };
    const client = subq.createClient({ apiKey: 'test-key-123', timeoutMs: 9000, http });

    assert.deepStrictEqual(await client.decide({ model: 'x' }), { answers: {} });
    assert.strictEqual(seen[0].url, 'https://api.subq.ai/v1/systemone');
    assert.deepStrictEqual(seen[0].body, { model: 'x' });
    assert.strictEqual(seen[0].options.headers.Authorization, 'Bearer test-key-123');
    assert.strictEqual(seen[0].options.headers['Content-Type'], 'application/json');
    assert.strictEqual(seen[0].options.timeout, 9000);
});

test('a message is scored once per image and acted on once', async () => {
    const channel = makeChannel('chan-1');
    const clean = makeMessage(channel);
    scores.push(0.01);
    await filter.onMessage(clean, CONFIG, deps());
    assert.strictEqual((await filter.onMessage(clean, CONFIG, deps())).skipped, 'no-new-images');
    assert.strictEqual(calls.length, 1);

    const member = makeMember();
    const scam = makeMessage(channel, { member });
    scores.push(0.95, 0.95);
    await filter.onMessage(scam, CONFIG, deps());
    assert.strictEqual((await filter.onMessage(scam, CONFIG, deps())).skipped, 'acted');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(member.timeouts.length, 1);
    assert.strictEqual(alert.sent.length, 1);
});

test('an embed image that arrives in an update is scored, the attachment is not scored again', async () => {
    const channel = makeChannel('chan-1');
    const message = makeMessage(channel);
    scores.push(0.01, 0.01);
    await filter.onMessage(message, CONFIG, deps());
    message.embeds = [{ data: { type: 'image' }, url: 'https://scam.example/a.png', thumbnail: { proxyURL: 'https://images-ext-1.discordapp.net/external/x/a.png' } }];
    await filter.onMessage(message, CONFIG, deps());

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].images.length, 1);
});

test('the request has the images in the images field as plain base64, four per request', async () => {
    const channel = makeChannel('chan-1');
    const message = makeMessage(channel, { attachments: [1, 2, 3, 4, 5, 6].map(n => attachment('shot' + n + '.png')) });
    scores.push(0.1, 0.1);

    await filter.onMessage(message, CONFIG, deps());

    assert.deepStrictEqual(calls.map(body => body.images.length), [4, 2]);
    for (const body of calls) {
        assert.deepStrictEqual(Object.keys(body).sort(), ['images', 'model', 'questions', 'state']);
        assert.strictEqual(body.model, 'subq-snap-1.2');
        assert.strictEqual(typeof body.state, 'string');
        assert.ok(!JSON.stringify(body.state).includes('image_url'));
        assert.strictEqual(body.questions.scam.type, 'noul');
        assert.strictEqual(body.questions.kind.type, 'choice');
        for (const image of body.images) {
            assert.deepStrictEqual(Object.keys(image).sort(), ['base64', 'mediaType']);
            assert.strictEqual(image.mediaType, 'image/png');
            assert.ok(!image.base64.startsWith('data:'));
            assert.match(image.base64, /^[A-Za-z0-9+/]+={0,2}$/);
            assert.ok(Buffer.from(image.base64, 'base64').equals(PNG));
        }
    }
});

test('a GIF goes as a JPEG of its first frame', async () => {
    const message = makeMessage(makeChannel('chan-1'), { attachments: [attachment('spin.gif', 'image/gif')] });
    scores.push(0.01);

    await filter.onMessage(message, CONFIG, deps());

    assert.strictEqual(calls[0].images[0].mediaType, 'image/jpeg');
    const meta = await sharp(Buffer.from(calls[0].images[0].base64, 'base64')).metadata();
    assert.deepStrictEqual([meta.format, meta.width, meta.height], ['jpeg', 40, 30]);
});

test('log mode posts the card and leaves the message and the member alone', async () => {
    const config = filter.settings(Object.assign({}, CONFIG, { mode: 'log' }));
    const channel = makeChannel('chan-1');
    const member = makeMember();
    const message = makeMessage(channel, { member });
    const earlier = makeMessage(channel, { at: NOW - 2 * MINUTE });
    channel.messages.cache.set(earlier.id, earlier);
    scores.push(0.9);

    await filter.onMessage(message, config, deps());

    assert.strictEqual(message.deleted, false);
    assert.strictEqual(member.timeouts.length, 0);
    assert.deepStrictEqual(channel.bulkDeleted, []);
    assert.deepStrictEqual(channel.messages.deleted, []);
    assert.strictEqual(alert.sent.length, 1);
    assert.match(field(alert.sent[0].payload, 'Action'), /Log mode: nothing deleted/);
    assert.match(field(lastCard(), 'Seen (log mode, not deleted)'), /^2 messages in 1 channel/);
});

test('a remembered author: later image or link messages go without SubQ and edit the card', async () => {
    const first = makeChannel('chan-1');
    const second = makeChannel('chan-2');
    scores.push(0.95);
    await filter.onMessage(makeMessage(first), CONFIG, deps());
    assert.strictEqual(calls.length, 1);

    const link = makeMessage(second, { attachments: [], content: 'claim it at https://scam.example/bonus' });
    const result = await filter.onMessage(link, CONFIG, deps());
    assert.strictEqual(result.burst, true);
    assert.strictEqual(link.deleted, true);

    const image = makeMessage(second);
    await filter.onMessage(image, CONFIG, deps());
    assert.strictEqual(image.deleted, true);

    const chat = makeMessage(second, { attachments: [], content: 'hello' });
    assert.strictEqual((await filter.onMessage(chat, CONFIG, deps())).skipped, 'no-images-or-links');
    assert.strictEqual(chat.deleted, false);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(alert.sent.length, 1);
    assert.match(field(lastCard(), 'Deleted'), /^3 messages in 2 channels/);

    clock += 31 * MINUTE;
    scores.push(0.01);
    await filter.onMessage(makeMessage(second), CONFIG, deps());
    assert.strictEqual(calls.length, 2);
});

test('the sweep deletes the burst in every readable channel, fetches only where the cache is short, and the card counts it', async () => {
    const other = { id: 'user-2', bot: false };
    const hitChannel = makeChannel('chan-1');
    const hit = makeMessage(hitChannel);
    hitChannel.messages.cache.set(hit.id, hit);
    const old = makeMessage(hitChannel, { at: NOW - 20 * MINUTE });
    hitChannel.messages.cache.set(old.id, old);
    const someoneElse = makeMessage(hitChannel, { author: other, at: NOW - MINUTE });
    hitChannel.messages.cache.set(someoneElse.id, someoneElse);

    const cachedBurst = [makeMessage(hitChannel, { at: NOW - MINUTE }), makeMessage(hitChannel, { at: NOW - 2 * MINUTE })];
    const oldInTwo = makeMessage(hitChannel, { at: NOW - 30 * MINUTE });
    const two = makeChannel('chan-2', { cached: cachedBurst.concat([oldInTwo]) });

    const fetchedBurst = makeMessage(hitChannel, { at: NOW - 3 * MINUTE });
    const three = makeChannel('chan-3', { fetchable: [fetchedBurst, makeMessage(hitChannel, { author: other, at: NOW - MINUTE })] });
    const quiet = makeChannel('chan-4', { lastAt: NOW - 60 * MINUTE });
    const ignored = makeChannel('ignored-1', { cached: [makeMessage(hitChannel, { at: NOW - MINUTE })] });
    const unreadable = makeChannel('chan-5', { readable: false, cached: [makeMessage(hitChannel, { at: NOW - MINUTE })] });
    scores.push(0.9);

    const result = await filter.onMessage(hit, CONFIG, deps());

    assert.strictEqual(result.acted, true);
    assert.deepStrictEqual(hitChannel.messages.fetches, []);
    assert.deepStrictEqual(hitChannel.bulkDeleted, []);
    assert.deepStrictEqual(hitChannel.messages.deleted, []);
    assert.deepStrictEqual(two.bulkDeleted, [cachedBurst.map(message => message.id)]);
    assert.deepStrictEqual(two.messages.fetches, []);
    assert.deepStrictEqual(three.messages.fetches, [{ limit: 100 }]);
    assert.deepStrictEqual(three.messages.deleted, [fetchedBurst.id]);
    assert.deepStrictEqual(quiet.messages.fetches, []);
    assert.deepStrictEqual([ignored.bulkDeleted, ignored.messages.deleted], [[], []]);
    assert.deepStrictEqual([unreadable.bulkDeleted, unreadable.messages.deleted], [[], []]);
    assert.strictEqual(result.incident.sweep.state, 'done');

    const deleted = field(lastCard(), 'Deleted');
    assert.match(deleted, /^4 messages in 3 channels/);
    assert.match(deleted, /Sweep of the last 10 min: 3 channels checked/);
});

test('a burst message scored at the same time as the hit joins the burst', async () => {
    const one = makeChannel('chan-1');
    const two = makeChannel('chan-2');
    const member = makeMember();
    const first = makeMessage(one, { member });
    const second = makeMessage(two, { member });
    scores.push(0.9, 0.9);

    await Promise.all([filter.onMessage(first, CONFIG, deps()), filter.onMessage(second, CONFIG, deps())]);

    assert.strictEqual(first.deleted && second.deleted, true);
    assert.strictEqual(member.timeouts.length, 1);
    assert.strictEqual(alert.sent.length, 1);
    assert.match(field(lastCard(), 'Deleted'), /^2 messages in 2 channels/);
});

test('start stays off with one warn line when SUBQ_API_KEY is missing', async () => {
    const saved = process.env.SUBQ_API_KEY;
    delete process.env.SUBQ_API_KEY;
    const getClient = filter.getClient;
    filter.getClient = async () => { throw new Error('must not reach Discord'); };
    try {
        await filter.start(CONFIG);
    } finally {
        filter.getClient = getClient;
        if (saved !== undefined) process.env.SUBQ_API_KEY = saved;
    }
    assert.deepStrictEqual(logs.filter(line => line.startsWith('warn')).length, 1);
    assert.match(logs.join('\n'), /SUBQ_API_KEY is not set/);
});
