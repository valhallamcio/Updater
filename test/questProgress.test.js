/*
 * Unit tests for modules/questProgress.js, the pure half of the quest event reader.
 * Run: npm test   (node --test test/)
 *
 * The contract, because the proxy shows these numbers and rewards hang off them:
 *
 *  - the BQ 1.12.2 file is read in both NBT-JSON forms (compound and array), and the
 *    quest id comes from `questID:3`, never from the entry key,
 *  - a completion counts only inside `startAt <= at < endAt`, for a uuid not excluded,
 *  - finishers have no window and no exclusion, and keep their earliest time,
 *  - a week closes after its end plus the delay, and the last week ends at `endAt`,
 *  - the target list repeats its last value,
 *  - founders come in the order they reached `minQuests`, with the first completion
 *    inside the window, never twice.
 *
 * The fixture is a few quests in the real file's shape. The 19 MB file never enters the repo.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const qp = require('../modules/questProgress');

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
const START = Date.UTC(2026, 9, 10);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

/** A quest entry in the compound form BQ writes. */
function questObj(questId, completions) {
    const completed = {};
    completions.forEach(([uuid, at], i) => { completed[`${i}:10`] = { 'claimed:1': 1, 'timestamp:4': at, 'uuid:8': uuid }; });
    return { 'completed:9': completed, 'tasks:9': {}, 'questID:3': questId };
}

function fixture() {
    return {
        'questProgress:9': {
            '0:10': questObj(5, [[A, START - 1], [B, START]]),
            '1:10': questObj(6, [[A, START + 1000], [B.toUpperCase(), START + WEEK]]),
            // the array form, with a uuid that shows up twice
            '2:10': { 'questID:3': 809, 'completed:9': [
                { 'uuid:8': C, 'timestamp:4': START + 2 * WEEK },
                { 'uuid:8': A, 'timestamp:4': START - 50 * DAY },
                { 'uuid:8': C, 'timestamp:4': START - 10 * DAY }
            ] },
            '3:10': { 'completed:9': {}, 'tasks:9': {} }
        }
    };
}

function event(extra = {}) {
    return {
        _id: 'ev',
        startAt: new Date(START),
        endAt: null,
        weekMs: WEEK,
        weekCount: 3,
        weeklyTargets: [2, 5],
        weeklyMinContribution: 1,
        excluded: [],
        founder: { windowMs: 14 * DAY, minQuests: 2 },
        ...extra
    };
}

test('parse: both forms, questID:3 as the id, a duplicate uuid kept once at its earliest', () => {
    const { quests, skipped } = qp.parseQuestProgress(JSON.stringify(fixture()));
    assert.strictEqual(skipped, 1, 'the entry with no questID:3 is skipped');
    assert.deepStrictEqual(quests.map(q => q.questId), [5, 6, 809]);
    const q809 = quests.find(q => q.questId === 809);
    assert.deepStrictEqual(q809.completions, [
        { uuid: C, at: START - 10 * DAY },
        { uuid: A, at: START - 50 * DAY }
    ]);
    assert.ok(quests[1].completions.some(c => c.uuid === B), 'uuids are lowercased');
});

test('parse: the top level may be an array too', () => {
    const { quests } = qp.parseQuestProgress({ 'questProgress:9': [questObj(1, [[A, 5]])] });
    assert.deepStrictEqual(quests, [{ questId: 1, completions: [{ uuid: A, at: 5 }] }]);
});

test('parse: a file without questProgress:9 is refused', () => {
    assert.throws(() => qp.parseQuestProgress({ 'questDatabase:9': {} }), /questProgress:9/);
});

test('schedule: no endAt uses weekCount, a set endAt decides the weeks', () => {
    assert.deepStrictEqual(qp.schedule(event()), { startAt: START, endAt: START + 3 * WEEK, weekMs: WEEK, weekCount: 3 });
    assert.strictEqual(qp.schedule(event({ weekCount: undefined })).weekCount, 8);
    const cut = qp.schedule(event({ endAt: new Date(START + 2 * WEEK + DAY) }));
    assert.strictEqual(cut.weekCount, 3, 'a partial last week is still a week');
    assert.strictEqual(qp.weekEnd(cut, 2), START + 2 * WEEK + DAY, 'the last week ends at endAt');
    assert.strictEqual(qp.schedule(event({ startAt: null })), null);
});

test('count: start inclusive, end exclusive, per uuid as recorded', () => {
    const { quests } = qp.parseQuestProgress(fixture());
    const counts = qp.countEvent(quests, event({ endAt: new Date(START + 2 * WEEK) }));
    // A: START-1 is before the start, START+1000 counts. B: START and START+WEEK count.
    // C: its quest 809 entry is kept at the earlier of its two times, before the start.
    assert.deepStrictEqual([...counts.players.keys()].sort(), [A, B]);
    assert.strictEqual(counts.players.get(A).total, 1);
    assert.deepStrictEqual(counts.players.get(B).weeks, { 0: 1, 1: 1 });
    assert.deepStrictEqual(counts.weekCounts, [2, 1]);
    assert.strictEqual(counts.quests, 3);
});

test('count: a completion at exactly endAt is out, one just before it is in', () => {
    const end = START + 2 * WEEK;
    const { quests } = qp.parseQuestProgress({ 'questProgress:9': [questObj(1, [[A, end]]), questObj(2, [[A, end - 1]])] });
    const counts = qp.countEvent(quests, event({ endAt: new Date(end) }));
    assert.strictEqual(counts.players.get(A).total, 1);
    assert.deepStrictEqual(counts.players.get(A).weeks, { 1: 1 });
});

test('count: an excluded uuid counts for nothing, whatever its case', () => {
    const { quests } = qp.parseQuestProgress(fixture());
    const counts = qp.countEvent(quests, event({ excluded: [B.toUpperCase()] }));
    assert.ok(!counts.players.has(B));
    assert.deepStrictEqual(counts.weekCounts, [1, 0, 0]);
});

test('count: founderAt is the time of the minQuests-th completion', () => {
    const { quests } = qp.parseQuestProgress(fixture());
    const counts = qp.countEvent(quests, event());
    assert.strictEqual(counts.players.get(B).founderAt, START + WEEK);
    assert.strictEqual(counts.players.get(A).founderAt, null, 'one completion is short of two');
    assert.strictEqual(counts.players.get(B).firstAt, START);
});

test('finishers: no window, no exclusion, earliest time first', () => {
    const { quests } = qp.parseQuestProgress(fixture());
    assert.deepStrictEqual(qp.finishers(quests, 809), [
        { uuid: A, at: START - 50 * DAY },
        { uuid: C, at: START - 10 * DAY }
    ]);
    assert.deepStrictEqual(qp.finishers(quests, 999), []);
});

test('targets: the last value repeats, no list gives null', () => {
    assert.deepStrictEqual([0, 1, 2, 7].map(i => qp.weekTarget([300, 400], i)), [300, 400, 400, 400]);
    assert.strictEqual(qp.weekTarget([], 0), null);
    assert.strictEqual(qp.weekTarget(undefined, 0), null);
});

test('weeks: a week closes after its end plus the delay, once', () => {
    const sched = qp.schedule(event());
    const delay = 15 * 60 * 1000;
    assert.deepStrictEqual(qp.closableWeeks(sched, [], START + WEEK + delay - 1, delay), []);
    assert.deepStrictEqual(qp.closableWeeks(sched, [], START + WEEK + delay, delay), [0]);
    assert.deepStrictEqual(qp.closableWeeks(sched, [{ index: 0 }], START + 3 * WEEK + delay, delay), [1, 2]);
    assert.strictEqual(qp.eventFinished(sched, [{ index: 0 }, { index: 1 }], START + 3 * WEEK), false);
    assert.strictEqual(qp.eventFinished(sched, [{ index: 0 }, { index: 1 }, { index: 2 }], START + 3 * WEEK), true);
});

test('totals: the current week moves with now and stays inside the event', () => {
    const sched = qp.schedule(event());
    const counts = { quests: 9, players: 2, weekCounts: [4, 3, 2] };
    assert.deepStrictEqual(qp.buildTotals(counts, sched, [2, 5], START + WEEK + 1),
        { quests: 9, players: 2, week: { index: 1, count: 3, target: 5 } });
    assert.strictEqual(qp.buildTotals(counts, sched, [2, 5], START + 10 * WEEK).week.index, 2);
    assert.strictEqual(qp.buildTotals(counts, sched, [2, 5], START - 1).week.index, 0);
});

test('founders: in the order they reached minQuests, window and exclusion applied', () => {
    const sched = qp.schedule(event());
    const docs = [
        { uuid: A, total: 30, firstAt: new Date(START + DAY), founderAt: new Date(START + 5 * DAY), founderNo: null },
        { uuid: B, total: 25, firstAt: new Date(START), founderAt: new Date(START + 3 * DAY), founderNo: null },
        { uuid: C, total: 40, firstAt: new Date(START + 15 * DAY), founderAt: new Date(START + 16 * DAY), founderNo: null },
        { uuid: 'd', total: 50, firstAt: new Date(START), founderAt: new Date(START + DAY), founderNo: 1 },
        { uuid: 'e', total: 50, firstAt: new Date(START), founderAt: new Date(START + DAY) },
        { uuid: 'f', total: 1, firstAt: new Date(START), founderAt: null, founderNo: null },
        { uuid: 'g', total: 30, firstAt: new Date(START), founderAt: new Date(START + 15 * DAY), founderNo: null }
    ];
    const order = qp.founderCandidates(docs, event({ excluded: ['E'] }), sched).map(d => d.uuid);
    // C started after the 14-day window, d has a number, e is excluded, f is short,
    // g started inside the window but reached minQuests after it.
    assert.deepStrictEqual(order, [B, A]);
});

test('weekly recipients: min contribution that week, exclusion applied', () => {
    const docs = [
        { uuid: A, weeks: { 0: 10, 1: 2 } },
        { uuid: B, weeks: { 0: 9 } },
        { uuid: C, weeks: { 0: 12 } }
    ];
    const got = qp.weeklyRecipients(docs, event({ weeklyMinContribution: 10, excluded: [C] }), 0).map(d => d.uuid);
    assert.deepStrictEqual(got, [A]);
    assert.deepStrictEqual(qp.weeklyRecipients(docs, event({ weeklyMinContribution: 0 }), 1).map(d => d.uuid), [A],
        'a player with nothing that week never gets the reward');
});

test('diff: only changed rows are written, and a uuid that stopped counting is cleared', () => {
    const players = new Map([
        [A, { uuid: A, total: 2, weeks: { 0: 2 }, firstAt: START, founderAt: START + 5 }],
        [B, { uuid: B, total: 1, weeks: { 0: 1 }, firstAt: START, founderAt: null }]
    ]);
    const existing = [
        { uuid: A, total: 2, weeks: { 0: 2 }, firstAt: new Date(START), founderAt: new Date(START + 5) },
        { uuid: B, total: 0, weeks: {}, firstAt: null, founderAt: null },
        { uuid: C, total: 4, weeks: { 0: 4 }, firstAt: new Date(START), founderAt: null },
        { uuid: 'gone', total: 0, weeks: {} }
    ];
    const { changed, cleared } = qp.diffProgress(existing, players);
    assert.deepStrictEqual(changed.map(r => r.uuid), [B]);
    assert.deepStrictEqual(cleared, [C]);
});
