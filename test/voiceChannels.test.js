/*
 * Unit tests for the self-sizing voice category.
 * Run: npm test   (node --test test/)
 *
 * The policy is pure (`planVoice`) so it is tested on values: how many rooms to
 * make, which ones to drop, and the two rooms it must NEVER touch — one with
 * somebody in it, and one a human named by hand. `reconcile` is then driven
 * against a fake guild that records every create and delete, because the bug
 * that would hurt is a bot that deletes the room people are sitting in.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { ChannelType } = require('discord.js');
const voice = require('../schedulers/voiceChannels');

const NOW = Date.parse('2026-09-11T12:00:00Z');
const MINUTE = 60 * 1000;
const CONFIG = {
    guildId: 'g1', categoryId: 'cat-1', namePrefix: 'Voice',
    minFree: 1, maxChannels: 10, idleMinutes: 5
};

const room = (id, name, memberCount = 0, emptySince = null) => ({ id, name, memberCount, emptySince });

beforeEach(() => {
    voice._emptySince.clear();
});

// ---------------------------------------------------------------------------
// planVoice
// ---------------------------------------------------------------------------

test('voiceChannels: no empty room means one more room', () => {
    const plan = voice.planVoice({
        channels: [room('a', 'Voice 1', 3)],
        config: CONFIG,
        now: NOW
    });
    assert.deepStrictEqual(plan, { create: 1, remove: [] });
});

test('voiceChannels: an empty category is filled up to minFree', () => {
    assert.deepStrictEqual(
        voice.planVoice({ channels: [], config: { ...CONFIG, minFree: 2 }, now: NOW }),
        { create: 2, remove: [] }
    );
});

test('voiceChannels: one free room is the target, so nothing happens', () => {
    const plan = voice.planVoice({
        channels: [room('a', 'Voice 1', 3), room('b', 'Voice 2', 0, NOW - 60 * MINUTE)],
        config: CONFIG,
        now: NOW
    });
    assert.deepStrictEqual(plan, { create: 0, remove: [] }, 'the last free room is never taken away');
});

test('voiceChannels: the idle rooms above minFree go, oldest first', () => {
    const plan = voice.planVoice({
        channels: [
            room('a', 'Voice 1', 0, NOW - 20 * MINUTE),
            room('b', 'Voice 2', 0, NOW - 30 * MINUTE),
            room('c', 'Voice 3', 0, NOW - 10 * MINUTE)
        ],
        config: CONFIG,
        now: NOW
    });
    assert.strictEqual(plan.create, 0);
    assert.deepStrictEqual(plan.remove, ['b', 'a'], 'three empty, one kept: the two oldest go');
});

test('voiceChannels: a room that only just emptied is left alone', () => {
    const plan = voice.planVoice({
        channels: [
            room('a', 'Voice 1', 0, NOW - 1 * MINUTE),
            room('b', 'Voice 2', 0, NOW - 2 * MINUTE)
        ],
        config: CONFIG,
        now: NOW
    });
    assert.deepStrictEqual(plan, { create: 0, remove: [] }, 'five minutes means five minutes');
});

test('voiceChannels: a room with somebody in it is never removed', () => {
    const plan = voice.planVoice({
        channels: [
            room('a', 'Voice 1', 4, NOW - 60 * MINUTE),
            room('b', 'Voice 2', 0, NOW - 60 * MINUTE),
            room('c', 'Voice 3', 0, NOW - 60 * MINUTE)
        ],
        config: CONFIG,
        now: NOW
    });
    assert.deepStrictEqual(plan.remove, ['b'], 'only one of the two empty ones, and never the busy one');
    assert.ok(!plan.remove.includes('a'));
});

test('voiceChannels: maxChannels is a hard ceiling', () => {
    const channels = Array.from({ length: 3 }, (_, i) => room(`x${i}`, `Voice ${i + 1}`, 2));
    assert.deepStrictEqual(
        voice.planVoice({ channels, config: { ...CONFIG, maxChannels: 3 }, now: NOW }),
        { create: 0, remove: [] },
        'three busy rooms at a ceiling of three: no fourth, however much minFree wants one'
    );
    assert.strictEqual(
        voice.planVoice({ channels, config: { ...CONFIG, maxChannels: 4, minFree: 2 }, now: NOW }).create,
        1,
        'and the ceiling caps the creation, it does not cancel it'
    );
});

test('voiceChannels: a hand-named room is invisible to the plan', () => {
    const plan = voice.planVoice({
        channels: [room('a', 'Staff lounge', 0, NOW - 60 * MINUTE)],
        config: CONFIG,
        now: NOW
    });
    assert.deepStrictEqual(plan, { create: 1, remove: [] },
        'it counts for nothing and it is never deleted');
});

// ---------------------------------------------------------------------------
// reconcile, against a fake guild
// ---------------------------------------------------------------------------

/** A guild with just the surface the scheduler touches. */
function guild(channels) {
    const created = [];
    const deleted = [];
    const cache = new Map();
    for (const channel of channels) {
        cache.set(channel.id, {
            type: ChannelType.GuildVoice,
            parentId: 'cat-1',
            members: { size: 0 },
            delete: async (reason) => { deleted.push({ id: channel.id, reason }); cache.delete(channel.id); },
            ...channel
        });
    }
    return {
        created,
        deleted,
        channels: {
            cache,
            create: async (payload) => { created.push(payload); return { id: `new-${created.length}` }; }
        }
    };
}

test('voiceChannels: reconcile creates the missing room with the lowest free number', async () => {
    const g = guild([
        { id: 'a', name: 'Voice 1', members: { size: 2 } },
        { id: 'c', name: 'Voice 3', members: { size: 1 } }
    ]);
    const result = await voice.reconcile(CONFIG, { guild: g });

    assert.deepStrictEqual(result, { created: 1, removed: 0 });
    assert.strictEqual(g.created.length, 1);
    assert.strictEqual(g.created[0].name, 'Voice 2', 'the gap is filled before the list grows');
    assert.strictEqual(g.created[0].type, ChannelType.GuildVoice);
    assert.strictEqual(g.created[0].parent, 'cat-1');
});

test('voiceChannels: a room is only removed after it has been seen empty long enough', async () => {
    const g = guild([
        { id: 'a', name: 'Voice 1' },
        { id: 'b', name: 'Voice 2' }
    ]);
    // First pass: both are seen empty for the first time, so the timer starts now.
    const first = await voice.reconcile(CONFIG, { guild: g });
    assert.deepStrictEqual(first, { created: 0, removed: 0 }, 'nothing is deleted on the pass that found it');

    // Age the timer past the idle window and run again.
    for (const [id, at] of voice._emptySince) voice._emptySince.set(id, at - 6 * MINUTE);
    const second = await voice.reconcile(CONFIG, { guild: g });
    assert.strictEqual(second.removed, 1, 'one goes, one stays free');
    assert.deepStrictEqual(g.deleted.map(d => d.id), ['a']);
    assert.strictEqual(voice._emptySince.has('a'), false, 'and its timer goes with it');
});

test('voiceChannels: somebody joining a room clears its timer', async () => {
    const g = guild([
        { id: 'a', name: 'Voice 1' },
        { id: 'b', name: 'Voice 2' }
    ]);
    await voice.reconcile(CONFIG, { guild: g });
    assert.strictEqual(voice._emptySince.size, 2);

    g.channels.cache.get('a').members = { size: 1 };
    await voice.reconcile(CONFIG, { guild: g });
    assert.strictEqual(voice._emptySince.has('a'), false, 'a busy room has no empty timer');

    for (const [id, at] of voice._emptySince) voice._emptySince.set(id, at - 6 * MINUTE);
    await voice.reconcile(CONFIG, { guild: g });
    assert.deepStrictEqual(g.deleted, [], 'one busy and one free is exactly the target');
});

test('voiceChannels: channels outside the category and outside the prefix are untouched', async () => {
    const g = guild([
        { id: 'a', name: 'Voice 1' },
        { id: 'b', name: 'Voice 2', parentId: 'other-cat' },
        { id: 'c', name: 'Staff lounge' },
        { id: 'd', name: 'Voice text', type: ChannelType.GuildText }
    ]);
    for (let pass = 0; pass < 2; pass++) {
        await voice.reconcile(CONFIG, { guild: g });
        for (const [id, at] of voice._emptySince) voice._emptySince.set(id, at - 6 * MINUTE);
    }
    assert.deepStrictEqual(g.deleted, [], 'only our own voice rooms are ours to delete');
    assert.deepStrictEqual(g.created, [], 'and Voice 1 already covers minFree');
});

test('voiceChannels: no guild and no category both stop the pass quietly', async () => {
    const real = voice.getGuild;
    try {
        voice.getGuild = async () => null;
        assert.deepStrictEqual(await voice.reconcile(CONFIG, {}), { skipped: 'no-guild' });
    } finally {
        voice.getGuild = real;
    }
    // An unconfigured scheduler never reaches the bot at all.
    await voice.start({ ...CONFIG, guildId: '' });
    await voice.start({ ...CONFIG, categoryId: '' });
});

test('voiceChannels: a create that throws does not stop the deletes', async () => {
    const g = guild([
        { id: 'a', name: 'Voice 1' },
        { id: 'b', name: 'Voice 2' },
        { id: 'c', name: 'Voice 3' }
    ]);
    g.channels.create = async () => { throw new Error('missing permissions'); };
    await voice.reconcile(CONFIG, { guild: g });
    for (const [id, at] of voice._emptySince) voice._emptySince.set(id, at - 6 * MINUTE);
    const result = await voice.reconcile(CONFIG, { guild: g });
    assert.strictEqual(result.removed, 2);
    assert.deepStrictEqual(g.deleted.map(d => d.id), ['a', 'b']);
});

test('voiceChannels: "Voice Lounge" starts with the prefix and is still not ours', () => {
    // Only `<prefix> <number>` is a room this bot made. A hand-named lounge
    // above minFree used to be counted as a spare and deleted once idle.
    const plan = voice.planVoice({
        channels: [room('a', 'Voice 1', 0, NOW - 60 * MINUTE), room('b', 'Voice Lounge', 0, NOW - 60 * MINUTE)],
        config: CONFIG,
        now: NOW
    });
    assert.deepStrictEqual(plan, { create: 0, remove: [] }, 'the lounge is not a spare');
});

test('voiceChannels: reconcile never deletes a hand-named room, whatever it starts with', async () => {
    const g = guild([
        { id: 'a', name: 'Voice 1' },
        { id: 'b', name: 'Voice Lounge' }
    ]);
    voice._emptySince.set('a', NOW - 60 * MINUTE);
    voice._emptySince.set('b', NOW - 60 * MINUTE);
    await voice.reconcile(CONFIG, { guild: g });
    assert.deepStrictEqual(g.deleted, []);
});

test('voiceChannels: members are counted from the guild\'s voice states, not the member cache', async () => {
    // Without the GuildMembers intent `channel.members` only holds voice states
    // whose member is cached, so after a restart an occupied room reads 0
    // there. The gateway's voice states are the truth.
    const g = guild([
        { id: 'a', name: 'Voice 1', members: { size: 0 } },
        { id: 'b', name: 'Voice 2', members: { size: 0 } }
    ]);
    g.voiceStates = { cache: new Map([['u1', { channelId: 'a' }], ['u2', { channelId: 'a' }]]) };
    voice._emptySince.set('a', NOW - 60 * MINUTE);
    voice._emptySince.set('b', NOW - 60 * MINUTE);
    const result = await voice.reconcile(CONFIG, { guild: g });
    assert.deepStrictEqual(g.deleted, [], 'a is occupied, b is the one free room');
    assert.strictEqual(result.created, 0);
    assert.strictEqual(voice._emptySince.has('a'), false, 'the occupied room lost its timer');
});
