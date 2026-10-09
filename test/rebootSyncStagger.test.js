/*
 * Unit tests for the daily reboot stagger of synced instance groups (schedulers/rebootScheduler.js
 * planSyncGroupStagger / rebootSyncFollowers).
 * Run: npm test
 *
 * Two instances of one synced group must never reboot together: the second one starts its
 * warning window at least syncGroupStaggerMinutes after the first one is back up. Every other
 * server keeps today's timing. The reboot itself, the panel and Yggdrasil are fakes.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const rs = require('../schedulers/rebootScheduler');
const functions = require('../modules/functions');
const { createPlayerSync } = require('../modules/playerSync');

const QUEUE = [
    { serverId: 'evol0001', name: 'Evol 1', tag: 'evol', group: 'evol' },
    { serverId: 'xxxx0001', name: 'X', tag: 'x' },
    { serverId: 'evol0002', name: 'Evol 2', tag: 'evol', group: 'evol' },
    { serverId: 'yyyy0001', name: 'Y', tag: 'y', group: '' }
];
const CONFIG = { maxBatchSize: 12, maxConcurrentReboots: 4, serverRebootDelay: 3000, nodeRebootDelay: 5000 };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function fakeHttp(mode, down, gets) {
    return {
        async get(url) {
            gets.push(url);
            if (down) throw new Error('connect ECONNREFUSED');
            return { data: { data: { group: 'evol', mode, frozen: false, instances: [] } } };
        },
        async put() { throw new Error('a reboot never writes to the sync group'); },
        async post() { throw new Error('a reboot never writes to the sync group'); }
    };
}

/** Runs processRebootQueue on fakes and returns the event order. */
async function runQueue({ mode = 'live', down = false, failing = [] } = {}) {
    const events = [];
    const gets = [];
    const saved = {
        executeFullServerReboot: rs.executeFullServerReboot,
        discoverRealNodes: rs.discoverRealNodes,
        completeRebootSequence: rs.completeRebootSequence,
        playerSync: rs.playerSync,
        runtimeConfig: rs.runtimeConfig,
        sleep: functions.sleep,
        rebootQueue: rs.state.rebootQueue,
        isRebootInProgress: rs.state.isRebootInProgress,
        todayStats: rs.state.todayStats
    };
    rs.discoverRealNodes = async () => [{ id: 'node-a' }];
    rs.completeRebootSequence = async () => { events.push('complete'); };
    rs.executeFullServerReboot = async (server) => {
        events.push(`start:${server.serverId}`);
        // A real reboot takes minutes. Yield a full turn so concurrent reboots overlap.
        await new Promise(resolve => setImmediate(resolve));
        events.push(`up:${server.serverId}`);
        return failing.includes(server.serverId) ? { success: false, reason: 'Failed after 3 attempts' } : { success: true };
    };
    functions.sleep = async (ms) => { if (ms >= 60000) events.push(`sleep:${ms}`); };
    rs.runtimeConfig = { syncGroupStaggerMinutes: 15 };
    rs.playerSync = createPlayerSync({ http: fakeHttp(mode, down, gets), log: quiet });
    rs.state.rebootQueue = QUEUE.map(s => ({ ...s }));
    rs.state.isRebootInProgress = true;
    rs.state.todayStats = { totalServers: QUEUE.length, skippedReboots: 0, retryAttempts: {} };
    try {
        await rs.processRebootQueue(CONFIG);
        return { events, gets, stats: rs.state.todayStats };
    } finally {
        Object.assign(rs, {
            executeFullServerReboot: saved.executeFullServerReboot,
            discoverRealNodes: saved.discoverRealNodes,
            completeRebootSequence: saved.completeRebootSequence,
            playerSync: saved.playerSync,
            runtimeConfig: saved.runtimeConfig
        });
        functions.sleep = saved.sleep;
        rs.state.rebootQueue = saved.rebootQueue;
        rs.state.isRebootInProgress = saved.isRebootInProgress;
        rs.state.todayStats = saved.todayStats;
        rs.state.completedServers.clear();
        rs.state.failedServers.clear();
        rs.state.activeReboots.clear();
    }
}

const at = (events, name) => {
    const i = events.indexOf(name);
    assert.ok(i !== -1, `missing event ${name} in ${events.join(', ')}`);
    return i;
};

test('stagger: the second instance of a synced group starts 15 min after the first is back up', async () => {
    const { events, gets } = await runQueue({ mode: 'live' });

    assert.ok(at(events, 'up:evol0001') < at(events, 'sleep:900000'), 'the wait starts once the first is back up');
    assert.ok(at(events, 'sleep:900000') < at(events, 'start:evol0002'), 'the second starts after the wait');
    assert.ok(at(events, 'up:evol0002') < at(events, 'complete'), 'the sequence ends after the last instance');
    assert.deepStrictEqual(gets, ['/biforesting/sync/evol'], 'one gate check for the group');
});

test('stagger: a shadow group is staggered too', async () => {
    const { events } = await runQueue({ mode: 'shadow' });
    assert.ok(at(events, 'up:evol0001') < at(events, 'start:evol0002'));
});

test('stagger: servers outside a synced group keep today\'s timing', async () => {
    const { events } = await runQueue({ mode: 'live' });
    // They start in the batch together with the first instance, before any of them is back up.
    for (const sid of ['evol0001', 'xxxx0001', 'yyyy0001']) {
        assert.ok(at(events, `start:${sid}`) < at(events, 'up:evol0001'), `${sid} starts with the batch`);
    }
    assert.deepStrictEqual(events.filter(e => e.startsWith('sleep:')), ['sleep:900000'], 'the only long wait is the stagger');
});

test('stagger: mode off and Yggdrasil down keep today\'s timing for the group', async () => {
    for (const opts of [{ mode: 'off' }, { down: true }]) {
        const { events } = await runQueue(opts);
        assert.ok(at(events, 'start:evol0002') < at(events, 'up:evol0001'), `${JSON.stringify(opts)}: both instances reboot in the batch`);
        assert.strictEqual(events.filter(e => e.startsWith('sleep:')).length, 0);
    }
});

test('stagger: when the first instance does not come back up, the second is not rebooted', async () => {
    const { events, stats } = await runQueue({ mode: 'live', failing: ['evol0001'] });
    assert.ok(!events.includes('start:evol0002'), 'the group keeps one instance running');
    assert.strictEqual(stats.skippedReboots, 1);
    assert.strictEqual(stats.totalServers, QUEUE.length - 1);
    assert.ok(events.includes('complete'));
});

test('stagger: the gap comes from syncGroupStaggerMinutes, 15 min when the key is absent', () => {
    const saved = rs.runtimeConfig;
    try {
        rs.runtimeConfig = { syncGroupStaggerMinutes: 20 };
        assert.strictEqual(rs.syncStaggerMs(), 20 * 60000);
        rs.runtimeConfig = {};
        assert.strictEqual(rs.syncStaggerMs(), 15 * 60000);
        rs.runtimeConfig = undefined;
        assert.strictEqual(rs.syncStaggerMs(), 15 * 60000);
    } finally {
        rs.runtimeConfig = saved;
    }
});
