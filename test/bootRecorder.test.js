/*
 * Unit tests for schedulers/bootRecorder.js: one bifrost.server_boots record per supervisor boot.
 * Run: npm test   (node --test test/)
 *
 * Yggdrasil, Mongo and state.json are fakes passed as deps: nothing reaches a real service.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const recorder = require('../schedulers/bootRecorder');
const supervisorState = require('../modules/supervisorState');
const sessionLogger = require('../modules/sessionLogger');

sessionLogger.info = () => {};
sessionLogger.warn = () => {};

const EVOL = { serverId: 'e2f5e517', tag: 'evol', name: 'Evol #3' };
const OTHER = { serverId: 'aaaa0001', tag: 'oth', name: 'Other' };
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-30T10:00:00Z');
const HOUR = 3600 * 1000;

/** A parsed state.json: boot number n of the supervisor started at supStart. */
function state(n, { supStart = T0, kind = 'warm', ready = true } = {}) {
    const startedAt = T0 + n * 60000;
    return supervisorState.parse(JSON.stringify({
        schema: 1, supervisorVersion: 'a1d27db9', supervisorPid: 36, supervisorStartedAt: iso(supStart),
        mode: 'always-image', phase: ready ? 'live' : 'takeover',
        live: { pid: 57, startedAt: iso(startedAt), readyAt: ready ? iso(startedAt + 17000) : null, via: 'takeover', bootSeconds: null },
        standby: { state: 'image', since: iso(startedAt), imageMb: 2186 },
        lastBoot: { kind, trigger: kind === 'crash-restore' ? 'crash' : 'warm-reboot', startedAt: iso(startedAt),
            readyAt: ready ? iso(startedAt + 17000) : null, seconds: ready ? 17.0 : null, fallback: null, cpuMs: 57000 },
        bootCount: n, updatedAt: iso(startedAt + 20000),
    }));
}

let files;   // serverId -> parsed state or null
let records; // unique key -> doc
let failWrites;

function deps() {
    return {
        yggdrasil: { getServers: async () => [EVOL, OTHER] },
        supervisorState: { current: async (id) => files[id] || null },
        mongo: {
            insertServerBoot: async (doc) => {
                if (failWrites) throw new Error('mongo down');
                const key = `${doc.serverId}|${doc.supervisorStartedAt.getTime()}|${doc.bootCount}`;
                if (records.has(key)) return false;
                records.set(key, doc);
                return true;
            },
        },
    };
}

beforeEach(() => {
    files = {};
    records = new Map();
    failWrites = false;
    recorder.lastSeen.clear();
    recorder.running = false;
});

test('off by default', () => {
    assert.strictEqual(recorder.defaultConfig.active, false);
});

test('one record per boot: the same boot on the next pass writes nothing', async () => {
    files[EVOL.serverId] = state(1, { kind: 'cold' });
    assert.strictEqual(await recorder.tick(deps()), 1);
    assert.strictEqual(await recorder.tick(deps()), 0);
    files[EVOL.serverId] = state(2);
    assert.strictEqual(await recorder.tick(deps()), 1);

    const docs = [...records.values()];
    assert.deepStrictEqual(docs.map(d => [d.kind, d.bootCount]), [['cold', 1], ['warm', 2]]);
    const d = docs[1];
    assert.strictEqual(d.serverId, EVOL.serverId);
    assert.strictEqual(d.trigger, 'warm-reboot');
    assert.strictEqual(d.seconds, 17);
    assert.strictEqual(d.cpuMs, 57000);
    assert.strictEqual(d.fallback, null);
    assert.strictEqual(d.supervisorVersion, 'a1d27db9');
    assert.ok(d.readyAt instanceof Date);
});

test('a crash restore and a new supervisor after a container restart each give a record', async () => {
    files[EVOL.serverId] = state(3, { kind: 'crash-restore' });
    await recorder.tick(deps());
    files[EVOL.serverId] = state(1, { kind: 'start-restore', supStart: T0 + HOUR });
    await recorder.tick(deps());
    assert.deepStrictEqual([...records.values()].map(d => d.kind), ['crash-restore', 'start-restore']);
});

test('a boot that is not ready yet and a server without a supervisor give no record', async () => {
    files[EVOL.serverId] = state(2, { ready: false });
    assert.strictEqual(await recorder.tick(deps()), 0);
    assert.strictEqual(records.size, 0);
});

test('a failed write is tried again at the next pass; a VU restart rewrites nothing', async () => {
    files[EVOL.serverId] = state(4);
    failWrites = true;
    assert.strictEqual(await recorder.tick(deps()), 0);
    failWrites = false;
    assert.strictEqual(await recorder.tick(deps()), 1);
    recorder.lastSeen.clear();
    assert.strictEqual(await recorder.tick(deps()), 0, 'the upsert finds the record');
    assert.strictEqual(records.size, 1);
});
