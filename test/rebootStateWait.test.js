/*
 * Unit tests for the reboot stop wait (waitForServerState) and the start that follows it.
 * Run: npm test   (node --test test/)
 *
 * The wait polled every 30 s and the start then waited 10 s for the Wings stop lock. The
 * 10-29 daily reboots sat 19 to 32 s offline before the start (Wings logs on uranium).
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
    info: sessionLogger.info,
    warn: sessionLogger.warn,
    error: sessionLogger.error,
    runtimeConfig: rs.runtimeConfig,
};

let clock;
let actions; // { action, at } per power action
let reads;   // status reads

beforeEach(() => {
    clock = 0;
    actions = [];
    reads = 0;
    Date.now = () => clock;
    functions.sleep = async (ms) => { clock += ms; };
    pterodactyl.sendPowerAction = async (id, action) => { actions.push({ action, at: clock }); };
    pterodactyl.sendCommand = async () => {};
    sessionLogger.info = () => {};
    sessionLogger.warn = () => {};
    sessionLogger.error = () => {};
    // No pre-stop save in these tests; stop grace and kill limits stay at their defaults.
    rs.runtimeConfig = { playerAlerts: { preStopSaveWaitSeconds: 0 } };
    rs.preStopSaves.clear();
});

afterEach(() => {
    Object.assign(pterodactyl, {
        getStatus: orig.getStatus,
        sendPowerAction: orig.sendPowerAction,
        sendCommand: orig.sendCommand,
    });
    functions.sleep = orig.sleep;
    Date.now = orig.now;
    Object.assign(sessionLogger, { info: orig.info, warn: orig.warn, error: orig.error });
    rs.runtimeConfig = orig.runtimeConfig;
});

/** Time of the first power action of this kind, or undefined. */
const firstAt = (action) => (actions.find(a => a.action === action) || {}).at;

/** Scripts the panel. state(now) gives current_state and cpu; every read is counted. */
function panel(state) {
    pterodactyl.getStatus = async () => {
        reads++;
        const { s, cpu = 0 } = state(clock);
        return { attributes: { current_state: s, resources: { uptime: 0, cpu_absolute: cpu } } };
    };
}

test('the stop wait sees offline within one poll, and the start follows after the lock settle', async () => {
    const STOP_TAKES = 9000;
    panel((now) => {
        const stopAt = firstAt('stop');
        const startAt = firstAt('start');
        if (startAt !== undefined) return { s: now - startAt < 60000 ? 'starting' : 'running' };
        if (stopAt !== undefined && now - stopAt >= STOP_TAKES) return { s: 'offline' };
        return { s: stopAt === undefined ? 'running' : 'stopping' };
    });

    assert.strictEqual(await rs.ensureServerStopped(SERVER), true);
    const offlineAt = firstAt('stop') + STOP_TAKES;
    assert.ok(clock - offlineAt < rs.statePollMs,
        `offline seen ${clock - offlineAt} ms after it happened, poll is ${rs.statePollMs} ms`);

    assert.strictEqual(await rs.startServerWithMonitoring(SERVER), true);
    const idle = firstAt('start') - offlineAt;
    assert.ok(idle >= rs.startRetry.lockSettleMs && idle < rs.startRetry.lockSettleMs + rs.statePollMs,
        `start sent ${idle} ms after offline; expected the lock settle plus under one poll`);
    assert.strictEqual(actions.filter(a => a.action === 'start').length, 1, 'one start send');
});

test('a server that ignores stop keeps the full 120 s grace before the kill', async () => {
    // Up and idle until killed: forceKillWhenIdle kills on its first read after the grace.
    panel(() => (firstAt('kill') === undefined ? { s: 'running', cpu: 5 } : { s: 'offline' }));

    assert.strictEqual(await rs.ensureServerStopped(SERVER), true);

    const grace = firstAt('kill') - firstAt('stop');
    assert.ok(grace >= 120000 && grace < 120000 + rs.statePollMs,
        `kill sent ${grace} ms after stop; the stop grace is 120 s`);
    assert.strictEqual(actions.filter(a => a.action === 'stop').length, 1, 'no second stop after the kill');
});

test('failed reads do not count as offline, and the wait gives up at its timeout', async () => {
    panel(() => ({ s: 'unknown' }));

    assert.strictEqual(await rs.waitForServerState(SERVER, 'offline', 30000), false);

    assert.ok(clock >= 30000 && clock < 30000 + rs.statePollMs, `gave up at ${clock} ms`);
    assert.strictEqual(reads, Math.ceil(30000 / rs.statePollMs), 'one read per poll');
});

test('a read that throws is logged and the wait goes on', async () => {
    const warnings = [];
    sessionLogger.warn = (source, message) => { warnings.push(String(message)); };
    pterodactyl.getStatus = async () => {
        reads++;
        if (reads === 1) throw new Error('socket hang up');
        return { attributes: { current_state: 'offline', resources: { uptime: 0, cpu_absolute: 0 } } };
    };

    assert.strictEqual(await rs.waitForServerState(SERVER, 'offline', 30000), true);

    assert.strictEqual(reads, 2);
    assert.strictEqual(clock, rs.statePollMs);
    assert.ok(warnings.some(w => /socket hang up/.test(w)), `the error is logged; got: ${warnings.join(' | ')}`);
});
