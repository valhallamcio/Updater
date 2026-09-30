/*
 * Unit tests for the reboot start path: startServerWithMonitoring resends a start that did not
 * take, and a retry attempt on an offline server goes straight to the start.
 * Run: npm test   (node --test test/)
 *
 * Incidents (2026-09-30):
 * 1. A Storage Box stall made Docker refuse to create containers. Wings failed the start and the
 *    server went starting, then offline. VU waited the full 1200 s, then attempt 2 ran the 15 min
 *    warning window again on the offline server. 12 servers were down about 40 min.
 * 2. il2-sup: VU sent start 0.24 s before Wings released its stop lock. Wings dropped the start
 *    and VU waited 20 min.
 *
 * Time runs on a fake clock: functions.sleep advances it and Date.now reads it.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const rs = require('../schedulers/rebootScheduler');
const pterodactyl = require('../modules/pterodactyl');
const functions = require('../modules/functions');
const sessionLogger = require('../modules/sessionLogger');

const SERVER = { serverId: 'abc123', name: 'X', serverVersion: '1.20.1' };

const orig = {
    getStatus: pterodactyl.getStatus,
    sendPowerAction: pterodactyl.sendPowerAction,
    sendCommand: pterodactyl.sendCommand,
    sleep: functions.sleep,
    now: Date.now,
    warn: sessionLogger.warn,
    runtimeConfig: rs.runtimeConfig,
    todayStats: rs.state.todayStats,
    executeRebootWarningsEnhanced: rs.executeRebootWarningsEnhanced,
    ensureServerStopped: rs.ensureServerStopped,
    startServerWithMonitoring: rs.startServerWithMonitoring,
};

let clock;
let sends;    // clock time of each start send
let warnings; // sessionLogger.warn messages

beforeEach(() => {
    clock = 0;
    sends = [];
    warnings = [];
    Date.now = () => clock;
    functions.sleep = async (ms) => { clock += ms; };
    pterodactyl.sendPowerAction = async (id, action) => { if (action === 'start') sends.push(clock); };
    pterodactyl.sendCommand = async () => {};
    sessionLogger.warn = (source, message) => { warnings.push(String(message)); };
    rs.state.activeReboots.clear();
    rs.state.completedServers.clear();
    rs.state.failedServers.clear();
    rs.rebootEventState.clear();
});

afterEach(() => {
    Object.assign(pterodactyl, {
        getStatus: orig.getStatus,
        sendPowerAction: orig.sendPowerAction,
        sendCommand: orig.sendCommand,
    });
    functions.sleep = orig.sleep;
    Date.now = orig.now;
    sessionLogger.warn = orig.warn;
    rs.runtimeConfig = orig.runtimeConfig;
    rs.state.todayStats = orig.todayStats;
    rs.executeRebootWarningsEnhanced = orig.executeRebootWarningsEnhanced;
    rs.ensureServerStopped = orig.ensureServerStopped;
    rs.startServerWithMonitoring = orig.startServerWithMonitoring;
    rs.state.activeReboots.clear();
    rs.state.completedServers.clear();
    rs.state.failedServers.clear();
});

/**
 * Scripts the panel state. behave(sendNumber, msSinceThatSend) gives the state after a send;
 * before the first send the server is offline.
 */
function simulate(behave) {
    pterodactyl.getStatus = async () => {
        const state = sends.length === 0 ? 'offline' : behave(sends.length, clock - sends[sends.length - 1]);
        return { attributes: { current_state: state, resources: { uptime: 0, cpu_absolute: 0 } } };
    };
}

test('a dropped start (stays offline) is resent after about 45 s and the server comes up', async () => {
    // The first send hits the stop lock and does nothing. The second one boots normally.
    simulate((n, since) => {
        if (n === 1) return 'offline';
        return since < 120000 ? 'starting' : 'running';
    });

    const result = await rs.startServerWithMonitoring(SERVER);

    assert.strictEqual(result, true);
    assert.strictEqual(sends.length, 2, 'exactly one resend');
    assert.ok(sends[0] >= rs.startRetry.lockSettleMs,
        `the first send waits for the Wings stop lock to go (sent at ${sends[0]} ms)`);
    const gap = sends[1] - sends[0];
    assert.ok(gap >= 45000 && gap <= 60000, `resend spaced about 45-60 s after the first send, got ${gap} ms`);
    assert.ok(warnings.some(w => /start dropped/.test(w) && /Resending start \(2\/3\)/.test(w)),
        `the resend is logged with its reason; got: ${warnings.join(' | ')}`);
});

test('a boot that goes starting then offline fails fast and is resent after about 60 s', async () => {
    // Send 1: container create fails 20 s in (Storage Box stall). Send 2: normal boot.
    simulate((n, since) => {
        if (n === 1) return since < 20000 ? 'starting' : 'offline';
        return since < 90000 ? 'starting' : 'running';
    });

    const result = await rs.startServerWithMonitoring(SERVER);

    assert.strictEqual(result, true);
    assert.strictEqual(sends.length, 2, 'exactly one resend');
    const gap = sends[1] - sends[0];
    // Offline from 20 s after the send; resend once it has stayed offline for 60 s.
    assert.ok(gap >= 20000 + 60000 && gap <= 20000 + 60000 + rs.startRetry.pollMs * 2,
        `resend about 60 s after the failed boot, not after the 1200 s budget; got ${gap} ms`);
    assert.ok(warnings.some(w => /boot failed/.test(w)), `the failed boot is logged; got: ${warnings.join(' | ')}`);
});

test('a start that never takes throws after 3 sends instead of waiting out 1200 s', async () => {
    simulate((n, since) => (since < 15000 ? 'starting' : 'offline'));

    await assert.rejects(rs.startServerWithMonitoring(SERVER), /after 3 start sends/);

    assert.strictEqual(sends.length, 3, 'capped at 3 start sends per attempt');
    assert.ok(clock < 5 * 60000, `the attempt fails in minutes, not 20 min; took ${clock / 1000} s`);
});

test('a legitimate slow boot (stays starting) is not resent and keeps the 1200 s budget', async () => {
    // 15 min in the starting state, then running.
    simulate((n, since) => (since < 15 * 60000 ? 'starting' : 'running'));

    const result = await rs.startServerWithMonitoring(SERVER);

    assert.strictEqual(result, true);
    assert.strictEqual(sends.length, 1, 'a booting server gets no second start');
    assert.strictEqual(warnings.length, 0, `nothing to warn about; got: ${warnings.join(' | ')}`);
});

test('a boot that stays starting past 1200 s still times out once, without a resend', async () => {
    simulate(() => 'starting');

    await assert.rejects(rs.startServerWithMonitoring(SERVER), /within timeout period/);

    assert.strictEqual(sends.length, 1);
    assert.ok(clock >= rs.startRetry.bootTimeoutMs, 'the full boot budget was used');
});

test('a retry attempt on an offline server skips the warning window and the stop', async () => {
    let warned = 0;
    let stopped = 0;
    let started = 0;
    rs.executeRebootWarningsEnhanced = async () => { warned++; return true; };
    rs.ensureServerStopped = async () => { stopped++; return true; };
    // Attempt 1: the start did not take. Attempt 2: it does.
    rs.startServerWithMonitoring = async () => {
        started++;
        if (started === 1) throw new Error('Server did not start after 3 start sends (last: boot failed)');
        return true;
    };
    pterodactyl.getStatus = async () => ({
        attributes: { current_state: 'offline', resources: { uptime: 0, cpu_absolute: 0 } },
    });
    rs.runtimeConfig = { minimumUptimeHours: 6, rebootRetryLimit: 3 };
    rs.state.todayStats = { totalServers: 1 };

    const result = await rs.executeFullServerReboot(SERVER, 'node');

    assert.deepStrictEqual(result, { success: true });
    assert.strictEqual(warned, 1, 'the warning window runs on attempt 1 only');
    assert.strictEqual(stopped, 1, 'the save-all and stop steps run on attempt 1 only');
    assert.strictEqual(started, 2, 'attempt 2 goes straight to the start');
});

test('a retry attempt on a server that is up again still runs the warning window', async () => {
    let warned = 0;
    let started = 0;
    rs.executeRebootWarningsEnhanced = async () => { warned++; return true; };
    rs.ensureServerStopped = async () => true;
    rs.startServerWithMonitoring = async () => {
        started++;
        if (started === 1) throw new Error('Server failed to start within timeout period');
        return true;
    };
    // Running with 12 h uptime: the uptime checkpoints let the reboot go on.
    pterodactyl.getStatus = async () => ({
        attributes: { current_state: 'running', resources: { uptime: 12 * 3600 * 1000, cpu_absolute: 0 } },
    });
    rs.runtimeConfig = { minimumUptimeHours: 6, rebootRetryLimit: 3 };
    rs.state.todayStats = { totalServers: 1 };

    const result = await rs.executeFullServerReboot(SERVER, 'node');

    assert.deepStrictEqual(result, { success: true });
    assert.strictEqual(warned, 2, 'players on a running server get the warning window on the retry too');
});
