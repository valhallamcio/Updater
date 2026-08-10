/*
 * Unit tests for the reboot de-dup gate in modules/rebootScheduler.js.
 * Run: npm test   (node --test test/)
 *
 * Regression (2026-06-22): `/voterestart` and staff `/reboot` returned "duplicate" and rebooted
 * NOTHING for any server the daily automated batch had already rebooted the same GMT+3 day.
 * executeFullServerReboot blocks on isServerActive() = activeReboots OR completedServers, and
 * completedServers is only cleared at the day rollover — so a vote fired hours after the morning
 * batch saw the server still in completedServers and bailed (observed: GT Odyssey @20:44 UTC,
 * "[GT Odyssey] Already being processed, skipping"). Fix: scheduled jobs pass {scheduled:true},
 * which ignores completedServers but still honors a genuinely in-flight reboot.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const rs = require('../schedulers/rebootScheduler');
const pterodactyl = require('../modules/pterodactyl');
const functions = require('../modules/functions');

function reset() {
    rs.state.activeReboots.clear();
    rs.state.completedServers.clear();
    rs.state.failedServers.clear();
}

test('isServerActive: batch path blocks on completedServers (de-dup within one batch)', () => {
    reset();
    rs.state.completedServers.add('abc123');
    assert.strictEqual(rs.stateOperations.isServerActive('abc123'), true);
});

test('isServerActive: scheduled reboot IGNORES completedServers (the duplicate fix)', () => {
    reset();
    rs.state.completedServers.add('abc123'); // daily batch already rebooted it today
    assert.strictEqual(rs.stateOperations.isServerActive('abc123', true), false,
        'a vote/staff reboot must not be skipped just because the daily batch already did it');
});

test('isServerActive: scheduled reboot STILL respects an in-flight reboot', () => {
    reset();
    rs.state.activeReboots.set('abc123', { stage: 'starting' });
    assert.strictEqual(rs.stateOperations.isServerActive('abc123', true), true,
        'never collide with a genuinely in-flight reboot of the same server');
});

test('executeFullServerReboot: batch path returns duplicate for a batch-completed server', async () => {
    reset();
    rs.state.completedServers.add('abc123');
    // No opts -> not scheduled -> still gated by completedServers; returns synchronously, no API calls.
    const r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X' }, 'node');
    assert.deepStrictEqual(r, { success: false, reason: 'duplicate' });
});

test('executeFullServerReboot: scheduled reboot still returns duplicate when one is in-flight', async () => {
    reset();
    rs.state.activeReboots.set('abc123', { stage: 'starting' });
    const r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X' }, 'node', { scheduled: true });
    assert.deepStrictEqual(r, { success: false, reason: 'duplicate' });
    reset(); // drop the seeded active entry so nothing leaks to other tests
});

/*
 * Regression (2026-08-10, aero double-reboot): filterServersByUptime snapshots uptime ONCE when the
 * batch queue is built (06:01), but a server late in the batch reboots ~1h later. A /voterestart or
 * crash in between leaves it freshly started, yet the stale snapshot still let the batch reboot it
 * (aero: vote @06:13 completed 06:21, batch re-rebooted it @06:51 on a 30-min-old server).
 * executeFullServerReboot now re-checks LIVE uptime on the batch path (!opts.scheduled) right before
 * stopping, via getConfirmedUptimeHours — ONE getStatus call so state and uptime come from the same
 * panel snapshot (getServerUptime swallows API errors as 0 and can't be trusted). Null (unconfirmed)
 * proceeds; only a confirmed 'running' server below the minimum is skipped.
 */
test('executeFullServerReboot: batch path skips a confirmed-running server with fresh uptime', async () => {
    reset();
    const origGetStatus = pterodactyl.getStatus;
    const origStats = rs.state.todayStats;
    pterodactyl.getStatus = async () => ({ attributes: { current_state: 'running', resources: { uptime: 30 * 60000 } } }); // 30min
    rs.runtimeConfig = { minimumUptimeHours: 6 };
    rs.state.todayStats = { totalServers: 5 };
    let r;
    try {
        r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X' }, 'node');
    } finally {
        pterodactyl.getStatus = origGetStatus;
    }
    assert.deepStrictEqual(r, { success: true, reason: 'recently_restarted', skipped: true });
    assert.strictEqual(rs.state.completedServers.has('abc123'), true,
        'a skip counts as completed, not failed');
    assert.strictEqual(rs.state.activeReboots.has('abc123'), false, 'must not hold an active-reboot lock after skipping');
    assert.strictEqual(rs.state.todayStats.skippedReboots, 1, 'skip is tracked separately');
    assert.strictEqual(rs.state.todayStats.totalServers, 4, 'denominator drops so success/total stays balanced');
    rs.state.todayStats = origStats;
    reset();
});

test('executeFullServerReboot: unconfirmed uptime (API blip -> unknown state) does NOT skip', async () => {
    reset();
    const origGetStatus = pterodactyl.getStatus;
    const origWarn = rs.executeRebootWarningsEnhanced;
    // getStatus's error default: state 'unknown', uptime 0 — getConfirmedUptimeHours must return null.
    pterodactyl.getStatus = async () => ({ attributes: { current_state: 'unknown', resources: { cpu_absolute: 0, uptime: 0 } } });
    // If the gate proceeds, the reboot path starts with the warning window; cancel it immediately.
    rs.executeRebootWarningsEnhanced = async () => false;
    rs.runtimeConfig = { minimumUptimeHours: 6 };
    let r;
    try {
        r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X' }, 'node');
    } finally {
        pterodactyl.getStatus = origGetStatus;
        rs.executeRebootWarningsEnhanced = origWarn;
    }
    assert.deepStrictEqual(r, { success: false, reason: 'cancelled' },
        'an unconfirmed reading must fall through to the normal reboot path');
    reset();
});

test('executeFullServerReboot: scheduled path never calls the uptime recheck (player request wins)', async () => {
    reset();
    const origGetStatus = pterodactyl.getStatus;
    const origWarn = rs.executeRebootWarningsEnhanced;
    let statusCalled = false;
    pterodactyl.getStatus = async () => { statusCalled = true; return { attributes: { current_state: 'running', resources: { uptime: 0 } } }; };
    // No in-flight reboot this time: the run passes the duplicate gate and would reach the recheck.
    // Cancel at the warning window so nothing else runs.
    rs.executeRebootWarningsEnhanced = async () => false;
    rs.runtimeConfig = { minimumUptimeHours: 6 };
    let r;
    try {
        r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X' }, 'node', { scheduled: true });
    } finally {
        pterodactyl.getStatus = origGetStatus;
        rs.executeRebootWarningsEnhanced = origWarn;
    }
    assert.strictEqual(statusCalled, false, 'scheduled/vote reboots skip the uptime recheck entirely');
    assert.deepStrictEqual(r, { success: false, reason: 'cancelled' });
    reset();
});

test('executeFullServerReboot: a crash DURING the warning window aborts the stop (late checkpoint)', async () => {
    reset();
    const origGetStatus = pterodactyl.getStatus;
    const origWarn = rs.executeRebootWarningsEnhanced;
    const origStop = rs.ensureServerStopped;
    const origCmd = pterodactyl.sendCommand;
    const origStats = rs.state.todayStats;
    // Early checkpoint: 12h uptime, fine. After the warning window: 5min — the server bounced mid-countdown.
    const readings = [
        { attributes: { current_state: 'running', resources: { uptime: 12 * 3600 * 1000 } } },
        { attributes: { current_state: 'running', resources: { uptime: 5 * 60 * 1000 } } },
    ];
    let i = 0;
    pterodactyl.getStatus = async () => readings[Math.min(i++, readings.length - 1)];
    rs.executeRebootWarningsEnhanced = async () => true; // countdown ran to completion
    let stopCalled = false;
    rs.ensureServerStopped = async () => { stopCalled = true; };
    let cancelNotice = null;
    pterodactyl.sendCommand = async (id, cmd) => { cancelNotice = cmd; };
    rs.runtimeConfig = { minimumUptimeHours: 6 };
    rs.state.todayStats = { totalServers: 5 };
    let r;
    try {
        r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X', serverVersion: '1.21.1' }, 'node');
    } finally {
        pterodactyl.getStatus = origGetStatus;
        rs.executeRebootWarningsEnhanced = origWarn;
        rs.ensureServerStopped = origStop;
        pterodactyl.sendCommand = origCmd;
    }
    assert.deepStrictEqual(r, { success: true, reason: 'recently_restarted', skipped: true });
    assert.strictEqual(stopCalled, false, 'must NOT stop a server that restarted during the warning window');
    assert.ok(cancelNotice && cancelNotice.includes('tellraw'), 'players who saw the countdown get a cancel notice');
    assert.strictEqual(rs.state.todayStats.skippedReboots, 1);
    assert.strictEqual(rs.state.todayStats.totalServers, 4);
    rs.state.todayStats = origStats;
    reset();
});

test('executeFullServerReboot: a crash DURING the save flush aborts before the stop power action', async () => {
    reset();
    const orig = {
        getStatus: pterodactyl.getStatus,
        sendCommand: pterodactyl.sendCommand,
        sendPowerAction: pterodactyl.sendPowerAction,
        sleep: functions.sleep,
        warn: rs.executeRebootWarningsEnhanced,
        stats: rs.state.todayStats,
    };
    // Early + post-warning checkpoints: 12h, fine. Post-flush checkpoint: 2min — bounced mid-flush.
    const readings = [
        { attributes: { current_state: 'running', resources: { uptime: 12 * 3600 * 1000 } } },
        { attributes: { current_state: 'running', resources: { uptime: 12 * 3600 * 1000 } } },
        { attributes: { current_state: 'running', resources: { uptime: 2 * 60 * 1000 } } },
    ];
    let i = 0;
    pterodactyl.getStatus = async () => readings[Math.min(i++, readings.length - 1)];
    rs.executeRebootWarningsEnhanced = async () => true;
    const cmds = [], powers = [];
    pterodactyl.sendCommand = async (id, cmd) => { cmds.push(cmd); };
    pterodactyl.sendPowerAction = async (id, a) => { powers.push(a); };
    functions.sleep = async () => {};
    rs.runtimeConfig = { minimumUptimeHours: 6, playerAlerts: { preStopSaveWaitSeconds: 90 } };
    rs.state.todayStats = { totalServers: 5 };
    let r;
    try {
        r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X', serverVersion: '1.21.1' }, 'node');
    } finally {
        Object.assign(pterodactyl, { getStatus: orig.getStatus, sendCommand: orig.sendCommand, sendPowerAction: orig.sendPowerAction });
        functions.sleep = orig.sleep;
        rs.executeRebootWarningsEnhanced = orig.warn;
    }
    assert.deepStrictEqual(r, { success: true, reason: 'recently_restarted', skipped: true });
    assert.strictEqual(powers.length, 0, `no stop/kill may be sent to a server that bounced mid-flush; got: ${powers.join(',')}`);
    assert.ok(cmds.includes('save-all'), 'the flush still ran (harmless on a fresh server)');
    assert.ok(cmds.some(c => c.includes('tellraw')), 'players get the cancel notice');
    assert.strictEqual(rs.state.todayStats.skippedReboots, 1);
    assert.strictEqual(rs.state.todayStats.totalServers, 4);
    rs.state.todayStats = orig.stats;
    reset();
});

/*
 * Pre-stop world flush (requested 2026-06-29): EVERY reboot path must `save-all` then idle the full
 * window BEFORE any stop/kill, so a slow modded save (PRI-class worlds) reaches disk and the 60s
 * force-kill in ensureServerStopped can't truncate it. The wait — not the command — is the guarantee
 * (save-all is async on the backend). Asserts ordering: save-all -> 90s sleep -> stop power action.
 */
test('ensureServerStopped: save-all + full wait happen BEFORE any stop/kill', async () => {
    reset();
    const log = [];
    const orig = {
        sendCommand: pterodactyl.sendCommand,
        sendPowerAction: pterodactyl.sendPowerAction,
        getStatus: pterodactyl.getStatus,
        sleep: functions.sleep,
        runtimeConfig: rs.runtimeConfig,
    };
    pterodactyl.sendCommand = async (id, cmd) => { log.push(`cmd:${cmd}`); };
    pterodactyl.sendPowerAction = async (id, action) => { log.push(`power:${action}`); };
    // Report offline immediately so the stop loop exits after one stop (no kill needed here).
    pterodactyl.getStatus = async () => ({ attributes: { current_state: 'offline' } });
    functions.sleep = async (ms) => { log.push(`sleep:${ms}`); };
    rs.runtimeConfig = { playerAlerts: { preStopSaveWaitSeconds: 90 } };

    try {
        await rs.ensureServerStopped({ serverId: 'abc123', name: 'X' });
    } finally {
        Object.assign(pterodactyl, { sendCommand: orig.sendCommand, sendPowerAction: orig.sendPowerAction, getStatus: orig.getStatus });
        functions.sleep = orig.sleep;
        rs.runtimeConfig = orig.runtimeConfig;
    }

    const saveIdx = log.indexOf('cmd:save-all');
    const waitIdx = log.indexOf('sleep:90000');
    const stopIdx = log.indexOf('power:stop');
    assert.ok(saveIdx !== -1, 'save-all must be issued');
    assert.ok(waitIdx !== -1, 'must wait the full 90s flush window');
    assert.ok(stopIdx !== -1, 'server must still be stopped');
    assert.ok(saveIdx < waitIdx && waitIdx < stopIdx,
        `order must be save-all -> wait -> stop, got: ${log.join(' , ')}`);
    // No stop/kill power action may precede the flush wait.
    assert.ok(!log.slice(0, waitIdx).some(e => e.startsWith('power:')),
        'no stop/kill may happen before the flush wait');
});

/*
 * Kill safety (2026-06-29): a Pterodactyl `kill` is a SIGKILL. If it lands while the JVM is mid-write
 * (saving region/level data) it can corrupt the world even though we pre-saved. forceKillWhenIdle only
 * kills once the server is CONFIRMED idle (CPU dropped) or a hard cap elapses, and treats getStatus()'s
 * API-error default (state 'unknown', cpu 0) as "not idle" so a transient API blip can't trigger a kill.
 */
function stubPtero(overrides) {
    const saved = {
        sendCommand: pterodactyl.sendCommand,
        sendPowerAction: pterodactyl.sendPowerAction,
        getStatus: pterodactyl.getStatus,
        sleep: functions.sleep,
        runtimeConfig: rs.runtimeConfig,
    };
    Object.assign(pterodactyl, overrides.ptero || {});
    if (overrides.sleep) functions.sleep = overrides.sleep;
    rs.runtimeConfig = overrides.runtimeConfig || rs.runtimeConfig;
    return () => {
        Object.assign(pterodactyl, {
            sendCommand: saved.sendCommand, sendPowerAction: saved.sendPowerAction, getStatus: saved.getStatus,
        });
        functions.sleep = saved.sleep;
        rs.runtimeConfig = saved.runtimeConfig;
    };
}

test('forceKillWhenIdle: waits out a busy (saving) server, kills only once CPU is idle', async () => {
    const events = [];
    const statuses = [
        { attributes: { current_state: 'stopping', resources: { cpu_absolute: 150 } } }, // saving — high CPU
        { attributes: { current_state: 'stopping', resources: { cpu_absolute: 70 } } },  // still saving
        { attributes: { current_state: 'stopping', resources: { cpu_absolute: 5 } } },   // idle — safe to kill
    ];
    let i = 0;
    const restore = stubPtero({
        ptero: {
            getStatus: async () => { const s = statuses[Math.min(i++, statuses.length - 1)]; events.push(`poll:${s.attributes.resources.cpu_absolute}`); return s; },
            sendPowerAction: async (id, action) => { events.push(`power:${action}`); },
        },
        sleep: async () => { events.push('sleep'); },
        runtimeConfig: { playerAlerts: { killIdleCpuPercent: 20, killIdleMaxWaitSeconds: 120 } },
    });
    let result;
    try { result = await rs.forceKillWhenIdle({ serverId: 'x', name: 'X' }); }
    finally { restore(); }

    assert.strictEqual(result, false, 'a kill was needed (server never went offline on its own)');
    const killIdx = events.indexOf('power:kill');
    assert.strictEqual(events.filter(e => e === 'power:kill').length, 1, 'exactly one kill');
    assert.ok(events.slice(0, killIdx).includes('poll:150') && events.slice(0, killIdx).includes('poll:70'),
        `must wait out the high-CPU (saving) polls before killing; got: ${events.join(',')}`);
    assert.strictEqual(events[killIdx - 1], 'poll:5', 'kill fires on the idle reading, not mid-save');
});

test('forceKillWhenIdle: API-error reading (state unknown, cpu 0) is NOT treated as idle', async () => {
    const events = [];
    // getStatus() returns this exact shape on an API error; a naive `cpu < idle` check would kill here.
    const statuses = [
        { attributes: { current_state: 'unknown', resources: { cpu_absolute: 0 } } },
        { attributes: { current_state: 'unknown', resources: { cpu_absolute: 0 } } },
        { attributes: { current_state: 'offline', resources: { cpu_absolute: 0 } } },
    ];
    let i = 0;
    const restore = stubPtero({
        ptero: {
            getStatus: async () => statuses[Math.min(i++, statuses.length - 1)],
            sendPowerAction: async (id, action) => { events.push(`power:${action}`); },
        },
        sleep: async () => {},
        runtimeConfig: { playerAlerts: { killIdleCpuPercent: 20, killIdleMaxWaitSeconds: 120 } },
    });
    let result;
    try { result = await rs.forceKillWhenIdle({ serverId: 'x', name: 'X' }); }
    finally { restore(); }

    assert.strictEqual(result, true, 'returns true — server reached offline on its own');
    assert.strictEqual(events.filter(e => e === 'power:kill').length, 0,
        'an unknown/cpu-0 API blip must never be read as idle and killed');
});

test('forceKillWhenIdle: hard cap force-kills a server wedged at high CPU', async () => {
    const events = [];
    const restore = stubPtero({
        ptero: {
            getStatus: async () => ({ attributes: { current_state: 'stopping', resources: { cpu_absolute: 200 } } }),
            sendPowerAction: async (id, action) => { events.push(`power:${action}`); },
        },
        sleep: async () => { await new Promise(r => setTimeout(r, 8)); }, // advance the real clock toward the cap
        runtimeConfig: { playerAlerts: { killIdleCpuPercent: 20, killIdleMaxWaitSeconds: 0.05 } }, // 50ms cap
    });
    let result;
    try { result = await rs.forceKillWhenIdle({ serverId: 'x', name: 'X' }); }
    finally { restore(); }

    assert.strictEqual(result, false);
    assert.strictEqual(events.filter(e => e === 'power:kill').length, 1,
        'a server wedged at high CPU is force-killed once the cap elapses');
});

test('ensureServerStopped: preStopSaveWaitSeconds=0 disables the flush (no extra save/wait)', async () => {
    reset();
    const log = [];
    const orig = {
        sendCommand: pterodactyl.sendCommand,
        sendPowerAction: pterodactyl.sendPowerAction,
        getStatus: pterodactyl.getStatus,
        sleep: functions.sleep,
        runtimeConfig: rs.runtimeConfig,
    };
    pterodactyl.sendCommand = async (id, cmd) => { log.push(`cmd:${cmd}`); };
    pterodactyl.sendPowerAction = async (id, action) => { log.push(`power:${action}`); };
    pterodactyl.getStatus = async () => ({ attributes: { current_state: 'offline' } });
    functions.sleep = async (ms) => { log.push(`sleep:${ms}`); };
    rs.runtimeConfig = { playerAlerts: { preStopSaveWaitSeconds: 0 } };

    try {
        await rs.ensureServerStopped({ serverId: 'abc123', name: 'X' });
    } finally {
        Object.assign(pterodactyl, { sendCommand: orig.sendCommand, sendPowerAction: orig.sendPowerAction, getStatus: orig.getStatus });
        functions.sleep = orig.sleep;
        rs.runtimeConfig = orig.runtimeConfig;
    }

    assert.ok(!log.includes('cmd:save-all'), 'flush save-all suppressed when disabled');
    assert.ok(!log.includes('sleep:0') && !log.some(e => e === 'sleep:90000'), 'no flush wait when disabled');
    assert.strictEqual(log[0], 'power:stop', 'goes straight to stop');
});

/*
 * Regression (2026-08-03): the updater crashed mid-reboot; wings' crash handler restarted the
 * process, recoverFromInterruptedReboot marked the run completed in MONGO but never synced the
 * flag back into this.state.todayStats, so mainLoop re-fired the whole daily batch ~1h later
 * (a second "Automated Reboot Sequence Started" — 6 servers at 10:04 vs 29 at 09:03). Assert the
 * recovered stats land in the in-memory state so the !todayStats.rebootCompleted guard blocks the
 * re-trigger.
 */
const mongo = require('../modules/mongo');

test('recoverFromInterruptedReboot arms the in-memory guard after a mid-run restart', async () => {
    reset();
    // Simulate initializeTodayStats() having loaded a stale copy into state earlier in start().
    const stale = { date: '2026-08-03', rebootTriggered: true, rebootCompleted: false, successfulReboots: 15 };
    rs.state.todayStats = { ...stale };

    const origGet = mongo.getRebootHistory;
    const origUpd = mongo.updateRebootHistory;
    let saved = null;
    mongo.getRebootHistory = async () => ({ ...stale });
    mongo.updateRebootHistory = async (date, stats) => { saved = stats; };

    try {
        await rs.recoverFromInterruptedReboot();
    } finally {
        Object.assign(mongo, { getRebootHistory: origGet, updateRebootHistory: origUpd });
    }

    assert.strictEqual(rs.state.todayStats.rebootCompleted, true,
        'recovered flag must be written back into in-memory state, not just mongo');
    assert.ok(saved && saved.rebootCompleted === true, 'mongo must receive the recovered completed doc');
});
