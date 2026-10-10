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
async function runQueue({ mode = 'live', down = false, failing = [], onSleep = null } = {}) {
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
    functions.sleep = async (ms) => {
        if (ms < 60000) return;
        events.push(`sleep:${ms}`);
        if (onSleep) onSleep();
    };
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

test('stagger: a cancel during the daily stagger wait stops the chain', async () => {
    const saved = rs.markRebootEventsCancelled;
    rs.markRebootEventsCancelled = () => {};
    try {
        const { events } = await runQueue({ mode: 'live', onSleep: () => rs.cancelServerReboot('evol0002') });
        assert.ok(!events.includes('start:evol0002'), 'the cancelled instance does not reboot');
        assert.ok(!rs.state.cancelRequested.has('evol0002'), 'the chain used the cancel up');
    } finally {
        rs.markRebootEventsCancelled = saved;
    }
});

// ---------------------------------------------------------------------------
// Scheduled reboots (/reboot <tag>, vote restarts): scheduledRebootScheduler.runJob
// ---------------------------------------------------------------------------

const srs = require('../schedulers/scheduledRebootScheduler');

const EVOL = [
    { serverId: 'e7575fc9', name: 'Evolution', tag: 'evol', group: 'evol' },
    { serverId: '505d921b', name: 'Evolution #2', tag: 'evol', group: 'evol' },
    { serverId: 'e2f5e517', name: 'Evolution #3', tag: 'evol', group: 'evol' }
];
const PRI = [
    { serverId: '076d8208', name: 'Project Infinity 0.1', tag: 'pri' },
    { serverId: '1ae705e3', name: 'Project Innfinity #2', tag: 'pri' }
];

/** Runs one scheduled_reboot job on fakes and returns the event order, the reboot opts, the history and the staff notes. */
async function runScheduled(job, { mode = 'live', down = false, failing = [], onSleep = null } = {}) {
    const events = [];
    const gets = [];
    const opts = [];
    const notes = [];
    let history = null;
    const saved = {
        executeFullServerReboot: rs.executeFullServerReboot,
        markRebootEventsCancelled: rs.markRebootEventsCancelled,
        playerSync: rs.playerSync,
        runtimeConfig: rs.runtimeConfig,
        sleep: functions.sleep,
        todayStats: rs.state.todayStats,
        notifyStaff: srs.notifyStaff
    };
    rs.executeFullServerReboot = async (server, node, rebootOpts) => {
        events.push(`start:${server.serverId}`);
        opts.push(rebootOpts);
        await new Promise(resolve => setImmediate(resolve));
        events.push(`up:${server.serverId}`);
        return failing.includes(server.serverId) ? { success: false, reason: 'Failed after 3 attempts' } : { success: true };
    };
    rs.markRebootEventsCancelled = () => {};
    functions.sleep = async (ms) => {
        if (ms < 60000) return;
        events.push(`sleep:${ms}`);
        if (onSleep) onSleep();
    };
    rs.runtimeConfig = { syncGroupStaggerMinutes: 15 };
    rs.playerSync = createPlayerSync({ http: fakeHttp(mode, down, gets), log: quiet });
    rs.state.todayStats = { totalServers: 40, skippedReboots: 0, retryAttempts: {} };
    srs.notifyStaff = async (color, title, description) => { notes.push(`${title}: ${description}`); };
    const deps = {
        mongo: {
            deactivateScheduleJob: async () => {},
            getRebootHistory: async () => null,
            updateRebootHistory: async (date, hist) => { history = hist; }
        },
        yggdrasil: { getServers: async () => [...EVOL, ...PRI] }
    };
    try {
        await srs.runJob({ _id: 'job-r', warnWindow: 10, requestedBy: 'alp', reason: 'test', ...job }, deps);
        return { events, gets, opts, notes, history, stats: rs.state.todayStats };
    } finally {
        Object.assign(rs, {
            executeFullServerReboot: saved.executeFullServerReboot,
            markRebootEventsCancelled: saved.markRebootEventsCancelled,
            playerSync: saved.playerSync,
            runtimeConfig: saved.runtimeConfig
        });
        functions.sleep = saved.sleep;
        rs.state.todayStats = saved.todayStats;
        srs.notifyStaff = saved.notifyStaff;
        rs.state.activeReboots.clear();
        rs.state.cancelRequested.clear();
    }
}

test('scheduled: a tag in a synced group reboots its instances one at a time', async () => {
    const { events, gets, opts, notes, history } = await runScheduled({ serverTag: 'evol' });

    assert.ok(at(events, 'up:e7575fc9') < at(events, 'start:505d921b'), 'the second waits for the first');
    assert.ok(at(events, 'up:505d921b') < at(events, 'start:e2f5e517'), 'the third waits for the second');
    assert.deepStrictEqual(events.filter(e => e.startsWith('sleep:')), ['sleep:900000', 'sleep:900000']);
    assert.ok(at(events, 'up:e7575fc9') < events.indexOf('sleep:900000'), 'the gap counts from back up');
    assert.deepStrictEqual(gets, ['/biforesting/sync/evol']);
    assert.ok(opts.every(o => o.scheduled === true && o.warnWindowMinutes === 10 && o.requestedBy === 'alp'), 'every instance keeps the job\'s warning window and requester');
    assert.match(notes[0], /Evolution #2, Evolution #3 follow one at a time, 15 min after the one before is back up/);
    assert.deepStrictEqual(history.scheduledReboots.map(h => [h.instance, h.success]), [
        ['Evolution', true], ['Evolution #2', true], ['Evolution #3', true]
    ]);
});

test('scheduled: a tag with no sync group reboots its instances together, as before', async () => {
    const { events, gets } = await runScheduled({ serverTag: 'pri' });
    assert.ok(at(events, 'start:1ae705e3') < at(events, 'up:076d8208'), 'both start before either is back up');
    assert.deepStrictEqual(events.filter(e => e.startsWith('sleep:')), []);
    assert.deepStrictEqual(gets, [], 'no group, no gate check');
});

test('scheduled: mode off and Yggdrasil down keep the instances together', async () => {
    for (const opts of [{ mode: 'off' }, { down: true }]) {
        const { events } = await runScheduled({ serverTag: 'evol' }, opts);
        assert.ok(at(events, 'start:e2f5e517') < at(events, 'up:e7575fc9'), `${JSON.stringify(opts)}: all start together`);
        assert.strictEqual(events.filter(e => e.startsWith('sleep:')).length, 0);
    }
});

test('scheduled: an instance job reboots that instance only and checks no gate', async () => {
    const { events, gets } = await runScheduled({ serverTag: 'evol', instanceServerId: '505d921b' });
    assert.deepStrictEqual(events, ['start:505d921b', 'up:505d921b']);
    assert.deepStrictEqual(gets, []);
});

test('scheduled: a cancel during the stagger wait stops the instances still waiting', async () => {
    let answered = null;
    const { events, history } = await runScheduled({ serverTag: 'evol' }, {
        onSleep: () => {
            // What /reboot-cancel does for every instance of the tag.
            answered = ['e7575fc9', '505d921b', 'e2f5e517'].map(id => rs.cancelServerReboot(id));
        }
    });
    assert.deepStrictEqual(answered, [false, true, true], 'the waiting instances count as in progress for /reboot-cancel');
    assert.ok(!events.includes('start:505d921b') && !events.includes('start:e2f5e517'));
    assert.deepStrictEqual(history.scheduledReboots.map(h => [h.instance, h.success, h.reason_detail]), [
        ['Evolution', true, null], ['Evolution #2', false, 'cancelled'], ['Evolution #3', false, 'cancelled']
    ]);
    assert.strictEqual(rs.state.staggerWaiting.size, 0);
});

test('scheduled: an instance that does not come back up stops the chain, and the daily stats stay as they are', async () => {
    const { events, history, stats } = await runScheduled({ serverTag: 'evol' }, { failing: ['e7575fc9'] });
    assert.ok(!events.includes('start:505d921b'), 'the group keeps two instances running');
    assert.deepStrictEqual(history.scheduledReboots.map(h => h.success), [false, false, false]);
    assert.match(history.scheduledReboots[1].reason_detail, /Evolution is not back up/);
    assert.strictEqual(stats.skippedReboots, 0);
    assert.strictEqual(stats.totalServers, 40);
});
