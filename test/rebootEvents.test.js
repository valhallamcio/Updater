/*
 * Unit tests for the countdown relay: valhallamc.reboot_events.
 * Run: npm test   (node --test test/)
 *
 * The Bifrost proxy renders reboot countdowns itself (boss bar / action bar per client era) and
 * suppresses its "server crashed" relay while a restart is planned. This collection is its ONLY
 * source, so a doc must be written at the start of EVERY countdown — the daily batch, a staff
 * /reboot (a schedule_jobs job) and a player vote alike — and stamped when it is cancelled.
 * The countdown choke point every path goes through is executeRebootWarningsEnhanced.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const rs = require('../schedulers/rebootScheduler');
const mongo = require('../modules/mongo');
const pterodactyl = require('../modules/pterodactyl');
const functions = require('../modules/functions');

const orig = {
    insertRebootEvent: mongo.insertRebootEvent,
    cancelRebootEvents: mongo.cancelRebootEvents,
    completeRebootEvent: mongo.completeRebootEvent,
    sendCommand: pterodactyl.sendCommand,
    sleep: functions.sleep,
};

let inserted;
let cancelled;
let completed;

beforeEach(() => {
    inserted = [];
    cancelled = [];
    completed = [];
    rs.rebootEventState.clear();
    rs.state.activeReboots.clear();
    rs.state.completedServers.clear();
    rs.state.cancelRequested.clear();
    mongo.insertRebootEvent = async (doc) => { inserted.push(doc); return `id-${inserted.length}`; };
    mongo.cancelRebootEvents = async (serverId) => { cancelled.push(serverId); return { modifiedCount: 1 }; };
    mongo.completeRebootEvent = async (id) => { completed.push(id); return { modifiedCount: 1 }; };
    // A one-second window: the countdown loop runs for real, just briefly.
    rs.runtimeConfig = {
        rebootEvents: true,
        playerAlerts: { enabled: false, defaultWarnWindowMinutes: 1 / 60, maxWarnWindowMinutes: 15, commandGapMs: 0 },
    };
    pterodactyl.sendCommand = async () => {};
    functions.sleep = async (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 20)));
});

function restore() {
    Object.assign(mongo, {
        insertRebootEvent: orig.insertRebootEvent,
        cancelRebootEvents: orig.cancelRebootEvents,
        completeRebootEvent: orig.completeRebootEvent,
    });
    pterodactyl.sendCommand = orig.sendCommand;
    functions.sleep = orig.sleep;
    rs.runtimeConfig = undefined;
}

const SERVER = { serverId: 'abc123', tag: 'atm10', name: 'All The Mods 10', serverVersion: '1.20.1' };

test('a daily (batch) countdown writes the doc the proxy renders from', async () => {
    const before = Date.now();
    try {
        await rs.executeRebootWarningsEnhanced(SERVER, {});
    } finally { restore(); }

    assert.strictEqual(inserted.length, 1, 'exactly one countdown doc');
    const doc = inserted[0];
    assert.strictEqual(doc.type, 'countdown');
    assert.strictEqual(doc.tag, 'atm10');
    assert.strictEqual(doc.serverId, 'abc123');
    assert.strictEqual(doc.serverName, 'All The Mods 10');
    assert.strictEqual(doc.source, 'daily', 'no opts = the automated batch');
    assert.strictEqual(doc.warnSeconds, 1, 'the window actually used, not the configured default');
    assert.ok(doc.startsAt === undefined, 'a countdown has no startsAt — it starts now');
    assert.ok(doc.startedAt instanceof Date && doc.startedAt.getTime() >= before);
    assert.strictEqual(doc.fireAt.getTime(), doc.startedAt.getTime() + 1000, 'fireAt = startedAt + warnSeconds');
    assert.strictEqual(doc.cancelledAt, null);
    assert.strictEqual(doc.completedAt, null);
    assert.ok(doc.createdAt instanceof Date, 'createdAt carries the 2-day TTL');
    assert.strictEqual(doc.requestedBy, undefined);
    assert.strictEqual(doc.reason, undefined);
});

test('a scheduled job carries who asked and why; a vote job is sourced as a vote', async () => {
    try {
        await rs.executeRebootWarningsEnhanced(SERVER,
            { scheduled: true, warnWindowMinutes: 1 / 60, requestedBy: 'staff#0001', reason: 'chunk lag' });
        rs.rebootEventState.clear(); // a second countdown, not a retry of the first
        await rs.executeRebootWarningsEnhanced(SERVER,
            { scheduled: true, warnWindowMinutes: 1 / 60, requestedBy: 'Player vote (4/6)' });
    } finally { restore(); }

    assert.strictEqual(inserted.length, 2);
    assert.strictEqual(inserted[0].source, 'scheduled');
    assert.strictEqual(inserted[0].requestedBy, 'staff#0001');
    assert.strictEqual(inserted[0].reason, 'chunk lag');
    assert.strictEqual(inserted[1].source, 'vote', 'vote-restart writes "Player vote (4/6)" as requestedBy');
});

test('the same server twice inside a minute writes one doc, not two bars', () => {
    try {
        rs.recordRebootEvent(SERVER, {}, 900);
        rs.recordRebootEvent(SERVER, {}, 900);
    } finally { restore(); }
    assert.strictEqual(inserted.length, 1);
});

test('a Mongo outage can never fail or delay a reboot', async () => {
    mongo.insertRebootEvent = () => { throw new Error('mongo is down'); }; // sync throw, the worst case
    let warned;
    try {
        warned = await rs.executeRebootWarningsEnhanced(SERVER, {});
    } finally { restore(); }
    assert.strictEqual(warned, true, 'the countdown still completes and the caller still stops the server');
});

test('rebootEvents:false turns the relay off', async () => {
    rs.runtimeConfig = { rebootEvents: false, playerAlerts: { enabled: false, defaultWarnWindowMinutes: 1 / 60 } };
    try {
        await rs.executeRebootWarningsEnhanced(SERVER, {});
    } finally { restore(); }
    assert.strictEqual(inserted.length, 0);
});

test('cancelServerReboot stamps the doc even when no countdown runs in this process', () => {
    try {
        const active = rs.cancelServerReboot('abc123');
        assert.strictEqual(active, false, 'nothing in flight here');
    } finally { restore(); }
    assert.deepStrictEqual(cancelled, ['abc123'], 'the open doc is still stamped — the proxy is showing it');
});

test('the stop step stamps the countdown it started as completed', async () => {
    const stubbed = {
        warn: rs.executeRebootWarningsEnhanced,
        stop: rs.ensureServerStopped,
        start: rs.startServerWithMonitoring,
    };
    rs.executeRebootWarningsEnhanced = async (server, opts) => { rs.recordRebootEvent(server, opts, 900); return true; };
    rs.ensureServerStopped = async () => true;
    rs.startServerWithMonitoring = async () => {};
    let result;
    try {
        result = await rs.executeFullServerReboot(SERVER, 'node', { scheduled: true });
    } finally {
        Object.assign(rs, stubbed);
        restore();
    }

    assert.deepStrictEqual(result, { success: true });
    assert.strictEqual(inserted.length, 1);
    await new Promise(resolve => setImmediate(resolve)); // the stamp is fire-and-forget
    assert.deepStrictEqual(completed, ['id-1'], 'the doc started by this countdown is the one stamped');
    assert.strictEqual(rs.rebootEventState.size, 0, 'the countdown is no longer open');
});
