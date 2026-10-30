/*
 * Unit tests for quietest-moment daily reboots: modules/quietSlots (the plan) and the
 * rebootScheduler side (quietTick, the fixed batch exclusion).
 * Run: npm test   (node --test test/)
 *
 * Player history is synthetic Prometheus matrix data. No call reaches Prometheus, the panel,
 * Yggdrasil or Mongo.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const quietSlots = require('../modules/quietSlots');
const rs = require('../schedulers/rebootScheduler');
const timeManager = require('../modules/timeManager');
const yggdrasil = require('../modules/yggdrasil');
const mongo = require('../modules/mongo');
const sessionLogger = require('../modules/sessionLogger');

const STEP = 900;
const END = Date.parse('2026-10-30T00:00:00Z') / 1000;

/**
 * A matrix series of 15 min averages over `days` days. players(localMinuteOfSlotStart, day)
 * gives the value of each slot (GMT+3).
 */
function series(serverId, players, { days = 14, endSec = END, labels = {} } = {}) {
    const values = [];
    for (let t = endSec - days * 86400 + STEP; t <= endSec; t += STEP) {
        const slotStart = ((Math.floor(t / 60) + 180 - 15) % 1440 + 1440) % 1440;
        const day = Math.floor((endSec - t) / 86400);
        values.push([t, String(players(slotStart, day))]);
    }
    return { metric: { server_id: serverId, instance: serverId, job: 'biforesting', ...labels }, values };
}

const at = (hhmm) => quietSlots.parseTime(hhmm);
const S = (serverId, tag) => ({ serverId, tag, name: `${tag} ${serverId}` });
const slotOf = (result, id) => result.entries.find(e => e.serverId === id).slot;

// --- the plan ---

test('config: the window parses; a bad or overnight window gives the default', () => {
    const cfg = quietSlots.config({ window: '05:00-12:30' });
    assert.deepStrictEqual([cfg.windowStart, cfg.windowEnd, cfg.fallbackMinutes], [300, 750, 540]);
    assert.deepStrictEqual([quietSlots.config({ window: '22:00-04:00' }).windowStart, quietSlots.config({ window: 'x' }).windowEnd], [540, 660]);
    assert.strictEqual(quietSlots.config().enabled, false, 'off by default');
});

test('profile: the value at step t is the slot that ends at t, in GMT+3', () => {
    const cfg = quietSlots.config();
    const t = Date.parse('2026-10-29T06:15:00Z') / 1000; // 09:15 GMT+3
    const prof = quietSlots.profile(new Map([[t, 4], [t + 86400, 6], [t + 2 * 86400, 2]]), cfg);
    assert.deepStrictEqual(prof.get(at('09:00')), { median: 4, mean: 4, days: 3 });
});

test('plan: the lowest median slot inside the window wins', () => {
    const cfg = quietSlots.config({ window: '09:00-11:00' });
    const history = [series('aaaa0001', (m) => (m === at('10:15') ? 1 : m === at('08:00') ? 0 : 5))];
    const result = quietSlots.plan([S('aaaa0001', 'one')], history, cfg);
    assert.strictEqual(slotOf(result, 'aaaa0001'), at('10:15'), '08:00 is quieter but outside the window');
    const e = result.entries[0];
    assert.deepStrictEqual([e.median, e.fallbackMedian, e.days], [1, 5, 14]);
});

test('plan: a tie goes to the slot nearest the fixed batch time', () => {
    const cfg = quietSlots.config({ window: '00:00-24:00' });
    const result = quietSlots.plan([S('aaaa0001', 'one')], [series('aaaa0001', () => 0)], cfg);
    assert.strictEqual(slotOf(result, 'aaaa0001'), at('09:00'));
});

test('plan: a busy outlier day does not move the median', () => {
    const cfg = quietSlots.config({ window: '09:00-11:00' });
    const history = [series('aaaa0001', (m, day) => (m === at('09:30') ? (day === 3 ? 40 : 1) : 3))];
    assert.strictEqual(slotOf(quietSlots.plan([S('aaaa0001', 'one')], history, cfg), 'aaaa0001'), at('09:30'));
});

test('plan: too little history keeps the fixed batch, with the reason', () => {
    const cfg = quietSlots.config({ minDays: 7 });
    const history = [series('aaaa0001', () => 1, { days: 5 })];
    const result = quietSlots.plan([S('aaaa0001', 'one'), S('aaaa0002', 'two')], history, cfg);
    assert.strictEqual(slotOf(result, 'aaaa0001'), null);
    assert.match(result.entries[0].reason, /5 days of history in the window, 7 needed/);
    assert.match(result.entries[1].reason, /no player series/);
});

test('plan: a Prometheus failure keeps every server on the fixed batch', () => {
    const result = quietSlots.plan([S('aaaa0001', 'one')], null, quietSlots.config(), 'timeout');
    assert.strictEqual(slotOf(result, 'aaaa0001'), null);
    assert.match(quietSlots.format(result, quietSlots.config()), /fixed batch 09:00 \(no history \(timeout\)\)/);
});

test('plan: instances of one tag get slots at least siblingGapMinutes apart', () => {
    const cfg = quietSlots.config({ window: '09:00-11:00', siblingGapMinutes: 45 });
    const quietAt0930 = (m) => (m === at('09:30') ? 0 : m === at('09:45') ? 1 : 4);
    const history = ['e0000001', 'e0000002', 'e0000003'].map(id => series(id, quietAt0930));
    const result = quietSlots.plan(['e0000001', 'e0000002', 'e0000003'].map(id => S(id, 'evol')), history, cfg);
    const slots = result.entries.map(e => e.slot).sort((a, b) => a - b);
    assert.ok(slots.every(s => s !== null), result.entries.map(e => e.reason).join('; '));
    for (let i = 1; i < slots.length; i++) assert.ok(slots[i] - slots[i - 1] >= 45, `slots ${slots.map(quietSlots.formatTime)}`);
    // 09:30 + 10:15 leaves no room for a third; 09:00, 09:45, 10:30 fits all three.
    assert.deepStrictEqual(slots, [at('09:00'), at('09:45'), at('10:30')]);
});

test('plan: siblings that fit take their own best slots', () => {
    const cfg = quietSlots.config({ window: '00:00-24:00', siblingGapMinutes: 45 });
    const history = [
        series('e0000001', (m) => (m === at('06:00') ? 0 : 5)),
        series('e0000002', (m) => (m === at('06:15') ? 1 : m === at('08:00') ? 2 : 5)),
    ];
    const result = quietSlots.plan([S('e0000001', 'evol'), S('e0000002', 'evol')], history, cfg);
    assert.deepStrictEqual([slotOf(result, 'e0000001'), slotOf(result, 'e0000002')], [at('06:00'), at('08:00')]);
    assert.match(result.entries[1].reason, /best slot 06:15 \(median 1\) is too close to a sibling/);
});

test('plan: one instance without a slot sends the whole tag to the fixed batch', () => {
    const cfg = quietSlots.config();
    const history = [series('p0000001', () => 1)];
    const result = quietSlots.plan([S('p0000001', 'pri'), S('p0000002', 'pri')], history, cfg);
    assert.deepStrictEqual(result.entries.map(e => e.slot), [null, null]);
    assert.match(result.entries[0].reason, /whole tag keeps the fixed batch/);
});

test('plan: no room for every sibling in the window sends the tag to the fixed batch', () => {
    const cfg = quietSlots.config({ window: '09:00-10:00', siblingGapMinutes: 45 });
    const ids = ['g0000001', 'g0000002', 'g0000003'];
    const result = quietSlots.plan(ids.map(id => S(id, 'gto')), ids.map(id => series(id, () => 1)), cfg);
    assert.deepStrictEqual(result.entries.map(e => e.slot), [null, null, null]);
    assert.match(result.entries[0].reason, /no slots 45 min apart/);
});

test('currentSeries: an old pack on a reused panel id is dropped', () => {
    const old = series('08f3d7de', () => 0, { endSec: END - 5 * 86400, days: 9, labels: { instance: 'ember' } });
    const now = series('08f3d7de', () => 3, { days: 5, labels: { instance: 'tfgm' } });
    const points = quietSlots.currentSeries([old, now]).get('08f3d7de');
    assert.ok([...points.values()].every(v => v === 3));
});

test('fetchHistory: one range query, steps aligned to the slot, an error answer throws', async () => {
    let call;
    const get = async (url, opts) => { call = { url, params: opts.params }; return { data: { status: 'success', data: { resultType: 'matrix', result: [] } } }; };
    // orig.fetchHistory: the scheduler tests below stub quietSlots.fetchHistory in every beforeEach.
    await orig.fetchHistory(quietSlots.config({ prometheusUrl: 'http://prom:9090/' }), { get, now: Date.parse('2026-10-30T10:07:31Z') });
    assert.strictEqual(call.url, 'http://prom:9090/api/v1/query_range');
    assert.strictEqual(call.params.step, 900);
    assert.strictEqual(call.params.end % 900, 0);
    assert.strictEqual(call.params.end - call.params.start, 14 * 86400);
    await assert.rejects(orig.fetchHistory(quietSlots.config(), { get: async () => ({ data: { status: 'error' } }) }));
});

// --- the scheduler ---

const orig = {
    now: Date.now,
    getServers: yggdrasil.getServers,
    fetchHistory: quietSlots.fetchHistory,
    updateRebootHistory: mongo.updateRebootHistory,
    info: sessionLogger.info,
    warn: sessionLogger.warn,
    runtimeConfig: rs.runtimeConfig,
    runQuietBatch: rs.runQuietBatch,
    filterServersByUptime: rs.filterServersByUptime,
    processRebootQueue: rs.processRebootQueue,
    sendRebootNotification: rs.sendRebootNotification,
    todayStats: rs.state.todayStats,
};

const SERVERS = [S('a0000001', 'one'), S('b0000001', 'two'), S('c0000001', 'three')];
let fetches;
let started;

beforeEach(() => {
    fetches = 0;
    started = [];
    sessionLogger.info = () => {};
    sessionLogger.warn = () => {};
    yggdrasil.getServers = async () => SERVERS;
    // one: quiet at 10:00; two: quiet at 09:30; three: no history
    quietSlots.fetchHistory = async () => {
        fetches++;
        return [
            series('a0000001', (m) => (m === at('10:00') ? 0 : 5)),
            series('b0000001', (m) => (m === at('09:30') ? 0 : 5)),
        ];
    };
    mongo.updateRebootHistory = async () => {};
    rs.runQuietBatch = async (servers) => { started.push(...servers.map(s => s.serverId)); };
    rs.runtimeConfig = { quietSlots: { enabled: true, window: '09:00-11:00' } };
    rs.quietPlan = null;
    rs.quietBusy = false;
});

afterEach(() => {
    Date.now = orig.now;
    yggdrasil.getServers = orig.getServers;
    quietSlots.fetchHistory = orig.fetchHistory;
    mongo.updateRebootHistory = orig.updateRebootHistory;
    Object.assign(sessionLogger, { info: orig.info, warn: orig.warn });
    Object.assign(rs, {
        runtimeConfig: orig.runtimeConfig,
        runQuietBatch: orig.runQuietBatch,
        filterServersByUptime: orig.filterServersByUptime,
        processRebootQueue: orig.processRebootQueue,
        sendRebootNotification: orig.sendRebootNotification,
    });
    rs.state.todayStats = orig.todayStats;
    rs.quietPlan = null;
});

/** Epoch ms of hh:mm GMT+3 on the scheduler's today. */
function today(hhmm) {
    return quietSlots.slotTimeMs(timeManager.getTodayDateString(), at(hhmm), rs.quietConfig());
}

test('quietTick: a server starts when its countdown is due (slot minus 15 min), once', async () => {
    Date.now = () => today('09:14');
    await rs.quietTick();
    assert.deepStrictEqual(started, [], '09:30 slot: the countdown starts 09:15');
    Date.now = () => today('09:15');
    await rs.quietTick();
    assert.deepStrictEqual(started, ['b0000001']);
    Date.now = () => today('09:50');
    await rs.quietTick();
    await rs.quietTick();
    assert.deepStrictEqual(started, ['b0000001', 'a0000001']);
    assert.strictEqual(fetches, 1, 'one Prometheus read per day');
});

test('quietTick: a slot missed while VU was down runs late inside the window, not after it', async () => {
    Date.now = () => today('10:40');
    await rs.quietTick();
    assert.deepStrictEqual(started.sort(), ['a0000001', 'b0000001']);

    rs.quietPlan = null;
    started = [];
    Date.now = () => today('11:00');
    await rs.quietTick();
    assert.deepStrictEqual(started, []);
});

test('quietTick: off by default, and then the fixed batch keeps every server', async () => {
    rs.runtimeConfig = {};
    Date.now = () => today('09:50');
    await rs.quietTick();
    assert.deepStrictEqual(started, []);
    assert.strictEqual(fetches, 0);
    assert.strictEqual(rs.quietSlotServerIds().size, 0);
});

test('the fixed batch leaves out servers with a quiet slot and keeps the rest', async () => {
    Date.now = () => today('08:00');
    await rs.quietTick();
    let queued = null;
    rs.filterServersByUptime = async (servers) => ({ eligible: servers, skipped: [] });
    rs.sendRebootNotification = async () => {};
    rs.processRebootQueue = async () => { queued = rs.state.rebootQueue.map(s => s.serverId); };
    rs.state.todayStats = { retryAttempts: {} };

    await rs.triggerRebootSequence('test', 0, {});

    assert.deepStrictEqual(queued, ['c0000001']);
    rs.state.isRebootInProgress = false;
});
