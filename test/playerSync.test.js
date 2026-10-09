/*
 * Unit tests for modules/playerSync.js: the move freeze around updates and restores, and the
 * reseed after a restore (bifrost-lib docs/invariants/player-sync.md 6.6 and 7).
 * Run: npm test
 *
 * Yggdrasil and the panel are fakes injected as parameters. Nothing here reaches a real
 * panel or a real Yggdrasil.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createPlayerSync, sharedGroup } = require('../modules/playerSync');
const updateManager = require('../managers/updateManager');

const IDS = ['aaaa1111', 'bbbb2222'];
const SERVERS = [
    { tag: 'evol', serverId: 'aaaa1111', group: 'evol' },
    { tag: 'evol', serverId: 'bbbb2222', group: 'evol' },
    { tag: 'gtnh', serverId: 'cccc3333', group: '' }
];
const READY = [
    { serverId: 'aaaa1111', live: true, fp: 'fp2', fpMatch: true },
    { serverId: 'bbbb2222', live: true, fp: 'fp2', fpMatch: true }
];
const NOT_LINKED = [
    { serverId: 'aaaa1111', live: false, fp: null, fpMatch: false },
    { serverId: 'bbbb2222', live: false, fp: null, fpMatch: false }
];
const FP_DIFFER = [
    { serverId: 'aaaa1111', live: true, fp: 'fp1', fpMatch: false },
    { serverId: 'bbbb2222', live: true, fp: 'fp2', fpMatch: false }
];

function axiosError(status, code) {
    const error = new Error(`Request failed with status code ${status}`);
    error.response = { status, data: { error: { code, message: code } } };
    return error;
}

/**
 * A stand-in for the Yggdrasil sync routes. calls records every request in order.
 * opts: mode, frozen, freezeReason, instances(state), down, missing, putFails, beforeReseed(state), movesStuck.
 */
function fakeYggdrasil(opts = {}) {
    const calls = [];
    const state = {
        mode: opts.mode || 'live',
        frozen: opts.frozen || false,
        freezeReason: opts.freezeReason || null,
        gets: 0
    };
    const instances = opts.instances || (() => READY);
    const view = () => ({ group: 'evol', mode: state.mode, frozen: state.frozen, freezeReason: state.freezeReason });
    const http = {
        async get(url, config) {
            assert.strictEqual(config.headers['X-Actor'], 'valhalla-updater');
            assert.ok(config.timeout > 0, 'every request has a timeout');
            calls.push(`GET ${url}`);
            if (opts.down) throw new Error('connect ECONNREFUSED');
            if (opts.missing) throw axiosError(404, 'not_found');
            state.gets++;
            return { data: { data: { ...view(), instances: instances(state) } } };
        },
        async put(url, body, config) {
            assert.ok(config.timeout > 0, 'every request has a timeout');
            calls.push(`PUT ${url} frozen=${body.frozen}`);
            if (opts.putFails) throw new Error('timeout of 10000ms exceeded');
            state.frozen = body.frozen;
            state.freezeReason = body.freezeReason;
            return { data: { data: view() } };
        },
        async post(url, body, config) {
            assert.ok(config.timeout > 0, 'every request has a timeout');
            calls.push(`POST ${url} ${body.serverId}`);
            if (opts.beforeReseed) opts.beforeReseed(state);
            if (!state.frozen) throw axiosError(409, 'not_frozen');
            const stuck = opts.movesStuck || [];
            return { data: { data: { group: 'evol', serverId: body.serverId, movesAborted: ['m1'], movesStuck: stuck, trusted: 4, disownsQueued: 2, disownBatches: 1 } } };
        }
    };
    return { http, calls, state };
}

/** A client on a fake clock: sleep moves the clock, so a 15 min wait takes no real time. */
function makeSync(fake, servers = SERVERS) {
    let clock = 0;
    const errors = [];
    const sync = createPlayerSync({
        http: fake.http,
        listServers: async () => servers,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        pollMs: 15000,
        unfreezeWaitMs: 15 * 60000,
        log: { info() {}, warn() {}, debug() {}, error: (tag, msg) => errors.push(msg) }
    });
    return { sync, errors, elapsed: () => clock };
}

function progress() {
    const lines = [];
    return { lines, report: async (text) => { lines.push(text); }, text: () => lines.join('') };
}

const changing = calls => calls.filter(c => !c.startsWith('GET'));

test('sharedGroup: only one non-empty group shared by every instance counts', () => {
    assert.strictEqual(sharedGroup(SERVERS, IDS), 'evol');
    assert.strictEqual(sharedGroup(SERVERS, ['cccc3333']), null);
    assert.strictEqual(sharedGroup(SERVERS, ['aaaa1111', 'cccc3333']), null);
    assert.strictEqual(sharedGroup([{ serverId: 'aaaa1111' }], ['aaaa1111']), null, 'no group field');
    assert.strictEqual(sharedGroup(SERVERS, ['aaaa1111', 'ffff0000']), null, 'an unknown instance');
});

test('gate: mode off, no sync doc, no shared group or Yggdrasil down change nothing', async () => {
    const cases = [
        ['mode off', { mode: 'off' }, SERVERS],
        ['no sync doc (404)', { missing: true }, SERVERS],
        ['empty group', {}, SERVERS.map(s => ({ ...s, group: '' }))],
        ['different groups', {}, [SERVERS[0], { ...SERVERS[1], group: 'other' }]],
        ['Yggdrasil down', { down: true }, SERVERS]
    ];
    for (const [name, opts, servers] of cases) {
        const fake = fakeYggdrasil(opts);
        const { sync } = makeSync(fake, servers);
        const p = progress();

        const handle = await sync.freezeGroup(IDS, { label: 'evol', reason: 'update evol 1.2', report: p.report });
        assert.strictEqual(handle.frozen, false, name);
        assert.strictEqual(await sync.releaseFreeze(handle, { report: p.report }), false, name);
        assert.strictEqual(await sync.reseedAndRelease(handle, IDS, { report: p.report }), false, name);
        assert.deepStrictEqual(changing(fake.calls), [], `${name}: no call that changes anything`);
        assert.ok(fake.calls.length <= 1, `${name}: at most the one gate check`);
    }
});

test('gate: a tag with no shared group never calls the sync routes', async () => {
    const fake = fakeYggdrasil();
    const { sync } = makeSync(fake);
    const p = progress();
    await sync.freezeGroup(['cccc3333'], { label: 'gtnh', reason: 'update gtnh 2.8', report: p.report });
    assert.deepStrictEqual(fake.calls, []);
    assert.strictEqual(p.text(), '', 'no progress line for a tag outside player sync');
});

test('gate: Yggdrasil down at the check warns in the progress, and the stop goes on', async () => {
    const fake = fakeYggdrasil({ down: true });
    const { sync } = makeSync(fake);
    const p = progress();
    const stopped = [];
    const panel = { shutdown: async (sid) => { stopped.push(sid); } };

    await updateManager._internals.freezeAndShutdown({ tag: 'evol' }, IDS, { reason: 'update evol 1.2' }, p.report, panel, sync);
    assert.deepStrictEqual(stopped, IDS, 'every instance still stops');
    assert.match(p.text(), /Warning: could not check player sync for `evol`/);
    assert.deepStrictEqual(changing(fake.calls), []);
});

test('gate: a freeze that fails warns, the stop goes on, and the release does nothing', async () => {
    const fake = fakeYggdrasil({ putFails: true });
    const { sync } = makeSync(fake);
    const p = progress();
    const stopped = [];
    const panel = { shutdown: async (sid) => { stopped.push(sid); } };

    const handle = await updateManager._internals.freezeAndShutdown({ tag: 'evol' }, IDS, { reason: 'update evol 1.2' }, p.report, panel, sync);
    assert.deepStrictEqual(stopped, IDS);
    assert.strictEqual(handle.frozen, false);
    assert.match(p.text(), /Warning: could not pause moves for `evol`/);
    assert.strictEqual(await sync.releaseFreeze(handle, { report: p.report }), false);
    assert.strictEqual(fake.calls.filter(c => c.startsWith('PUT')).length, 1, 'only the failed freeze');
});

test('update: the freeze comes before the first stop, the unfreeze after every instance is live on one pack', async () => {
    // Gate check, then two polls with the instances still booting, then ready.
    const fake = fakeYggdrasil({ instances: state => (state.gets >= 4 ? READY : state.gets === 1 ? READY : NOT_LINKED) });
    const { sync } = makeSync(fake);
    const p = progress();
    const panel = { shutdown: async (sid) => { fake.calls.push(`shutdown ${sid}`); } };

    const handle = await updateManager._internals.freezeAndShutdown({ tag: 'evol' }, IDS, { reason: 'update evol 1.2' }, p.report, panel, sync);
    assert.strictEqual(handle.frozen, true);
    assert.deepStrictEqual(fake.calls, [
        'GET /biforesting/sync/evol',
        'PUT /biforesting/sync/evol frozen=true',
        'shutdown aaaa1111',
        'shutdown bbbb2222'
    ]);
    assert.strictEqual(fake.state.freezeReason, 'update evol 1.2');

    // The update loop starts the instances and writes the database here.
    fake.calls.length = 0;
    assert.strictEqual(await sync.releaseFreeze(handle, { report: p.report }), true);
    assert.deepStrictEqual(fake.calls, [
        'GET /biforesting/sync/evol',
        'GET /biforesting/sync/evol',
        'GET /biforesting/sync/evol',
        'PUT /biforesting/sync/evol frozen=false'
    ], 'no unfreeze until the poll that saw every instance ready');
    assert.strictEqual(fake.state.frozen, false);
    assert.match(p.text(), /Moves are open again/);
});

test('update: when the instances never match, the group stays frozen and the progress and log say so', async () => {
    const fake = fakeYggdrasil({ instances: () => FP_DIFFER });
    const { sync, errors, elapsed } = makeSync(fake);
    const p = progress();

    const handle = await sync.freezeGroup(IDS, { label: 'evol', reason: 'update evol 1.2', report: p.report });
    assert.strictEqual(await sync.releaseFreeze(handle, { report: p.report }), false);

    assert.ok(elapsed() >= 15 * 60000, 'it waited the full 15 min');
    assert.ok(!fake.calls.includes('PUT /biforesting/sync/evol frozen=false'), 'never unfrozen');
    assert.strictEqual(fake.state.frozen, true);
    assert.match(p.text(), /\*\*Moves stay frozen for `evol`: pack fingerprints differ .* after 15 min\. .*Unfreeze with a staff action/);
    assert.ok(errors.some(e => /moves stay frozen for evol/.test(e)), 'the session log has it too');
});

test('update: a failed deploy leaves the group frozen at once, with no wait', async () => {
    const fake = fakeYggdrasil();
    const { sync, elapsed } = makeSync(fake);
    const p = progress();

    const handle = await sync.freezeGroup(IDS, { label: 'evol', reason: 'update evol 1.2', report: p.report });
    fake.calls.length = 0;
    assert.strictEqual(await sync.releaseFreeze(handle, { report: p.report, stayReason: 'bbbb2222 failed to deploy' }), false);
    assert.deepStrictEqual(fake.calls, []);
    assert.strictEqual(elapsed(), 0);
    assert.match(p.text(), /Moves stay frozen for `evol`: bbbb2222 failed to deploy/);
});

test('update: a staff freeze stays on, and a freeze VU left behind is taken over and lifted', async () => {
    const staff = fakeYggdrasil({ frozen: true, freezeReason: 'staff: dupe check' });
    const s1 = makeSync(staff);
    const p1 = progress();
    const h1 = await s1.sync.freezeGroup(IDS, { label: 'evol', reason: 'update evol 1.2', report: p1.report });
    assert.strictEqual(await s1.sync.releaseFreeze(h1, { report: p1.report }), false);
    assert.deepStrictEqual(changing(staff.calls), [], 'VU neither re-freezes nor lifts a staff freeze');
    assert.match(p1.text(), /already paused \(staff: dupe check\)/);

    const leftover = fakeYggdrasil({ frozen: true, freezeReason: 'update evol 1.1' });
    const s2 = makeSync(leftover);
    const h2 = await s2.sync.freezeGroup(IDS, { label: 'evol', reason: 'update evol 1.2', report: progress().report });
    assert.strictEqual(await s2.sync.releaseFreeze(h2, {}), true);
    assert.deepStrictEqual(changing(leftover.calls), [
        'PUT /biforesting/sync/evol frozen=true',
        'PUT /biforesting/sync/evol frozen=false'
    ]);
});

test('restore: freeze, then reseed each restored instance once it is live, then unfreeze', async () => {
    // Gate check sees the old state. The restored instances link on the third poll.
    const fake = fakeYggdrasil({ instances: state => (state.gets === 1 || state.gets >= 4 ? READY : NOT_LINKED) });
    const { sync } = makeSync(fake);
    const p = progress();
    const panel = { shutdown: async (sid) => { fake.calls.push(`shutdown ${sid}`); } };

    const handle = await updateManager._internals.freezeAndShutdown({ tag: 'evol' }, IDS, { reason: 'restore evol evol_1.1_42.tar.gz', restore: true }, p.report, panel, sync);
    assert.match(p.text(), /restored world is the truth for the players on each restored instance/);

    assert.strictEqual(await sync.reseedAndRelease(handle, IDS, { report: p.report }), true);
    const order = changing(fake.calls).filter(c => !c.startsWith('shutdown'));
    assert.deepStrictEqual(order, [
        'PUT /biforesting/sync/evol frozen=true',
        'POST /biforesting/sync/evol/reseed aaaa1111',
        'POST /biforesting/sync/evol/reseed bbbb2222',
        'PUT /biforesting/sync/evol frozen=false'
    ]);
    const firstReseed = fake.calls.indexOf('POST /biforesting/sync/evol/reseed aaaa1111');
    assert.ok(fake.calls.indexOf('shutdown bbbb2222') < firstReseed);
    assert.strictEqual(fake.calls.slice(firstReseed).filter(c => c.startsWith('GET')).length, 1, 'one readiness poll between the reseeds and the unfreeze');
    assert.match(p.text(), /start the restored instances from the panel/);
    assert.match(p.text(), /Reseeded `aaaa1111`: 4 players trusted, 1 moves aborted, 2 disowns queued\./);
    assert.doesNotMatch(p.text(), /are stuck and need staff/);
    assert.match(p.text(), /Moves are open again/);
});

test('restore: a reseed that leaves stuck moves names them for staff and still unfreezes', async () => {
    const fake = fakeYggdrasil({ movesStuck: ['m7', 'm9'] });
    const { sync } = makeSync(fake);
    const p = progress();
    const panel = { shutdown: async (sid) => { fake.calls.push(`shutdown ${sid}`); } };
    const handle = await updateManager._internals.freezeAndShutdown({ tag: 'evol' }, IDS, { reason: 'restore evol x', restore: true }, p.report, panel, sync);
    assert.strictEqual(await sync.reseedAndRelease(handle, IDS, { report: p.report }), true);
    assert.match(p.text(), /2 move\(s\) on `aaaa1111` are stuck and need staff \(\/instance sync <player>\): m7, m9\./);
    assert.match(p.text(), /Moves are open again/);
});

test('restore: a reseed refused with 409 not_frozen freezes the group again and tries once more', async () => {
    let unfrozenBehindUs = false;
    const fake = fakeYggdrasil({
        beforeReseed: (state) => {
            if (!unfrozenBehindUs) {
                unfrozenBehindUs = true;
                state.frozen = false;
            }
        }
    });
    const { sync } = makeSync(fake);
    const p = progress();

    const handle = await sync.freezeGroup(IDS, { label: 'evol', reason: 'restore evol b.tar.gz', report: p.report, restore: true });
    assert.strictEqual(await sync.reseedAndRelease(handle, IDS, { report: p.report }), true);
    assert.deepStrictEqual(changing(fake.calls), [
        'PUT /biforesting/sync/evol frozen=true',
        'POST /biforesting/sync/evol/reseed aaaa1111',
        'PUT /biforesting/sync/evol frozen=true',
        'POST /biforesting/sync/evol/reseed aaaa1111',
        'POST /biforesting/sync/evol/reseed bbbb2222',
        'PUT /biforesting/sync/evol frozen=false'
    ]);
});

test('restore: a reseed that keeps answering not_frozen leaves the group frozen and says what to do', async () => {
    const fake = fakeYggdrasil({ beforeReseed: (state) => { state.frozen = false; } });
    const { sync, errors } = makeSync(fake);
    const p = progress();

    const handle = await sync.freezeGroup(IDS, { label: 'evol', reason: 'restore evol b.tar.gz', report: p.report, restore: true });
    assert.strictEqual(await sync.reseedAndRelease(handle, IDS, { report: p.report }), false);
    assert.ok(!fake.calls.includes('PUT /biforesting/sync/evol frozen=false'), 'never unfrozen without a reseed');
    assert.strictEqual(fake.calls.filter(c => c.includes('reseed bbbb2222')).length, 0, 'it stops at the first refused instance');
    assert.match(p.text(), /Moves stay frozen for `evol`: the reseed of aaaa1111 failed \(.*HTTP 409 not_frozen\)/);
    assert.match(p.text(), /reseed each one \(POST \/v1\/biforesting\/sync\/evol\/reseed/);
    assert.ok(errors.length > 0);
});

test('restore: instances that never link leave the group frozen with no reseed', async () => {
    const fake = fakeYggdrasil({ instances: () => NOT_LINKED });
    const { sync } = makeSync(fake);
    const p = progress();

    const handle = await sync.freezeGroup(IDS, { label: 'evol', reason: 'restore evol b.tar.gz', report: p.report, restore: true });
    assert.strictEqual(await sync.reseedAndRelease(handle, IDS, { report: p.report }), false);
    assert.strictEqual(fake.calls.filter(c => c.startsWith('POST')).length, 0);
    assert.ok(!fake.calls.includes('PUT /biforesting/sync/evol frozen=false'));
    assert.match(p.text(), /Moves stay frozen for `evol`: aaaa1111, bbbb2222 not linked after 15 min\. The reseed did not run/);
});

test('restore: a failed restore leaves the group frozen and the reseed undone', async () => {
    const fake = fakeYggdrasil();
    const { sync } = makeSync(fake);
    const p = progress();

    const handle = await sync.freezeGroup(IDS, { label: 'evol', reason: 'restore evol b.tar.gz', report: p.report, restore: true });
    fake.calls.length = 0;
    assert.strictEqual(await sync.reseedAndRelease(handle, IDS, { report: p.report, stayReason: 'bbbb2222 could not be restored' }), false);
    assert.deepStrictEqual(fake.calls, []);
    assert.match(p.text(), /bbbb2222 could not be restored\. The reseed did not run/);
});
