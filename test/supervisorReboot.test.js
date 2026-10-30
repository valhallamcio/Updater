/*
 * Unit tests for supervisor-aware reboots (modules/supervisorState, rebootScheduler warm path).
 * Run: npm test   (node --test test/)
 *
 * Evol #1-#3 start through the standby supervisor (bifrost-lib docs/standby-supervisor.md). A
 * warm reboot, a crash restore or a cold reboot happens inside the Wings container: Wings stays
 * running and its uptime keeps counting. The supervisor writes standby/state.json; VU reads it.
 *
 * Time runs on a fake clock: functions.sleep advances it and Date.now reads it. The panel and the
 * supervisor are fakes: no call reaches a real panel.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const rs = require('../schedulers/rebootScheduler');
const pterodactyl = require('../modules/pterodactyl');
const supervisorState = require('../modules/supervisorState');
const functions = require('../modules/functions');
const sessionLogger = require('../modules/sessionLogger');

const SERVER = { serverId: 'e2f5e517', name: 'Evol #3', tag: 'evol', serverVersion: '1.21.1' };
const T0 = Date.parse('2026-10-30T10:00:00Z');
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const orig = {
    getStatus: pterodactyl.getStatus,
    sendPowerAction: pterodactyl.sendPowerAction,
    sendCommand: pterodactyl.sendCommand,
    readFileOnce: pterodactyl.readFileOnce,
    sleep: functions.sleep,
    now: Date.now,
    info: sessionLogger.info,
    warn: sessionLogger.warn,
    error: sessionLogger.error,
    runtimeConfig: rs.runtimeConfig,
    todayStats: rs.state.todayStats,
    startServerWithMonitoring: rs.startServerWithMonitoring,
};

let clock;
let commands; // { cmd, at } per console command
let actions;  // { action, at } per power action
let reads;    // state.json reads
let warnings; // sessionLogger.warn messages
let wings;    // Wings power state
let sim;      // the fake supervisor, or null (no state.json)
let started;  // startServerWithMonitoring calls
let onSleep;  // hook run after each fake sleep
let supervisorJson; // the server's supervisor.json, or null (no file: the supervisor defaults)

/**
 * A state.json in schema 1, up since 12 h ago after a cold boot of 80 s, with an unknown field.
 * @param {object} o Overrides: mode, phase, bootCount, updatedAgoMs, lastBoot, live, schema.
 */
function fixture(o = {}) {
    const startedAt = T0 - 12 * HOUR;
    return {
        schema: o.schema !== undefined ? o.schema : 1,
        supervisorVersion: 'a1d27db9',
        supervisorPid: 36,
        supervisorStartedAt: iso(o.supervisorStartedAt || startedAt),
        mode: o.mode || 'always-image',
        phase: o.phase || 'live',
        live: o.live || { pid: 57, startedAt: iso(startedAt + 1000), readyAt: iso(startedAt + 81000), via: 'start', bootSeconds: 80 },
        standby: { state: 'image', since: iso(startedAt + 150000), imageMb: 2186 },
        lastBoot: o.lastBoot || { kind: 'cold', trigger: 'start', startedAt: iso(startedAt), readyAt: iso(startedAt + 81000), seconds: 80, fallback: null, cpuMs: 191000 },
        bootCount: o.bootCount !== undefined ? o.bootCount : 1,
        updatedAt: iso(clock - (o.updatedAgoMs || 5000)),
        somethingNew: { added: 'by a later supervisor' },
    };
}

/**
 * A fake supervisor. `supervisor warm-reboot now` starts a handover that is live again after
 * bootSeconds, unless refuse (nothing changes) or hang (it never comes back).
 * at(ms) can switch the base fixture at a clock time (a crash restore in the countdown).
 */
function supervisor({ mode = 'always-image', bootSeconds = 17, refuse = false, hang = false, updatedAgoMs = 5000, events = [] } = {}) {
    let nowAt = null;
    return {
        prepared: false,
        onCommand(cmd) {
            if (cmd === 'supervisor warm-reboot') this.prepared = true;
            if (cmd === 'supervisor warm-reboot now' && !refuse) nowAt = clock;
        },
        read() {
            const event = events.filter(e => clock >= e.at).pop();
            const d = fixture({ mode, updatedAgoMs, ...(event ? event.state() : {}) });
            if (nowAt !== null) {
                const t = clock - nowAt;
                if (hang || t < bootSeconds * 1000) {
                    d.phase = t < 9000 ? 'warm-reboot' : 'takeover';
                } else {
                    d.phase = 'live';
                    d.bootCount += 1;
                    d.live = { pid: 99, startedAt: iso(nowAt - HOUR), readyAt: iso(nowAt + bootSeconds * 1000), via: 'takeover', bootSeconds: null };
                    d.lastBoot = { kind: 'warm', trigger: 'warm-reboot', startedAt: iso(nowAt), readyAt: iso(nowAt + bootSeconds * 1000), seconds: bootSeconds, fallback: null, cpuMs: 57000 };
                }
            }
            return Buffer.from(JSON.stringify(d));
        },
    };
}

beforeEach(() => {
    clock = T0;
    commands = [];
    actions = [];
    reads = 0;
    warnings = [];
    wings = 'running';
    sim = null;
    started = 0;
    onSleep = null;
    Date.now = () => clock;
    functions.sleep = async (ms) => { clock += ms; if (onSleep) onSleep(); };
    pterodactyl.sendCommand = async (id, cmd) => {
        commands.push({ cmd, at: clock });
        if (sim) sim.onCommand(cmd);
        return { success: true };
    };
    supervisorJson = null;
    pterodactyl.readFileOnce = async (id, path) => {
        if (path === 'supervisor.json') return supervisorJson ? Buffer.from(JSON.stringify(supervisorJson)) : null;
        reads++;
        return sim ? sim.read() : null;
    };
    pterodactyl.getStatus = async () => ({
        attributes: { current_state: wings, resources: { uptime: 12 * HOUR + (clock - T0), cpu_absolute: 0 } },
    });
    pterodactyl.sendPowerAction = async (id, action) => {
        actions.push({ action, at: clock });
        if (action === 'stop' || action === 'kill') wings = 'offline';
    };
    rs.startServerWithMonitoring = async () => { started++; wings = 'running'; return true; };
    sessionLogger.info = () => {};
    sessionLogger.warn = (source, message) => { warnings.push(String(message)); };
    sessionLogger.error = () => {};
    rs.runtimeConfig = { rebootEvents: false, minimumUptimeHours: 6, rebootRetryLimit: 1, playerAlerts: { preStopSaveWaitSeconds: 90 } };
    rs.state.todayStats = { totalServers: 1 };
    rs.state.activeReboots.clear();
    rs.state.completedServers.clear();
    rs.state.failedServers.clear();
    rs.state.cancelRequested.clear();
    rs.preStopSaves.clear();
    rs.rebootEventState.clear();
    rs.warmPlans.clear();
    supervisorState.forget();
});

afterEach(() => {
    Object.assign(pterodactyl, {
        getStatus: orig.getStatus,
        sendPowerAction: orig.sendPowerAction,
        sendCommand: orig.sendCommand,
        readFileOnce: orig.readFileOnce,
    });
    functions.sleep = orig.sleep;
    Date.now = orig.now;
    Object.assign(sessionLogger, { info: orig.info, warn: orig.warn, error: orig.error });
    rs.runtimeConfig = orig.runtimeConfig;
    rs.state.todayStats = orig.todayStats;
    rs.startServerWithMonitoring = orig.startServerWithMonitoring;
    rs.state.activeReboots.clear();
    rs.state.completedServers.clear();
    rs.state.failedServers.clear();
    rs.state.cancelRequested.clear();
    supervisorState.forget();
});

const sup = (cmd) => commands.filter(c => c.cmd.startsWith('supervisor')).map(c => c.cmd);
const at = (cmd) => (commands.find(c => c.cmd === cmd) || {}).at;
const SCHEDULED_5MIN = { scheduled: true, warnWindowMinutes: 5 };

// --- state.json parsing and detection ---

test('parse: schema 1 with unknown fields gives the known fields', () => {
    clock = T0;
    const s = supervisorState.parse(Buffer.from(JSON.stringify(fixture())));
    assert.strictEqual(s.mode, 'always-image');
    assert.strictEqual(s.phase, 'live');
    assert.strictEqual(s.bootCount, 1);
    assert.strictEqual(s.lastBoot.kind, 'cold');
    assert.strictEqual(s.live.via, 'start');
    assert.strictEqual(s.somethingNew, undefined);
    assert.strictEqual(supervisorState.coldBootSeconds(s), 80);
});

test('parse: another schema, a missing field or broken JSON gives null', () => {
    clock = T0;
    assert.strictEqual(supervisorState.parse(JSON.stringify(fixture({ schema: 2 }))), null);
    const noCount = fixture();
    delete noCount.bootCount;
    assert.strictEqual(supervisorState.parse(JSON.stringify(noCount)), null);
    const noUpdated = fixture();
    noUpdated.updatedAt = 'yesterday';
    assert.strictEqual(supervisorState.parse(JSON.stringify(noUpdated)), null);
    assert.strictEqual(supervisorState.parse('{"schema":1,'), null);
});

test('current: a stale file (updatedAt over 3 min) gives no supervisor info', async () => {
    sim = supervisor({ updatedAgoMs: 4 * 60000 });
    assert.strictEqual(await supervisorState.current(SERVER.serverId), null);
    sim = supervisor({ updatedAgoMs: 2 * 60000 });
    assert.ok(await supervisorState.current(SERVER.serverId));
});

test('current: no file or mode off is cached, so the next checks read nothing', async () => {
    assert.strictEqual(await supervisorState.current('aaaa0001'), null);
    assert.strictEqual(await supervisorState.current('aaaa0001'), null);
    sim = supervisor({ mode: 'off' });
    assert.strictEqual(await supervisorState.current('aaaa0002'), null);
    assert.strictEqual(await supervisorState.current('aaaa0002'), null);
    assert.strictEqual(reads, 2, 'one read per server');
    clock += supervisorState.DETECT_TTL_MS;
    await supervisorState.current('aaaa0001');
    assert.strictEqual(reads, 3, 'read again after the cache time');
});

test('current: a failed read is not cached', async () => {
    pterodactyl.readFileOnce = async () => { reads++; throw new Error('timeout'); };
    assert.strictEqual(await supervisorState.current(SERVER.serverId), null);
    assert.strictEqual(await supervisorState.current(SERVER.serverId), null);
    assert.strictEqual(reads, 2);
});

test('rebootDone: a new supervisor after a container restart counts, with a lower bootCount', () => {
    clock = T0;
    const before = supervisorState.parse(JSON.stringify(fixture({ bootCount: 3 })));
    const after = supervisorState.parse(JSON.stringify(fixture({
        bootCount: 1,
        supervisorStartedAt: T0 + 5000,
        lastBoot: { kind: 'start-restore', trigger: 'start', startedAt: iso(T0 + 5000), readyAt: iso(T0 + 20000), seconds: 15 },
    })));
    assert.strictEqual(supervisorState.rebootDone(after, before), true);
    assert.strictEqual(supervisorState.rebootDone(before, before), false);
});

// --- reboot and crash detection ---

test('crash restore: restartedSince and the uptime see a reboot that Wings does not show', async () => {
    sim = supervisor({ events: [{ at: T0, state: () => ({
        bootCount: 2,
        lastBoot: { kind: 'crash-restore', trigger: 'crash', startedAt: iso(T0 - 2 * 60000), readyAt: iso(T0 - 2 * 60000 + 15000), seconds: 15, fallback: null },
        live: { pid: 80, startedAt: iso(T0 - 5 * HOUR), readyAt: iso(T0 - 2 * 60000 + 15000), via: 'restore', bootSeconds: null },
    }) }] });
    assert.strictEqual(await rs.restartedSince(SERVER, T0 - 10 * 60000), true);
    assert.strictEqual(await rs.restartedSince(SERVER, T0 - 60000), false, 'the restore came before this attempt');
    assert.strictEqual(await rs.getConfirmedUptimeHours(SERVER.serverId), 0, 'Wings says 12 h');

    sim = null;
    supervisorState.forget();
    assert.strictEqual(await rs.restartedSince(SERVER, T0 - 10 * 60000), false, 'no state.json: the Wings uptime stands');
    assert.strictEqual(await rs.getConfirmedUptimeHours(SERVER.serverId), 12);
});

test('a boot phase inside the container reads as starting; a stale file keeps the Wings reading', async () => {
    sim = supervisor({ events: [{ at: T0, state: () => ({ phase: 'takeover' }) }] });
    assert.strictEqual(await rs.restartedSince(SERVER, T0 - 60000), true);
    assert.strictEqual(await rs.getConfirmedUptimeHours(SERVER.serverId), null);

    sim = supervisor({ updatedAgoMs: 10 * 60000, events: [{ at: T0, state: () => ({ phase: 'takeover' }) }] });
    supervisorState.forget();
    assert.strictEqual(await rs.restartedSince(SERVER, T0 - 60000), false);
    assert.strictEqual(await rs.getConfirmedUptimeHours(SERVER.serverId), 12);
});

test('filterServersByUptime: a supervisor server rebooted inside its container 1 h ago is skipped', async () => {
    const other = { serverId: 'aaaa0001', name: 'Other', tag: 'oth' };
    const restored = supervisor({ events: [{ at: T0, state: () => ({
        bootCount: 2,
        lastBoot: { kind: 'crash-restore', trigger: 'crash', startedAt: iso(T0 - HOUR), readyAt: iso(T0 - HOUR + 15000), seconds: 15 },
    }) }] });
    pterodactyl.readFileOnce = async (id) => { reads++; return id === SERVER.serverId ? restored.read() : null; };
    pterodactyl.getStatus = async () => ({ attributes: { current_state: 'running', resources: { uptime: 30 * HOUR } } });

    const { eligible, skipped } = await rs.filterServersByUptime([SERVER, other], 6);

    assert.deepStrictEqual(eligible.map(s => s.serverId), ['aaaa0001']);
    assert.deepStrictEqual(skipped.map(s => [s.server.serverId, s.uptimeHours]), [[SERVER.serverId, 1]]);
});

// --- warm reboot ---

test('warm path: warm-reboot at T-3 min, save at T-90 s, warm-reboot now at T-0, no power action', async () => {
    sim = supervisor();

    const result = await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    assert.deepStrictEqual(result, { success: true, warm: true });
    assert.deepStrictEqual(sup(), ['supervisor warm-reboot', 'supervisor warm-reboot now']);
    const end = T0 + 5 * 60000;
    const prep = at('supervisor warm-reboot');
    assert.ok(prep >= end - 185000 && prep <= end - 175000, `prepare at T-${(end - prep) / 1000}s`);
    assert.ok(at('save-all') < at('supervisor warm-reboot now'));
    const now = at('supervisor warm-reboot now');
    assert.ok(now >= end && now < end + 10000, `now at T+${(now - end) / 1000}s`);
    assert.deepStrictEqual(actions, [], 'Wings got no stop and no start');
    assert.strictEqual(started, 0);
    assert.ok(clock - now >= 17000 && clock - now <= 21000, `done ${(clock - now) / 1000}s after now`);
    assert.strictEqual(rs.state.completedServers.has(SERVER.serverId), true);
});

test('warm path: saves at T-90 s, T-30 s and T-5 s, all before warm-reboot now', async () => {
    sim = supervisor();

    await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    const end = T0 + 5 * 60000;
    const saves = commands.filter(c => c.cmd === 'save-all').map(c => Math.round((end - c.at) / 1000));
    assert.strictEqual(saves.length, 3, `saves at T-${saves.join(', T-')}`);
    // The save runs beside the countdown loop. On the fake clock its send lands after the loop's
    // next sleep: up to 5 s late in the dead zone, 0.2 s in the final minute.
    assert.ok(saves[0] >= 84 && saves[0] <= 91, `first save at T-${saves[0]}`);
    assert.ok(saves[1] >= 29 && saves[1] <= 31, `second save at T-${saves[1]}`);
    assert.ok(saves[2] >= 4 && saves[2] <= 6, `third save at T-${saves[2]}`);
    const lastSave = commands.filter(c => c.cmd === 'save-all').pop().at;
    assert.ok(lastSave < at('supervisor warm-reboot now'));
});

test('warm path: the panel path keeps the one T-90 s save', async () => {
    sim = supervisor({ mode: 'off' });
    await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);
    assert.strictEqual(commands.filter(c => c.cmd === 'save-all').length, 1);
});

test('warm path: now waits for a slow extra save to end', async () => {
    sim = supervisor();
    const origSave = rs.preStopSave;
    let saves = 0;
    let lastEnd = 0;
    rs.preStopSave = async () => {
        saves++;
        if (saves === 3) { await functions.sleep(12000); lastEnd = clock; }
        return null;
    };
    try {
        await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);
    } finally {
        rs.preStopSave = origSave;
    }
    assert.strictEqual(saves, 3);
    assert.ok(lastEnd > 0 && at('supervisor warm-reboot now') >= lastEnd);
});

test('warm path: reboot-only with a 0 min window sends warm-reboot right before now', async () => {
    sim = supervisor({ mode: 'reboot-only' });

    const result = await rs.executeFullServerReboot(SERVER, 'node', { scheduled: true, warnWindowMinutes: 0 });

    assert.deepStrictEqual(result, { success: true, warm: true });
    assert.deepStrictEqual(sup(), ['supervisor warm-reboot', 'supervisor warm-reboot now']);
});

test('fallback: phase still live 30 s after now (refused or no answer) gives the panel stop and start', async () => {
    sim = supervisor({ refuse: true });

    const result = await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    assert.deepStrictEqual(result, { success: true });
    const now = at('supervisor warm-reboot now');
    const stop = actions.find(a => a.action === 'stop');
    assert.ok(stop, 'panel stop sent');
    assert.ok(stop.at - now >= 30000 && stop.at - now <= 34000, `stop ${(stop.at - now) / 1000}s after now`);
    assert.strictEqual(started, 1);
    assert.ok(warnings.some(w => /refused or no answer/.test(w)));
});

test('fallback: a handover that never comes back times out at the supervisor worst case', async () => {
    sim = supervisor({ hang: true });

    const result = await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    assert.deepStrictEqual(result, { success: true });
    // park wait 180 + stop 300 + takeover 300 (supervisor defaults) + cold boot 80 + margin 60
    const now = at('supervisor warm-reboot now');
    const stop = actions.find(a => a.action === 'stop');
    assert.ok(stop.at - now >= 920000 && stop.at - now <= 924000, `stop ${(stop.at - now) / 1000}s after now`);
    assert.strictEqual(started, 1);
    assert.ok(warnings.some(w => /timed out after 920s/.test(w)));
});

test('the warm wait takes its timeouts from the server\'s supervisor.json', async () => {
    sim = supervisor({ hang: true });
    supervisorJson = { mode: 'always-image', stopTimeoutSeconds: 100, takeoverTimeoutSeconds: 50, parkWaitSeconds: 10, other: true };

    await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    assert.ok(warnings.some(w => /timed out after 300s/.test(w)), warnings.join(' | '));
});

test('batch: a crash restore 2 h ago skips the daily reboot before the countdown', async () => {
    sim = supervisor({ events: [{ at: T0, state: () => ({
        bootCount: 2,
        lastBoot: { kind: 'crash-restore', trigger: 'crash', startedAt: iso(T0 - 2 * HOUR), readyAt: iso(T0 - 2 * HOUR + 15000), seconds: 15, fallback: null },
        live: { pid: 81, startedAt: iso(T0 - 9 * HOUR), readyAt: iso(T0 - 2 * HOUR + 15000), via: 'restore', bootSeconds: null },
    }) }] });

    const result = await rs.executeFullServerReboot(SERVER, 'node');

    assert.deepStrictEqual(result, { success: true, reason: 'recently_restarted', skipped: true });
    assert.deepStrictEqual(commands, [], 'no countdown, no supervisor command');
    assert.deepStrictEqual(actions, []);
});

// --- the panel kill ---

test('forceKillWhenIdle: no kill while the supervisor stops, even at low CPU', async () => {
    let stopping = true;
    sim = { read: () => Buffer.from(JSON.stringify(fixture({ phase: stopping ? 'stopping' : 'live' }))), onCommand() {} };
    wings = 'stopping';
    onSleep = () => { if (clock - T0 >= 200000) wings = 'offline'; };

    const stoppedAlone = await rs.forceKillWhenIdle(SERVER, rs.getAlertConfig());

    assert.strictEqual(stoppedAlone, true);
    assert.deepStrictEqual(actions, [], 'the CPU was idle and the 120 s grace passed, but the supervisor was stopping');
});

test('forceKillWhenIdle: a stale state.json or a phase past the hold gives the kill as before', async () => {
    sim = { read: () => Buffer.from(JSON.stringify(fixture({ phase: 'stopping', updatedAgoMs: 10 * 60000 }))), onCommand() {} };
    wings = 'stopping';
    await rs.forceKillWhenIdle(SERVER, rs.getAlertConfig());
    assert.deepStrictEqual(actions.map(a => [a.action, a.at - T0]), [['kill', 0]], 'stale: idle kill at once');

    actions = [];
    clock = T0;
    supervisorState.forget();
    sim = { read: () => Buffer.from(JSON.stringify(fixture({ phase: 'takeover' }))), onCommand() {} };
    wings = 'running';
    await rs.forceKillWhenIdle(SERVER, rs.getAlertConfig());
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].at - T0 >= rs.supervisorTiming.killHoldMaxSeconds * 1000, 'killed only after the hold max');
});

test('panel path: a stale state.json, mode off, no file or warmReboot false send no supervisor command', async () => {
    const cases = [
        () => { sim = supervisor({ updatedAgoMs: 4 * 60000 }); },
        () => { sim = supervisor({ mode: 'off' }); },
        () => { sim = null; },
        () => { sim = supervisor(); rs.runtimeConfig.supervisor = { warmReboot: false }; },
    ];
    for (const setup of cases) {
        commands = [];
        actions = [];
        started = 0;
        wings = 'running';
        rs.state.completedServers.clear();
        supervisorState.forget();
        setup();
        const result = await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);
        assert.deepStrictEqual(result, { success: true });
        assert.deepStrictEqual(sup(), []);
        assert.deepStrictEqual(actions.map(a => a.action), ['stop']);
        assert.strictEqual(started, 1);
    }
});

test('cancel after the prepare step sends warm-reboot cancel and never now', async () => {
    sim = supervisor({ mode: 'reboot-only' });
    onSleep = () => { if (clock >= T0 + 4 * 60000) rs.state.cancelRequested.add(SERVER.serverId); };

    const result = await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    assert.deepStrictEqual(result, { success: false, reason: 'cancelled' });
    assert.deepStrictEqual(sup(), ['supervisor warm-reboot', 'supervisor warm-reboot cancel']);
    assert.deepStrictEqual(actions, []);
});

test('cancel before the prepare step sends no supervisor command', async () => {
    sim = supervisor({ mode: 'reboot-only' });
    onSleep = () => { if (clock >= T0 + 60000) rs.state.cancelRequested.add(SERVER.serverId); };

    const result = await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    assert.deepStrictEqual(result, { success: false, reason: 'cancelled' });
    assert.deepStrictEqual(sup(), []);
});

test('batch: a crash restore during the countdown skips the reboot and cancels the prepare step', async () => {
    const end = T0 + 15 * 60000;
    sim = supervisor({ mode: 'reboot-only', events: [{ at: end - 100000, state: () => ({
        bootCount: 2,
        lastBoot: { kind: 'crash-restore', trigger: 'crash', startedAt: iso(end - 100000), readyAt: iso(end - 85000), seconds: 15, fallback: null },
        live: { pid: 81, startedAt: iso(end - 100000), readyAt: iso(end - 85000), via: 'restore', bootSeconds: null },
    }) }] });

    const result = await rs.executeFullServerReboot(SERVER, 'node');

    assert.deepStrictEqual(result, { success: true, reason: 'recently_restarted', skipped: true });
    assert.deepStrictEqual(sup(), ['supervisor warm-reboot', 'supervisor warm-reboot cancel']);
    assert.deepStrictEqual(actions, [], 'the fresh server is not stopped');
});

test('scheduled: a crash restore during the save flush counts as restarted, no warm reboot', async () => {
    const end = T0 + 5 * 60000;
    sim = supervisor({ events: [{ at: end - 30000, state: () => ({
        bootCount: 2,
        lastBoot: { kind: 'crash-restore', trigger: 'crash', startedAt: iso(end - 30000), readyAt: iso(end - 15000), seconds: 15, fallback: null },
    }) }] });

    const result = await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);

    assert.deepStrictEqual(result, { success: true, reason: 'restarted_during_reboot', skipped: true });
    assert.deepStrictEqual(sup(), ['supervisor warm-reboot', 'supervisor warm-reboot cancel']);
    assert.deepStrictEqual(actions, []);
});

test('the warm wait reads state.json every 3 s, not on the 2 s Wings poll', async () => {
    sim = supervisor();
    await rs.executeFullServerReboot(SERVER, 'node', SCHEDULED_5MIN);
    const now = at('supervisor warm-reboot now');
    // plan + post-flush restart check + trigger baseline + one read per 3 s poll until done
    assert.ok(reads <= 3 + Math.ceil((clock - now) / 3000) + 1, `${reads} reads`);
});
