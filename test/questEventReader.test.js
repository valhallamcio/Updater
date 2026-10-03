/*
 * Unit tests for schedulers/questEventReader.js, the Mongo and ops half of the quest events.
 * Run: npm test   (node --test test/)
 *
 * The contract, because the proxy shows what lands here and players get items off it:
 *
 *  - an unchanged file (mtime, size and count inputs) is not downloaded, and nothing is written,
 *  - a founder number comes from the `$inc` once per player, in the order players reached
 *    `minQuests`, and a lost race never gives one player two numbers,
 *  - a milestone number comes from `milestoneSeq.<key>` once per player per milestone, in
 *    the order players reached `quests`, with no window,
 *  - a finisher number comes from `finisherSeq` once per player, in completion order, and
 *    numbers up to `finisher.firstN` also mark `speedrunner`,
 *  - a lost race or a crash after the `$inc` wastes that number, and the next pass takes a new one,
 *  - a week closes once, and only a week that met its target marks rewards,
 *  - a reward goes out as ONE `give_item` op per key: by the event's Pterodactyl id,
 *    target by uuid and name, `offlineMode: 'queue'`, a 14-day expiry, and the key
 *    `qe:<eventId>:<reward key>:<uuid>`,
 *  - an event without `milestones` or `finisher` keeps its count key, reward keys and docs,
 *  - with the ops lever off nothing is sent, and the rewards wait as `pending`,
 *  - finishers are read on the legacy AND the event server, keep the earliest time,
 *    and ignore the window and the exclusion list,
 *  - `chapters` join the count key, a closed week keeps its top chapter, and the weekly
 *    trophy shows that chapter's icon and name. Without chapter data the spec stays as it is,
 *  - the close of the LAST week marks `veteran` once, for players with enough in every week.
 *
 * Every module is faked at its own surface, the way test/cakeDrop.test.js does it. The
 * Mongo fakes apply the real bulkWrite ops from modules/mongo.js to an in-memory store.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { NBTReader } = require('mc-nbt-lib/nbt-core');
const reader = require('../schedulers/questEventReader');
const questProgress = require('../modules/questProgress');
const mongo = require('../modules/mongo');
const yggdrasil = require('../modules/yggdrasil');
const { seedDoc } = require('../scripts/seed-quest-event-dj2r');

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
const START = Date.UTC(2026, 9, 10);
const OPTIONS = { interval: 5, finisherInterval: 60, weekCloseDelayMinutes: 15 };

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NAMES = { [A]: 'Alp', [B]: 'Bommerhond' };
const CAKE = { id: 'minecraft:cake' };

let ev;           // the quest_events doc, as Mongo holds it
let progress;     // quest_event_progress docs by _id
let packs;        // pack_completions docs by _id
let files;        // serverId -> {stat, text}
let downloads;    // serverIds downloaded, in order
let stats;        // serverIds listed, in order
let eventWrites;  // updateQuestEvent field sets
let progressWrites; // writeQuestEventProgress calls
let incs;         // nextFounderNo calls
let closes;       // closeQuestEventWeek calls
let created;      // createOp calls
let opsById;      // what getOp answers
let opsOn;        // the useOpsApi lever
let founderRace;  // when true, setQuestEventFounderNo loses the race
let milestoneIncs; // nextMilestoneNo keys, in order
let finisherIncs; // nextFinisherNo calls
let numberRace;   // when true, the milestone and finisher number writes lose the race

function setPath(obj, path, value) {
    const parts = path.split('.');
    let node = obj;
    for (const part of parts.slice(0, -1)) {
        if (!node[part] || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
    }
    node[parts[parts.length - 1]] = value;
}

/** Applies one bulkWrite updateOne the way Mongo would, for the filters modules/mongo.js builds. */
function apply(store, { filter, update, upsert }) {
    let doc = store[filter._id];
    if (filter.at && filter.at.$gt) {
        if (!doc || !(doc.at > filter.at.$gt)) return;
    }
    if (!doc) {
        if (!upsert) return;
        doc = store[filter._id] = { _id: filter._id, ...structuredClone(update.$setOnInsert || {}) };
    }
    for (const [path, value] of Object.entries(update.$set || {})) setPath(doc, path, structuredClone(value));
    for (const path of Object.keys(update.$unset || {})) delete doc[path];
}

/** A QuestProgress.json in the compound form, from [questId, uuid, at] rows. */
function bq(rows) {
    const quests = {};
    rows.forEach(([questId, uuid, at], i) => {
        quests[`${i}:10`] = { 'completed:9': { '0:10': { 'claimed:1': 1, 'timestamp:4': at, 'uuid:8': uuid } }, 'tasks:9': {}, 'questID:3': questId };
    });
    return JSON.stringify({ 'questProgress:9': quests });
}

function setFile(serverId, rows, mtime = '2026-10-10T12:00:00+02:00') {
    const text = bq(rows);
    files[serverId] = { stat: { size: text.length, mtime }, text };
}

beforeEach(() => {
    const seed = seedDoc(new Date(START - DAY));
    ev = {
        ...seed,
        serverId: 'season2',
        startAt: new Date(START),
        weekCount: 2,
        weeklyTargets: [3],
        weeklyMinContribution: 2,
        founder: { ...seed.founder, minQuests: 2 }
    };
    progress = {};
    packs = {};
    files = {};
    downloads = [];
    stats = [];
    eventWrites = [];
    progressWrites = [];
    incs = 0;
    closes = [];
    created = [];
    opsById = {};
    opsOn = false;
    founderRace = false;
    milestoneIncs = [];
    finisherIncs = 0;
    numberRace = false;

    reader.opsConfig = () => ({ useOpsApi: opsOn });
    reader.statProgressFile = async (serverId) => { stats.push(serverId); return files[serverId] ? { ...files[serverId].stat } : null; };
    reader.downloadProgressFile = async (serverId) => { downloads.push(serverId); return files[serverId].text; };

    mongo.listQuestEvents = async () => [structuredClone(ev)];
    mongo.updateQuestEvent = async (id, fields) => {
        eventWrites.push(fields);
        for (const [path, value] of Object.entries(fields)) setPath(ev, path, structuredClone(value));
    };
    mongo.getQuestEventProgress = async (id) => Object.values(progress).filter(d => d.eventId === id).map(d => structuredClone(d));
    mongo.writeQuestEventProgress = async (id, rows, cleared, now) => {
        progressWrites.push({ rows: rows.map(r => r.uuid), cleared });
        for (const op of mongo.questProgressOps(id, rows, cleared, now)) apply(progress, op.updateOne);
    };
    mongo.nextFounderNo = async () => {
        incs++;
        ev.founderSeq = (ev.founderSeq || 0) + 1;
        return ev.founderSeq;
    };
    mongo.setQuestEventFounderNo = async (id, uuid, founderNo, reward) => {
        const doc = progress[`${id}:${uuid}`];
        if (founderRace || !doc || doc.founderNo !== null) return { matchedCount: 0, modifiedCount: 0 };
        doc.founderNo = founderNo;
        doc.rewards.founder = structuredClone(reward);
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.nextMilestoneNo = async (id, key) => {
        milestoneIncs.push(key);
        ev.milestoneSeq = ev.milestoneSeq || {};
        ev.milestoneSeq[key] = (ev.milestoneSeq[key] || 0) + 1;
        return ev.milestoneSeq[key];
    };
    // Mongo's `{field: null}` filter matches a missing field too.
    mongo.setQuestEventMilestoneNo = async (id, uuid, key, milestoneNo, reward) => {
        const doc = progress[`${id}:${uuid}`];
        const taken = doc && doc.milestoneNo && doc.milestoneNo[key] !== undefined && doc.milestoneNo[key] !== null;
        if (numberRace || !doc || taken) return { matchedCount: 0, modifiedCount: 0 };
        doc.milestoneNo = { ...(doc.milestoneNo || {}), [key]: milestoneNo };
        doc.rewards[key] = structuredClone(reward);
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.nextFinisherNo = async () => {
        finisherIncs++;
        ev.finisherSeq = (ev.finisherSeq || 0) + 1;
        return ev.finisherSeq;
    };
    mongo.setQuestEventFinisherNo = async (id, uuid, finisherNo, rewards) => {
        const doc = progress[`${id}:${uuid}`];
        const taken = doc && doc.finisherNo !== undefined && doc.finisherNo !== null;
        if (numberRace || !doc || taken) return { matchedCount: 0, modifiedCount: 0 };
        doc.finisherNo = finisherNo;
        for (const [key, reward] of Object.entries(rewards)) doc.rewards[key] = structuredClone(reward);
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.addQuestEventReward = async (id, uuid, key, reward) => {
        const doc = progress[`${id}:${uuid}`];
        if (!doc || doc.rewards[key]) return { matchedCount: 0 };
        doc.rewards[key] = structuredClone(reward);
        return { matchedCount: 1 };
    };
    mongo.setQuestEventReward = async (id, uuid, key, reward) => {
        progress[`${id}:${uuid}`].rewards[key] = structuredClone(reward);
        return { matchedCount: 1 };
    };
    mongo.findQuestEventRewards = async (id, keys, state) => Object.values(progress)
        .filter(d => d.eventId === id && keys.some(k => d.rewards[k] && d.rewards[k].state === state))
        .map(d => structuredClone(d));
    mongo.closeQuestEventWeek = async (id, entry) => {
        closes.push(entry);
        ev.closedWeeks = ev.closedWeeks || [];
        if (ev.closedWeeks.some(w => w.index === entry.index)) return { modifiedCount: 0 };
        ev.closedWeeks.push(structuredClone(entry));
        return { modifiedCount: 1 };
    };
    mongo.upsertPackCompletions = async (tag, serverId, questId, list) => {
        for (const op of mongo.packCompletionOps(tag, serverId, questId, list)) apply(packs, op.updateOne);
    };
    mongo.getBifrostUsernames = async (uuids) => new Map(uuids.filter(u => NAMES[u]).map(u => [u, NAMES[u]]));

    yggdrasil.createOp = async (server, op) => {
        created.push({ server, op });
        const doc = { _id: `OP${created.length}`, state: 'waiting_player', attempts: 1 };
        opsById[doc._id] = doc;
        return { op: doc, replayed: false };
    };
    yggdrasil.getOp = async (id) => opsById[id];
});

const pid = (uuid) => `dj2r-s2:${uuid}`;

test('count: an unchanged file is not downloaded and nothing is written', async () => {
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000], [3, B, START + 3000]]);
    await reader.countPass(OPTIONS, START + DAY);
    assert.deepStrictEqual(downloads, ['season2']);
    assert.strictEqual(progress[pid(A)].total, 2);
    assert.deepStrictEqual(progress[pid(B)].weeks, { 0: 1 });
    assert.deepStrictEqual(ev.totals, { quests: 3, players: 2, week: { index: 0, count: 3, target: 3 } });
    assert.strictEqual(ev.source.size, files.season2.stat.size);

    const writesBefore = eventWrites.length;
    await reader.countPass(OPTIONS, START + DAY + 5 * 60 * 1000);
    assert.deepStrictEqual(downloads, ['season2'], 'same mtime and size: no second download');
    assert.strictEqual(progressWrites.length, 1);
    assert.strictEqual(eventWrites.length, writesBefore, 'no write at all on an unchanged pass');
});

test('count: a new exclusion recounts an unchanged file and zeroes that player', async () => {
    setFile('season2', [[1, A, START + 1000], [3, B, START + 3000]]);
    await reader.countPass(OPTIONS, START + DAY);
    ev.excluded = [B.toUpperCase()];
    await reader.countPass(OPTIONS, START + DAY + 1);
    assert.strictEqual(downloads.length, 2);
    assert.deepStrictEqual(progressWrites[1], { rows: [], cleared: [B] });
    assert.strictEqual(progress[pid(B)].total, 0);
    assert.strictEqual(ev.totals.players, 1);
});

test('count: the week index moves on a pass with an unchanged file', async () => {
    setFile('season2', [[1, A, START + 1000]]);
    await reader.countPass(OPTIONS, START + DAY);
    await reader.countPass(OPTIONS, START + WEEK + DAY);
    assert.strictEqual(downloads.length, 1);
    assert.deepStrictEqual(ev.totals.week, { index: 1, count: 0, target: 3 });
});

test('count: no serverId, or a start in the future, reads nothing', async () => {
    setFile('season2', [[1, A, START + 1000]]);
    ev.serverId = null;
    await reader.countPass(OPTIONS, START + DAY);
    ev.serverId = 'season2';
    await reader.countPass(OPTIONS, START - 1);
    ev.startAt = null;
    await reader.countPass(OPTIONS, START + DAY);
    assert.deepStrictEqual(stats, []);
    assert.deepStrictEqual(eventWrites, []);
});

test('founder: one number per player from the $inc, in the order they reached minQuests', async () => {
    ev.weekCount = 4;
    // B reaches 2 completions first, then A. C starts after the 14-day window.
    setFile('season2', [
        [1, A, START + 1000], [2, A, START + 3 * 3600e3],
        [1, B, START + 2000], [2, B, START + 2 * 3600e3],
        [1, C, START + 15 * DAY], [2, C, START + 15 * DAY + 1]
    ]);
    await reader.countPass(OPTIONS, START + 16 * DAY);
    assert.strictEqual(progress[pid(B)].founderNo, 1);
    assert.strictEqual(progress[pid(A)].founderNo, 2);
    assert.strictEqual(progress[pid(C)].founderNo, null, 'first completion after the window');
    assert.strictEqual(incs, 2);
    assert.deepStrictEqual(progress[pid(B)].rewards.founder.state, 'pending', 'ops off: waits as pending');

    // A changed file and a second pass: nobody gets a second number.
    setFile('season2', [
        [1, A, START + 1000], [2, A, START + 3 * 3600e3], [3, A, START + 3 * DAY],
        [1, B, START + 2000], [2, B, START + 2 * 3600e3]
    ], '2026-10-27T00:00:00+02:00');
    await reader.countPass(OPTIONS, START + 16 * DAY + 1);
    assert.strictEqual(incs, 2);
    assert.strictEqual(progress[pid(A)].founderNo, 2);
});

test('founder: a lost race wastes the number and never gives a reward', async () => {
    founderRace = true;
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);
    assert.strictEqual(incs, 1);
    assert.strictEqual(progress[pid(A)].founderNo, null);
    assert.deepStrictEqual(progress[pid(A)].rewards, {});
});

test('weekly: a met week closes once and marks every player with enough that week', async () => {
    // Week 0: A 2, B 1 = 3, the target. Min contribution 2: only A.
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000], [1, B, START + 3000]]);
    const afterWeek = START + WEEK + 15 * 60 * 1000;
    await reader.countPass(OPTIONS, afterWeek - 1);
    assert.deepStrictEqual(closes, [], 'not before the close delay');

    await reader.countPass(OPTIONS, afterWeek);
    assert.strictEqual(closes.length, 1);
    assert.deepStrictEqual({ ...closes[0], closedAt: undefined },
        { index: 0, count: 3, target: 3, met: true, recipients: 1, closedAt: undefined });
    assert.deepStrictEqual(progress[pid(A)].rewards.week0.state, 'pending');
    assert.ok(!progress[pid(B)].rewards.week0, 'one completion is short of the minimum');

    await reader.countPass(OPTIONS, afterWeek + 5 * 60 * 1000);
    assert.strictEqual(closes.length, 1, 'a closed week never closes again');
});

test('weekly: a missed target closes the week with no rewards', async () => {
    ev.weeklyTargets = [10];
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + WEEK + DAY);
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0].met, false);
    assert.ok(!progress[pid(A)].rewards.week0);
});

test('weekly: a pass that cannot read the file closes nothing', async () => {
    await reader.countPass(OPTIONS, START + WEEK + DAY);
    assert.deepStrictEqual(closes, []);
});

test('rewards: queued as give_item ops that wait 14 days for the player', async () => {
    opsOn = true;
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000], [1, C, START + 3000], [2, C, START + 4000]]);
    ev.weeklyTargets = [4];
    await reader.countPass(OPTIONS, START + WEEK + DAY);

    const keys = created.map(c => c.op.idempotencyKey).sort();
    assert.deepStrictEqual(keys, [
        `qe:dj2r-s2:founder:${A}`, `qe:dj2r-s2:founder:${C}`,
        `qe:dj2r-s2:week0:${A}`, `qe:dj2r-s2:week0:${C}`
    ].sort());
    for (const { server, op } of created) {
        assert.strictEqual(server, 'season2', 'by the Pterodactyl id, never the tag');
        assert.strictEqual(op.type, 'give_item');
        assert.strictEqual(op.expiresInMs, 14 * DAY);
        assert.deepStrictEqual(op.flags, { offlineMode: 'queue' });
        assert.strictEqual(op.params.overflow, 'drop');
        assert.match(op.params.nbt, /^[A-Za-z0-9+/]+={0,2}$/);
    }
    const toA = created.find(c => c.op.idempotencyKey === `qe:dj2r-s2:founder:${A}`).op;
    assert.deepStrictEqual(toA.target, { uuid: A, name: 'Alp' });
    assert.strictEqual(toA.params.id, 'simple_trophies:trophy');
    const trophy = new NBTReader(Buffer.from(toA.params.nbt, 'base64')).readTag().value;
    assert.strictEqual(trophy.TrophyName.value, `DJ2 Season 2 Founder #${progress[pid(A)].founderNo}`);
    const toC = created.find(c => c.op.idempotencyKey === `qe:dj2r-s2:week0:${C}`).op;
    assert.deepStrictEqual(toC.target, { uuid: C }, 'no known name: the uuid alone');
    assert.strictEqual(toC.params.id, 'minecraft:skull');
    assert.strictEqual(toC.params.meta, 3);

    assert.strictEqual(progress[pid(A)].rewards.founder.state, 'queued');
    assert.ok(progress[pid(A)].rewards.founder.opId);

    await reader.countPass(OPTIONS, START + WEEK + DAY + 5 * 60 * 1000);
    assert.strictEqual(created.length, 4, 'a queued reward is never queued again');
});

test('rewards: ops off waits as pending, then the lever sends them', async () => {
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);
    assert.deepStrictEqual(created, []);
    assert.strictEqual(progress[pid(A)].rewards.founder.state, 'pending');

    opsOn = true;
    await reader.countPass(OPTIONS, START + DAY + 1);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(progress[pid(A)].rewards.founder.state, 'queued');
});

test('rewards: a refused op is failed, a network error stays pending for the next pass', async () => {
    opsOn = true;
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000], [1, B, START + 1000], [2, B, START + 2000]]);
    yggdrasil.createOp = async (server, op) => {
        created.push({ server, op });
        if (op.target.uuid === A) {
            const error = new Error('Request failed with status code 400');
            error.response = { status: 400, data: { error: { message: 'nbt must be base64' } } };
            throw error;
        }
        throw new Error('socket hang up');
    };
    await reader.countPass(OPTIONS, START + DAY);
    assert.strictEqual(progress[pid(A)].rewards.founder.state, 'failed');
    assert.strictEqual(progress[pid(A)].rewards.founder.error, 'nbt must be base64');
    assert.strictEqual(progress[pid(B)].rewards.founder.state, 'pending');
});

test('rewards: the hourly read-back records delivered and failed', async () => {
    opsOn = true;
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000], [1, B, START + 1000], [2, B, START + 3000]]);
    await reader.countPass(OPTIONS, START + DAY);
    const opA = progress[pid(A)].rewards.founder.opId;
    const opB = progress[pid(B)].rewards.founder.opId;
    opsById[opA] = { _id: opA, state: 'completed', result: { data: { given: 1, player: 'Alp' } } };
    opsById[opB] = { _id: opB, state: 'expired', result: null };

    await reader.finisherPass(OPTIONS, START + DAY + 3600e3);
    assert.strictEqual(progress[pid(A)].rewards.founder.state, 'delivered');
    assert.strictEqual(progress[pid(A)].rewards.founder.given, 1);
    assert.strictEqual(progress[pid(B)].rewards.founder.state, 'failed');
    assert.strictEqual(progress[pid(B)].rewards.founder.opState, 'expired');
});

test('finishers: legacy and event server, earliest time kept, no window and no exclusion', async () => {
    ev.excluded = [B];
    // The legacy server has A later than the event server. B is excluded and finished anyway.
    setFile('3f89e24a', [[809, A, START - 30 * DAY], [809, B, START - 300 * DAY], [5, C, START]]);
    setFile('season2', [[809, A, START - 40 * DAY]]);
    await reader.finisherPass(OPTIONS, START + DAY);

    assert.deepStrictEqual(Object.keys(packs).sort(), [`dj2r:${A}`, `dj2r:${B}`]);
    assert.deepStrictEqual(packs[`dj2r:${A}`], {
        _id: `dj2r:${A}`, tag: 'dj2r', uuid: A, questId: 809, at: new Date(START - 40 * DAY), serverId: 'season2'
    });
    assert.strictEqual(packs[`dj2r:${B}`].serverId, '3f89e24a');

    // A later file with a LATER time never moves the record forward.
    setFile('season2', [[809, A, START + DAY]], '2026-10-11T00:00:00+02:00');
    await reader.finisherPass(OPTIONS, START + 2 * DAY);
    assert.deepStrictEqual(packs[`dj2r:${A}`].at, new Date(START - 40 * DAY));
    assert.deepStrictEqual(downloads, ['3f89e24a', 'season2', 'season2'], 'the unchanged legacy file is not read again');
});

test('finishers: run before the event has a server or a start', async () => {
    ev.serverId = null;
    ev.startAt = null;
    setFile('3f89e24a', [[809, A, START - 30 * DAY]]);
    await reader.finisherPass(OPTIONS, START);
    assert.deepStrictEqual(stats, ['3f89e24a']);
    assert.ok(packs[`dj2r:${A}`]);
});

test('milestone: one number per player per milestone, in the order they reached it, no window', async () => {
    ev.weekCount = 4;
    ev.excluded = [D];
    ev.milestones = [{ key: 'm2', quests: 2, reward: CAKE }, { key: 'm3', quests: 3, reward: CAKE }];
    // B reaches 2 first, then A, then C after the 14-day founder window. D is excluded.
    setFile('season2', [
        [1, A, START + 1000], [2, A, START + 3 * 3600e3], [3, A, START + 3 * DAY],
        [1, B, START + 2000], [2, B, START + 2 * 3600e3],
        [1, C, START + 15 * DAY], [2, C, START + 15 * DAY + 1],
        [1, D, START + 10], [2, D, START + 20], [3, D, START + 30]
    ]);
    await reader.countPass(OPTIONS, START + 16 * DAY);
    assert.deepStrictEqual(progress[pid(B)].milestoneNo, { m2: 1 });
    assert.deepStrictEqual(progress[pid(A)].milestoneNo, { m2: 2, m3: 1 });
    assert.deepStrictEqual(progress[pid(C)].milestoneNo, { m2: 3 });
    assert.ok(!progress[pid(D)], 'an excluded player has no doc and no number');
    assert.deepStrictEqual(milestoneIncs, ['m2', 'm2', 'm2', 'm3']);
    assert.deepStrictEqual(ev.milestoneSeq, { m2: 3, m3: 1 });
    assert.deepStrictEqual(progress[pid(A)].milestoneAt, { m2: new Date(START + 3 * 3600e3), m3: new Date(START + 3 * DAY) });
    assert.deepStrictEqual(progress[pid(A)].rewards.m3,
        { state: 'pending', n: 1, earnedAt: new Date(START + 3 * DAY), at: new Date(START + 16 * DAY) });

    // A changed file and a second pass: only B's new milestone takes a number.
    setFile('season2', [
        [1, A, START + 1000], [2, A, START + 3 * 3600e3], [3, A, START + 3 * DAY],
        [1, B, START + 2000], [2, B, START + 2 * 3600e3], [3, B, START + 5 * DAY],
        [1, C, START + 15 * DAY], [2, C, START + 15 * DAY + 1]
    ], '2026-10-27T00:00:00+02:00');
    await reader.countPass(OPTIONS, START + 16 * DAY + 1);
    assert.deepStrictEqual(progress[pid(B)].milestoneNo, { m2: 1, m3: 2 });
    assert.deepStrictEqual(milestoneIncs, ['m2', 'm2', 'm2', 'm3', 'm3']);
});

test('finisher: numbers in completion order, the first firstN also get speedrunner', async () => {
    ev.weekCount = 4;
    ev.excluded = [D];
    ev.finisher = { reward: CAKE, firstN: 2, firstReward: CAKE };
    // C finished before the start. D is excluded. E finishes third.
    setFile('season2', [
        [1, A, START + 1000], [809, A, START + 3 * DAY],
        [809, B, START + 2 * DAY],
        [809, C, START - 1], [1, C, START + 5],
        [809, D, START + DAY],
        [809, E, START + 5 * DAY]
    ]);
    await reader.countPass(OPTIONS, START + 6 * DAY);
    assert.strictEqual(progress[pid(B)].finisherNo, 1);
    assert.strictEqual(progress[pid(A)].finisherNo, 2);
    assert.strictEqual(progress[pid(E)].finisherNo, 3);
    assert.strictEqual(progress[pid(C)].finisherNo, undefined, 'quest 809 before the start');
    assert.strictEqual(progress[pid(C)].finishedAt, null);
    assert.ok(!progress[pid(D)], 'an excluded player never finishes');
    assert.strictEqual(finisherIncs, 3);
    assert.strictEqual(ev.finisherSeq, 3);

    const finisher = { state: 'pending', n: 1, earnedAt: new Date(START + 2 * DAY), at: new Date(START + 6 * DAY) };
    assert.deepStrictEqual(progress[pid(B)].rewards.finisher, finisher);
    assert.deepStrictEqual(progress[pid(B)].rewards.speedrunner, finisher);
    assert.strictEqual(progress[pid(A)].rewards.speedrunner.n, 2);
    assert.ok(!progress[pid(E)].rewards.speedrunner, 'number 3 is past firstN 2');

    setFile('season2', [[1, A, START + 1000], [809, A, START + 3 * DAY], [809, B, START + 2 * DAY], [809, E, START + 5 * DAY]],
        '2026-10-17T00:00:00+02:00');
    await reader.countPass(OPTIONS, START + 6 * DAY + 1);
    assert.strictEqual(finisherIncs, 3, 'nobody gets a second number');
});

test('numbers: a lost race wastes the milestone or finisher number, and the next pass takes a new one', async () => {
    ev.milestones = [{ key: 'm2', quests: 2, reward: CAKE }];
    ev.finisher = { reward: CAKE, firstN: 1, firstReward: CAKE };
    numberRace = true;
    setFile('season2', [[1, A, START + 1000], [809, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);
    assert.deepStrictEqual(milestoneIncs, ['m2']);
    assert.strictEqual(finisherIncs, 1);
    assert.strictEqual(progress[pid(A)].milestoneNo, undefined);
    assert.strictEqual(progress[pid(A)].finisherNo, undefined);
    assert.deepStrictEqual(Object.keys(progress[pid(A)].rewards), ['founder']);

    numberRace = false;
    await reader.countPass(OPTIONS, START + DAY + 1);
    assert.deepStrictEqual(progress[pid(A)].milestoneNo, { m2: 2 });
    assert.strictEqual(progress[pid(A)].finisherNo, 2);
    assert.ok(!progress[pid(A)].rewards.speedrunner, 'number 2 is past firstN 1, the wasted 1 never comes back');
});

test('rewards: milestone, finisher and speedrunner go out with their own spec and read back', async () => {
    opsOn = true;
    ev.milestones = [{ key: 'm2', quests: 2, reward: { id: 'simple_trophies:trophy', name: 'Two quests #{n}' } }];
    ev.finisher = {
        reward: { id: 'simple_trophies:trophy', name: 'Finisher #{n}' },
        firstN: 1,
        firstReward: { id: 'minecraft:skull', meta: 3, skullOwner: 'AlpDerps', name: 'Speedrunner #{n}' }
    };
    setFile('season2', [[1, A, START + 1000], [809, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);

    const key = (k) => `qe:dj2r-s2:${k}:${A}`;
    assert.deepStrictEqual(created.map(c => c.op.idempotencyKey).sort(),
        [key('founder'), key('m2'), key('finisher'), key('speedrunner')].sort());
    const op = (k) => created.find(c => c.op.idempotencyKey === key(k)).op;
    const tag = (k) => new NBTReader(Buffer.from(op(k).params.nbt, 'base64')).readTag().value;
    assert.strictEqual(tag('m2').TrophyName.value, 'Two quests #1');
    assert.strictEqual(tag('m2').TrophyEarnedAt.value, BigInt((START + 2000) / 1000));
    assert.strictEqual(tag('finisher').TrophyName.value, 'Finisher #1');
    assert.strictEqual(op('speedrunner').params.id, 'minecraft:skull');
    assert.strictEqual(tag('speedrunner').display.value.Name.value, 'Speedrunner #1');
    for (const k of ['m2', 'finisher', 'speedrunner']) assert.strictEqual(progress[pid(A)].rewards[k].state, 'queued');

    const rewards = progress[pid(A)].rewards;
    opsById[rewards.m2.opId] = { _id: rewards.m2.opId, state: 'completed', result: { data: { given: 1 } } };
    opsById[rewards.finisher.opId] = { _id: rewards.finisher.opId, state: 'completed', result: { data: { given: 1 } } };
    opsById[rewards.speedrunner.opId] = { _id: rewards.speedrunner.opId, state: 'expired', result: null };
    await reader.finisherPass(OPTIONS, START + DAY + 3600e3);
    assert.strictEqual(progress[pid(A)].rewards.m2.state, 'delivered');
    assert.strictEqual(progress[pid(A)].rewards.finisher.state, 'delivered');
    assert.strictEqual(progress[pid(A)].rewards.speedrunner.state, 'failed');
    assert.strictEqual(progress[pid(A)].rewards.speedrunner.opState, 'expired');
});

test('count: a milestone or finisher change recounts an unchanged file, a reward change does not', async () => {
    setFile('season2', [[1, A, START + 1000], [809, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);
    assert.strictEqual(progress[pid(A)].milestoneAt, undefined);

    ev.milestones = [{ key: 'm2', quests: 2, reward: CAKE }];
    await reader.countPass(OPTIONS, START + DAY + 1);
    assert.strictEqual(downloads.length, 2);
    assert.deepStrictEqual(progress[pid(A)].milestoneAt, { m2: new Date(START + 2000) });

    ev.milestones[0].reward = { id: 'minecraft:diamond' };
    await reader.countPass(OPTIONS, START + DAY + 2);
    assert.strictEqual(downloads.length, 2, 'the reward is no count input');

    ev.finisher = { reward: CAKE };
    await reader.countPass(OPTIONS, START + DAY + 3);
    assert.strictEqual(downloads.length, 3);
    assert.deepStrictEqual(progress[pid(A)].finishedAt, new Date(START + 2000));
});

test('count: a new exclusion drops milestoneAt and finishedAt', async () => {
    ev.milestones = [{ key: 'm2', quests: 2, reward: CAKE }];
    ev.finisher = { reward: CAKE };
    setFile('season2', [[1, A, START + 1000], [809, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);
    assert.ok(progress[pid(A)].milestoneAt.m2 && progress[pid(A)].finishedAt);
    ev.excluded = [A];
    await reader.countPass(OPTIONS, START + DAY + 1);
    assert.strictEqual(progress[pid(A)].total, 0);
    assert.ok(!('milestoneAt' in progress[pid(A)]));
    assert.ok(!('finishedAt' in progress[pid(A)]));
});

test('no milestones or finisher: the same count key, reward keys, docs and numbers as before', async () => {
    const sched = questProgress.schedule(ev);
    assert.strictEqual(reader.countKey(ev, sched),
        JSON.stringify({ startAt: START, endAt: START + 2 * WEEK, weekMs: WEEK, minQuests: 2, excluded: [] }));
    assert.deepStrictEqual(reader.rewardKeys(ev, sched), ['founder', 'week0', 'week1']);

    setFile('season2', [[1, A, START + 1000], [809, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);
    assert.deepStrictEqual(Object.keys(progress[pid(A)]).sort(),
        ['_id', 'eventId', 'firstAt', 'founderAt', 'founderNo', 'rewards', 'total', 'updatedAt', 'uuid', 'weeks']);
    assert.deepStrictEqual(Object.keys(progress[pid(A)].rewards), ['founder']);
    assert.deepStrictEqual(milestoneIncs, []);
    assert.strictEqual(finisherIncs, 0);
    assert.ok(!('milestoneSeq' in ev) && !('finisherSeq' in ev));

    ev.milestones = [{ key: 'm2', quests: 2, reward: CAKE }];
    ev.finisher = { reward: CAKE };
    assert.deepStrictEqual(reader.rewardKeys(ev, sched), ['founder', 'week0', 'week1', 'm2', 'finisher', 'speedrunner']);
});

const CHAPTERS = [
    { index: 0, name: '1. The Journey begins!', icon: { id: 'tconstruct:tooltables', meta: 0 }, quests: [1, 2, 6, 7] },
    { index: 1, name: '4. Immerse Yourself', icon: { id: 'immersiveengineering:tool', meta: 2 }, quests: [3, 4, 5, 8, 9] }
];
const WEEK_TROPHY = {
    id: 'simple_trophies:trophy',
    name: 'Week {week}: {chapter}',
    lore: ['Top chapter: {chapter}'],
    trophy: { displayItem: { id: 'minecraft:nether_star', meta: 0 } }
};
const CLOSE_DELAY = 15 * 60 * 1000;
const decodeOp = (key, uuid) => {
    const found = created.find(c => c.op.idempotencyKey === `qe:dj2r-s2:${key}:${uuid}`);
    return new NBTReader(Buffer.from(found.op.params.nbt, 'base64')).readTag().value;
};

/**
 * Week 1: chapter 1 leads, 5 to 4. Week 2: a 1-1 tie. A does 2 or more in both weeks,
 * B and C do nothing in week 2, D is one short in week 2, E does both weeks.
 */
function chapterWeeks() {
    const w0 = START + 1000;
    const w1 = START + WEEK + 1000;
    setFile('season2', [
        [1, A, w0], [2, A, w0 + 1], [3, A, w0 + 2],
        [4, B, w0 + 3], [5, B, w0 + 4],
        [4, C, w0 + 5], [5, C, w0 + 6],
        [1, D, w0 + 7], [2, D, w0 + 8],
        [3, E, w0 + 9], [4, E, w0 + 10],
        [6, A, w1], [8, A, w1 + 1],
        [10, D, w1 + 2],
        [6, E, w1 + 3], [8, E, w1 + 4]
    ]);
}

test('count: chapters join the count key and recount an unchanged file, a name or icon change does not', async () => {
    setFile('season2', [[1, A, START + 1000], [3, A, START + 2000]]);
    await reader.countPass(OPTIONS, START + DAY);
    const sched = questProgress.schedule(ev);
    const plain = reader.countKey(ev, sched);
    assert.deepStrictEqual(ev.weekChapters, [{}, {}]);

    ev.chapters = structuredClone(CHAPTERS);
    assert.strictEqual(reader.countKey(ev, sched),
        JSON.stringify({ ...JSON.parse(plain), chapters: [[0, [1, 2, 6, 7]], [1, [3, 4, 5, 8, 9]]] }));
    await reader.countPass(OPTIONS, START + DAY + 1);
    assert.strictEqual(downloads.length, 2);
    assert.deepStrictEqual(ev.weekChapters, [{ 0: 1, 1: 1 }, {}]);

    ev.chapters[0].name = 'Renamed';
    ev.chapters[0].icon = { id: 'minecraft:stone', meta: 0 };
    await reader.countPass(OPTIONS, START + DAY + 2);
    assert.strictEqual(downloads.length, 2, 'name and icon are no count input');

    ev.chapters[1].quests.push(10);
    await reader.countPass(OPTIONS, START + DAY + 3);
    assert.strictEqual(downloads.length, 3);
});

test('chapters: a closed week keeps its top chapter, and the weekly trophy shows its icon and name', async () => {
    opsOn = true;
    ev.chapters = CHAPTERS;
    ev.weeklyReward = WEEK_TROPHY;
    ev.excluded = [E];
    chapterWeeks();
    await reader.countPass(OPTIONS, START + WEEK + CLOSE_DELAY);

    assert.deepStrictEqual(ev.weekChapters, [{ 0: 4, 1: 5 }, { 0: 1, 1: 1 }], 'E is excluded and q10 is in no chapter');
    assert.deepStrictEqual(closes[0].chapter, { index: 1, name: '4. Immerse Yourself', icon: { id: 'immersiveengineering:tool', meta: 2 } });
    for (const uuid of [A, B, C, D]) assert.strictEqual(progress[pid(uuid)].rewards.week0.chapter, 1);

    // The event doc of this pass predates the close, so the chapter comes from `chapters`.
    const week0 = decodeOp('week0', A);
    assert.deepStrictEqual(week0.TrophyItem.value, {
        id: { type: 'string', value: 'immersiveengineering:tool' },
        Count: { type: 'byte', value: 1 },
        Damage: { type: 'short', value: 2 }
    });
    assert.strictEqual(week0.TrophyName.value, 'Week 1: 4. Immerse Yourself');
    assert.deepStrictEqual(week0.display.value.Lore.value.value, ['Top chapter: 4. Immerse Yourself']);

    await reader.countPass(OPTIONS, START + 2 * WEEK + CLOSE_DELAY);
    assert.deepStrictEqual(closes[1].chapter, { index: 0, name: '1. The Journey begins!', icon: { id: 'tconstruct:tooltables', meta: 0 } },
        'a 1-1 tie goes to the lower index');
    assert.strictEqual(progress[pid(A)].rewards.week1.chapter, 0);
    assert.strictEqual(decodeOp('week1', A).TrophyItem.value.id.value, 'tconstruct:tooltables');
});

test('chapters: a pending week reward keeps the chapter its week closed with', async () => {
    ev.chapters = structuredClone(CHAPTERS);
    ev.weeklyReward = WEEK_TROPHY;
    setFile('season2', [[3, A, START + 1000], [4, A, START + 2000], [5, A, START + 3000]]);
    await reader.countPass(OPTIONS, START + WEEK + CLOSE_DELAY);
    ev.chapters[1].name = 'Renamed';
    opsOn = true;
    await reader.countPass(OPTIONS, START + WEEK + CLOSE_DELAY + 1);
    assert.strictEqual(decodeOp('week0', A).TrophyName.value, 'Week 1: 4. Immerse Yourself');
});

test('chapters: without chapter data the trophy keeps its own display item and the token stays', async () => {
    opsOn = true;
    ev.weeklyReward = WEEK_TROPHY;
    setFile('season2', [[1, A, START + 1000], [2, A, START + 2000], [3, A, START + 3000]]);
    await reader.countPass(OPTIONS, START + WEEK + CLOSE_DELAY);
    assert.ok(!('chapter' in closes[0]));
    assert.ok(!('chapter' in progress[pid(A)].rewards.week0));
    const week0 = decodeOp('week0', A);
    assert.strictEqual(week0.TrophyItem.value.id.value, 'minecraft:nether_star');
    assert.strictEqual(week0.TrophyName.value, 'Week 1: {chapter}');
});

test('veteran: marked once, on the close of the last week, for players with enough in every week', async () => {
    ev.excluded = [E];
    ev.veteran = { reward: { id: 'simple_trophies:trophy', name: 'DJ2 Season 2 Veteran' } };
    assert.deepStrictEqual(reader.rewardKeys(ev, questProgress.schedule(ev)), ['founder', 'week0', 'week1', 'veteran']);
    chapterWeeks();
    await reader.countPass(OPTIONS, START + WEEK + CLOSE_DELAY);
    assert.strictEqual(closes.length, 1);
    assert.ok(Object.values(progress).every(d => !d.rewards.veteran), 'A already qualifies, but week 2 is still open');

    const lastClose = START + 2 * WEEK + CLOSE_DELAY;
    await reader.countPass(OPTIONS, lastClose);
    assert.strictEqual(closes.length, 2);
    assert.deepStrictEqual(progress[pid(A)].rewards.veteran, { state: 'pending', at: new Date(lastClose), earnedAt: new Date(lastClose) });
    // B and C did nothing in week 2, D is one short in week 2, E is excluded.
    assert.deepStrictEqual(Object.values(progress).filter(d => d.rewards.veteran).map(d => d.uuid), [A]);
    assert.ok(!progress[pid(E)]);

    // The event is over. A later pass closes nothing and sends the veteran op once.
    opsOn = true;
    await reader.countPass(OPTIONS, lastClose + DAY);
    const veteranOps = () => created.filter(c => c.op.idempotencyKey === `qe:dj2r-s2:veteran:${A}`);
    assert.strictEqual(closes.length, 2);
    assert.strictEqual(veteranOps().length, 1);
    assert.strictEqual(decodeOp('veteran', A).TrophyName.value, 'DJ2 Season 2 Veteran');
    assert.strictEqual(progress[pid(A)].rewards.veteran.state, 'queued');

    // A crash before the last close was written runs that close again. The queued record stays.
    ev.closedWeeks.pop();
    await reader.countPass(OPTIONS, lastClose + DAY + 1);
    assert.strictEqual(closes.length, 3);
    assert.strictEqual(progress[pid(A)].rewards.veteran.state, 'queued');
    assert.strictEqual(veteranOps().length, 1);
});

test('veteran: an event without it marks nothing on the last close', async () => {
    chapterWeeks();
    await reader.countPass(OPTIONS, START + 2 * WEEK + CLOSE_DELAY);
    assert.strictEqual(closes.length, 2);
    assert.ok(Object.values(progress).every(d => !d.rewards.veteran));
});
