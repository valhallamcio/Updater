/*
 * Unit tests for modules/hauntedWrapped.js: the window, the nights count and the embed.
 * Run: npm test   (node --test test/)
 *
 * The doc shape is the proxy's herobrine_players doc (src/plugins/herobrine/rules.ts).
 * A night is herobrine's reward day: the UTC date 12 hours back.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const hw = require('../modules/hauntedWrapped');

const at = iso => Date.parse(iso);

const SAMPLE = {
    _id: '0b4e3c51-9b1f-4a43-9a8e-6f0b3c2e1d77',
    name: 'Alp',
    rung: 2,
    encounters: 4,
    seen: 3,
    catches: 1,
    lastAt: new Date('2026-10-31T21:00:00Z'),
    lastCatchDay: '2026-10-31',
    history: [
        { at: new Date('2026-10-25T20:10:00Z'), serverId: '076d8208', step: 'glimpse', outcome: 'unseen', reason: 'gone' },
        { at: new Date('2026-10-26T02:05:00Z'), serverId: '076d8208', step: 'glimpse', outcome: 'seen', reason: 'looked' },
        { at: new Date('2026-10-28T20:00:00Z'), serverId: 'aaaa1111', step: 'stalk', outcome: 'no_spawn', reason: 'no_spot' },
        { at: new Date('2026-10-29T20:00:00Z'), serverId: 'sup00001', step: 'stalk', outcome: 'seen', reason: 'looked' },
        { at: new Date('2026-10-31T21:00:00Z'), serverId: 'gone0000', step: 'signs', outcome: 'seen', reason: 'caught' }
    ]
};

const SERVERS = [
    { serverId: '076d8208', tag: 'pri', name: 'Prominence II' },
    { serverId: 'sup00001', tag: 'arc', name: 'Arcadia Early Access', earlyAccess: true },
    { serverId: 'arc00001', tag: 'arc', name: 'Arcadia' }
];

test('the window opens on Nov 1 and closes after Nov 8, UTC', () => {
    assert.strictEqual(hw.windowState(at('2026-10-31T23:59:59Z')), 'before');
    assert.strictEqual(hw.windowState(at('2026-11-01T00:00:00Z')), 'open');
    assert.strictEqual(hw.windowState(at('2026-11-08T23:59:59Z')), 'open');
    assert.strictEqual(hw.windowState(at('2026-11-09T00:00:00Z')), 'after');
});

test('a reward day starts at 12:00 UTC, the same key as herobrine', () => {
    assert.strictEqual(hw.rewardDayKey(at('2026-10-26T11:59:59Z')), '2026-10-25');
    assert.strictEqual(hw.rewardDayKey(at('2026-10-26T12:00:00Z')), '2026-10-26');
});

test('one evening and the night after it count as one night', () => {
    const doc = hw.normalizeLadder(SAMPLE);
    // 10-25 20:10 and 10-26 02:05 share the reward day 2026-10-25; the 10-28 no_spot night is no night
    assert.strictEqual(hw.countNights(doc.history), 3);
    assert.strictEqual(hw.countNights([{ at: 0 }, { at: 0 }]), 0, 'a row with no time is no night');
});

test('normalizeLadder takes the defaults for missing or bad fields', () => {
    assert.strictEqual(hw.normalizeLadder(null), null);
    const doc = hw.normalizeLadder({ rung: -3, seen: 'x', lastAt: 1700000000000, history: [null, { outcome: 'odd', at: 5 }] });
    assert.deepStrictEqual(doc, {
        name: '', rung: 0, encounters: 0, seen: 0, catches: 0, lastAt: 1700000000000,
        history: [{ at: 5, serverId: '', step: '', outcome: 'unseen', reason: '' }]
    });
    const long = hw.normalizeLadder({ history: Array.from({ length: 40 }, (_, i) => ({ at: i + 1, outcome: 'seen' })) });
    assert.strictEqual(long.history.length, hw.HISTORY_KEPT);
    assert.strictEqual(long.history[0].at, 11, 'the oldest rows go first');
});

test('the step reached is the rung, or a higher step he played', () => {
    const doc = hw.normalizeLadder(SAMPLE);
    assert.strictEqual(hw.stepReached(doc), 2);
    assert.strictEqual(hw.stepReached(hw.normalizeLadder({ rung: 99 })), hw.STEPS.length - 1);
    assert.strictEqual(hw.stepReached(hw.normalizeLadder({ rung: 0, history: [{ step: 'base', outcome: 'seen' }] })), 3);
    assert.strictEqual(hw.stepReached(hw.normalizeLadder({ rung: 0, history: [{ step: 'chase', outcome: 'no_spawn' }] })), 0);
});

test('only a spawn counts as a sighting', () => {
    assert.strictEqual(hw.hasSightings(null), false);
    assert.strictEqual(hw.hasSightings(hw.normalizeLadder({})), false);
    assert.strictEqual(hw.hasSightings(hw.normalizeLadder({ history: [{ outcome: 'no_spawn', at: 1 }] })), false);
    assert.strictEqual(hw.hasSightings(hw.normalizeLadder({ encounters: 1 })), true);
});

test('an early-access instance shows the public name of its pack', () => {
    const names = hw.serverNameMap(SERVERS);
    assert.strictEqual(names.get('076d8208'), 'Prominence II');
    assert.strictEqual(names.get('sup00001'), 'Arcadia');
    assert.strictEqual(names.get('gone0000'), undefined);
});

test('the embed carries the counts, the step and the newest sightings', () => {
    const doc = hw.normalizeLadder(SAMPLE);
    const json = hw.buildHauntedEmbed(doc, { username: 'Alp', serverNames: hw.serverNameMap(SERVERS) }).toJSON();

    assert.strictEqual(json.title, 'Haunted Wrapped: Alp');
    assert.strictEqual(json.description, '*i saw you too.*');
    const field = name => json.fields.find(f => f.name === name).value;
    assert.strictEqual(field('Nights'), '3');
    assert.strictEqual(field('Encounters'), '4');
    assert.strictEqual(field('You saw him'), '3');
    assert.strictEqual(field('He caught you'), '1');
    assert.strictEqual(field('Steps reached'), '3 of 5: the signs');

    const log = field('Last sightings').split('\n');
    assert.strictEqual(log.length, 4, 'a no_spawn row is no sighting');
    assert.strictEqual(log[0], `<t:${at('2026-10-31T21:00:00Z') / 1000}:d> the signs, you saw him`);
    assert.strictEqual(log[1], `<t:${at('2026-10-29T20:00:00Z') / 1000}:d> the stalk, you saw him on Arcadia`);
    assert.match(log[3], /a glimpse, he stayed hidden on Prominence II$/);
    assert.strictEqual(json.thumbnail.url, 'https://mc-heads.net/avatar/Alp/128');
});

test('a player who never saw him gets the other line', () => {
    const doc = hw.normalizeLadder({ name: 'Some_One', encounters: 1, history: [{ at: 1, step: 'glimpse', outcome: 'unseen' }] });
    const json = hw.buildHauntedEmbed(doc).toJSON();
    assert.strictEqual(json.title, 'Haunted Wrapped: Some\\_One');
    assert.strictEqual(json.description, '*you never saw me. i saw you.*');
});
