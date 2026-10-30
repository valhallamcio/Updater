/*
 * Unit tests for pack updates and /restore on standby supervisor servers (managers/updateManager):
 * the standby image is dropped after the shutdown so the next start is cold, a panel kill waits
 * while the supervisor boots or stops a JVM, and the disk check counts the server volume.
 * Run: npm test   (node --test test/)
 *
 * The panel is a fake passed as the client; pterodactyl.shutdown runs against stubbed methods.
 * No call reaches the real panel.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const updateManager = require('../managers/updateManager');
const pterodactyl = require('../modules/pterodactyl');
const sessionLogger = require('../modules/sessionLogger');

const { dropStandbyImage, freezeAndShutdown, supervisorHold, checkVolumeSpace, manifestBytes } = updateManager._internals;

sessionLogger.info = () => {};
sessionLogger.warn = () => {};

const STANDBY = ['image.json', 'image', 'image.sig', 'ready.json', 'log4j2-standby.xml', 'crac-policy.yaml'].map(name => ({ name }));

function panel({ hasImage = true, entries = STANDBY, deleteOk = true, readThrows = false } = {}) {
    const calls = [];
    return {
        calls,
        readFileOnce: async (sid, file) => {
            calls.push(`read ${sid} ${file}`);
            if (readThrows) throw new Error('timeout');
            return hasImage ? Buffer.from('{"pid":1}') : null;
        },
        listFiles: async (sid, dir) => { calls.push(`list ${sid} ${dir}`); return entries; },
        deleteFile: async (sid, names, root) => { calls.push(`delete ${sid} ${root} ${names.join(',')}`); return deleteOk; },
        shutdown: async (sid, a, b, c, opts) => { calls.push(`shutdown ${sid} hold=${typeof (opts && opts.holdKill)}`); },
    };
}

function progress() {
    const lines = [];
    return { report: async (line) => { lines.push(line); }, text: () => lines.join('') };
}

test('dropStandbyImage: deletes standby/image* and keeps the other standby files', async () => {
    const p = panel();
    const out = progress();
    await dropStandbyImage('e2f5e517', out.report, p);
    assert.deepStrictEqual(p.calls, [
        'read e2f5e517 standby/image.json',
        'list e2f5e517 /standby',
        'delete e2f5e517 /standby image.json,image,image.sig',
    ]);
    assert.strictEqual(out.text(), '');
});

test('dropStandbyImage: a server without an image costs one quiet read', async () => {
    const p = panel({ hasImage: false });
    const out = progress();
    await dropStandbyImage('aaaa0001', out.report, p);
    assert.deepStrictEqual(p.calls, ['read aaaa0001 standby/image.json']);
    assert.strictEqual(out.text(), '');
});

test('dropStandbyImage: a refused delete or a failed read warns in the progress and never throws', async () => {
    for (const opts of [{ deleteOk: false }, { readThrows: true }, { entries: [] }]) {
        const out = progress();
        await dropStandbyImage('e2f5e517', out.report, panel(opts));
        assert.match(out.text(), /Warning: could not delete standby\/image\* on e2f5e517 .*the next start/);
    }
});

test('freezeAndShutdown: each instance stops with the kill hold, then loses its image, before the next stops', async () => {
    const p = panel();
    const out = progress();
    const sync = { freezeGroup: async () => ({ frozen: false }) };
    await freezeAndShutdown({ tag: 'evol' }, ['e7575fc9', '505d921b'], { reason: 'update evol 1.6.4' }, out.report, p, sync);
    assert.deepStrictEqual(p.calls.filter(c => !c.startsWith('read') && !c.startsWith('list')), [
        'shutdown e7575fc9 hold=function',
        'delete e7575fc9 /standby image.json,image,image.sig',
        'shutdown 505d921b hold=function',
        'delete 505d921b /standby image.json,image,image.sig',
    ]);
});

test('supervisorHold: a boot, takeover or stopping phase holds the kill; live or no info does not', async () => {
    const sup = (phase) => ({
        current: async () => (phase ? { phase } : null),
        holdsKill: require('../modules/supervisorState').holdsKill,
    });
    assert.strictEqual(await supervisorHold('x', sup('stopping')), 'supervisor phase stopping');
    assert.strictEqual(await supervisorHold('x', sup('cold-reboot')), 'supervisor phase cold-reboot');
    assert.strictEqual(await supervisorHold('x', sup('live')), null);
    assert.strictEqual(await supervisorHold('x', sup(null)), null);
});

// --- pterodactyl.shutdown with a kill hold (real timers, 10 ms ticks) ---

const orig = {
    getStatus: pterodactyl.getStatus,
    sendPowerAction: pterodactyl.sendPowerAction,
    sendCommand: pterodactyl.sendCommand,
};

afterEach(() => Object.assign(pterodactyl, orig));

function idlePanel() {
    const actions = [];
    pterodactyl.getStatus = async () => ({ attributes: { current_state: 'stopping', resources: { cpu_absolute: 2 } } });
    pterodactyl.sendPowerAction = async (sid, action) => { actions.push(action); };
    pterodactyl.sendCommand = async () => ({ success: true });
    return actions;
}

test('shutdown: an idle server is not killed while holdKill answers, then is', async () => {
    const actions = idlePanel();
    let asks = 0;
    const holdKill = async () => (++asks <= 3 ? 'supervisor phase stopping' : null);
    await pterodactyl.shutdown('e2f5e517', 0, 0.01, 0, { holdKill });
    assert.deepStrictEqual(actions, ['stop', 'kill']);
    assert.strictEqual(asks, 4);
});

test('shutdown: the hold ends after holdMaxSeconds of kill wait', async () => {
    const actions = idlePanel();
    let asks = 0;
    await pterodactyl.shutdown('e2f5e517', 0, 0.01, 0, { holdKill: async () => { asks++; return 'supervisor phase stopping'; }, holdMaxSeconds: 0.03 });
    assert.deepStrictEqual(actions, ['stop', 'kill']);
    assert.ok(asks >= 2 && asks <= 3, `${asks} asks`);
});

// --- the volume check ---

test('checkVolumeSpace: a volume short of two pack sizes fails the update, naming the instance', async () => {
    const disks = {
        e7575fc9: { limitBytes: 100000, usedBytes: 10000 },
        e2f5e517: { limitBytes: 100000, usedBytes: 98500 }, // image + java pushed it near the limit
    };
    const client = { getDiskSpace: async (sid) => disks[sid] };
    const error = await checkVolumeSpace(1000, ['e7575fc9', 'e2f5e517'], client);
    assert.match(error, /Not enough space on the server volume: e2f5e517 has/);
    assert.doesNotMatch(error, /e7575fc9/);
});

test('checkVolumeSpace: no limit, enough room, no panel numbers or no pack size pass', async () => {
    const client = {
        getDiskSpace: async (sid) => {
            if (sid === 'nolimit') return { limitBytes: 0, usedBytes: 5e12 };
            if (sid === 'broken') throw new Error('The panel gave no disk numbers');
            return { limitBytes: 100000, usedBytes: 97000 };
        },
    };
    assert.strictEqual(await checkVolumeSpace(1000, ['nolimit', 'broken', 'roomy'], client), null);
    assert.strictEqual(await checkVolumeSpace(null, ['roomy'], client), null);
});

test('manifestBytes: the server-side files of an FTB manifest', () => {
    const manifest = { files: [{ size: 700 }, { size: 300, clientonly: true }, { size: '50' }, { name: 'no size' }] };
    assert.strictEqual(manifestBytes(manifest), 750);
    assert.strictEqual(manifestBytes(null), 0);
});
