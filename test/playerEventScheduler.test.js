/*
 * Unit tests for the phase-9 ops path in schedulers/playerEventScheduler.js.
 * Run: npm test   (node --test test/)
 *
 * player_trigger jobs can now fire through the biforesting link (run_command ops with
 * captured output) behind config.yggdrasilOps.useOpsApi. The hard rule: an op that FAILED
 * still RAN on the backend — it must never be re-run via Pterodactyl (double-execution),
 * while transport-level failures (no session, createOp throw) fall back for the remaining
 * commands. Old jobs without discord context run fine and just skip the report.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const scheduler = require('../schedulers/playerEventScheduler');
const yggdrasil = require('../modules/yggdrasil');
const pterodactyl = require('../modules/pterodactyl');
const functions = require('../modules/functions');
const mongo = require('../modules/mongo');

const SERVER = { tag: 'gtnh', name: 'GT New Horizons', serverId: 'ptero-1' };
// The module's own waitOp, held before any test swaps it for a stub.
const realWaitOp = yggdrasil.waitOp;

let sent; // pterodactyl.sendCommand calls
let ops; // yggdrasil.runOp calls
let deactivated;
let updates; // mongo.updateScheduleJob calls, in order
let writes; // every job write, by name, in the order it was issued
let claims; // mongo.claimScheduleJob calls
let claimMatched; // what the claim answers: 1 = still active, 0 = cancelled first

beforeEach(() => {
    sent = [];
    ops = [];
    deactivated = [];
    updates = [];
    writes = [];
    claims = [];
    claimMatched = 1;
    functions.sleep = async () => {};
    pterodactyl.sendCommand = async (serverId, cmd) => sent.push({ serverId, cmd });
    mongo.claimScheduleJob = async (id) => { claims.push(id); writes.push('claim'); return { matchedCount: claimMatched, modifiedCount: claimMatched }; };
    mongo.updateScheduleJob = async (id, data) => { updates.push({ id, data }); writes.push('update'); };
    mongo.deactivateScheduleJob = async (id) => { deactivated.push(id); writes.push('deactivate'); };
    yggdrasil.getServers = async () => [SERVER];
    yggdrasil.getLinkSession = async () => ({ sessionId: 's1' });
    scheduler.opsConfig = () => ({ useOpsApi: true });
});

function trigger(extra = {}) {
    return { _id: 't1', playerId: 'Alp', commands: ['say one', 'say two'], oneTime: false, ...extra };
}

test('flag off: classic pterodactyl path, no ops involved', async () => {
    scheduler.opsConfig = () => ({ useOpsApi: false });
    yggdrasil.runOp = async () => { throw new Error('must not be called'); };
    const results = await scheduler.runCommands(trigger(), SERVER);
    assert.deepStrictEqual(sent.map(s => s.cmd), ['say one', 'say two']);
    assert.ok(results.every(r => r.via === 'pterodactyl'));
});

test('flag on + linked: one run_command op per command, ptero untouched, output captured', async () => {
    yggdrasil.runOp = async (server, op) => {
        ops.push({ server, command: op.params.command });
        return { state: 'completed', result: { data: { output: `did ${op.params.command}` } } };
    };
    const results = await scheduler.runCommands(trigger(), SERVER);
    assert.deepStrictEqual(ops.map(o => o.command), ['say one', 'say two']);
    assert.strictEqual(sent.length, 0, 'no console fallback when ops succeed');
    assert.deepStrictEqual(results.map(r => [r.via, r.state, r.output]), [
        ['link', 'completed', 'did say one'],
        ['link', 'completed', 'did say two'],
    ]);
});

test('a FAILED op is reported but never re-run via ptero (double-execution guard)', async () => {
    yggdrasil.runOp = async (server, op) => {
        ops.push(op.params.command);
        return op.params.command === 'say one'
            ? { state: 'failed', result: { error: 'boom' } }
            : { state: 'completed', result: { data: { output: 'ok' } } };
    };
    const results = await scheduler.runCommands(trigger(), SERVER);
    assert.strictEqual(sent.length, 0, 'failed op = command already ran on the backend');
    assert.deepStrictEqual(results.map(r => r.state), ['failed', 'completed']);
});

test('transport failure mid-chain falls back to ptero for that + the remaining commands', async () => {
    let calls = 0;
    yggdrasil.runOp = async () => {
        calls++;
        throw new Error('createOp timed out');
    };
    const results = await scheduler.runCommands(trigger(), SERVER);
    assert.strictEqual(calls, 1, 'ops path abandoned after the first transport failure');
    assert.deepStrictEqual(sent.map(s => s.cmd), ['say one', 'say two'], 'both commands delivered via console');
    assert.ok(results.every(r => r.via === 'pterodactyl'));
});

test('no link session: silently uses the classic path even with the flag on', async () => {
    yggdrasil.getLinkSession = async () => null;
    yggdrasil.runOp = async () => { throw new Error('must not be called'); };
    await scheduler.runCommands(trigger(), SERVER);
    assert.strictEqual(sent.length, 2);
});

test('legacy job without discord context skips the report without throwing', async () => {
    await scheduler.reportResults(trigger(), SERVER, [{ command: 'say one', via: 'link', state: 'completed', output: '' }]);
    // and classic-path results never report at all, even with a channel stored
    await scheduler.reportResults(
        trigger({ discord: { channelId: 'c1' } }),
        SERVER,
        [{ command: 'say one', via: 'pterodactyl', state: 'sent', output: '' }],
    );
});

test('the results are persisted on the job BEFORE it is deactivated', async () => {
    // A job writer settles off `results` (the proxy's cake bank refunds on a
    // failed one), and `deactivateScheduleJob` is what makes the job readable
    // as finished - so the results have to be on the document first.
    yggdrasil.runOp = async (server, op) => ({
        state: 'completed',
        result: { data: { output: `ran ${op.params.command}` } }
    });
    await scheduler.executePlayerTrigger(trigger({ _id: 'job-1', commands: ['give Alp minecraft:cake 2'], oneTime: true }), 'gtnh');

    assert.deepStrictEqual(writes, ['claim', 'update', 'deactivate'], 'the order is the whole point');
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].id, 'job-1');
    assert.ok(updates[0].data.executedAt instanceof Date);
    assert.deepStrictEqual(updates[0].data.results, [{
        command: 'give Alp minecraft:cake 2',
        via: 'link',
        state: 'completed',
        output: 'ran give Alp minecraft:cake 2'
    }]);
});

test('a failed command is persisted as failed, with the backend output on it', async () => {
    yggdrasil.runOp = async () => ({ state: 'failed', result: { error: 'No player was found' } });
    await scheduler.executePlayerTrigger(trigger({ _id: 'job-2', commands: ['give Ghost minecraft:cake 2'] }), 'gtnh');

    assert.deepStrictEqual(updates[0].data.results.map(r => [r.state, r.output]), [['failed', 'No player was found']]);
    assert.deepStrictEqual(deactivated, [], 'a job that is not oneTime stays active');
});

test('oneTime deactivates after the ops path; in-flight guard blocks the overlapping tick', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    let getServersCalls = 0;
    yggdrasil.getServers = async () => { getServersCalls++; return [SERVER]; };
    yggdrasil.runOp = async (server, op) => {
        await gate; // hold the first execution mid-flight
        return { state: 'completed', result: { data: { output: '' } } };
    };
    const t = trigger({ oneTime: true });
    const first = scheduler.executePlayerTrigger(t, 'gtnh');
    await new Promise(r => setTimeout(r, 20));
    await scheduler.executePlayerTrigger(t, 'gtnh'); // overlapping tick — must no-op
    assert.strictEqual(getServersCalls, 1, 'second invocation skipped while in flight');
    release();
    await first;
    assert.deepStrictEqual(deactivated, ['t1'], 'oneTime deactivated exactly once');
});

test('a job cancelled before the claim runs nothing and touches nothing', async () => {
    // The proxy's cake bank flips `active` off when a job sat unrun for its
    // whole refund window and gives the cake back. A run after that pays twice.
    claimMatched = 0;
    yggdrasil.runOp = async () => { throw new Error('must not run'); };
    await scheduler.executePlayerTrigger(trigger({ _id: 'job-3', commands: ['give Alp minecraft:cake 2'], oneTime: true }), 'gtnh');

    assert.deepStrictEqual(claims, ['job-3']);
    assert.deepStrictEqual(sent, [], 'no console command');
    assert.deepStrictEqual(updates, [], 'no results written');
    assert.deepStrictEqual(deactivated, [], 'nothing to deactivate - the canceller already did');
});

test('a results write that throws still deactivates a oneTime job', async () => {
    // The commands already ran on the backend. Leaving the job active would
    // run them again on the next tick, which is the one thing that may never
    // happen - so the persistence failure is logged and the job still closes.
    yggdrasil.runOp = async (server, op) => ({ state: 'completed', result: { data: { output: '' } } });
    mongo.updateScheduleJob = async () => { writes.push('update'); throw new Error('mongo hiccup'); };
    await scheduler.executePlayerTrigger(trigger({ _id: 'job-4', commands: ['give Alp minecraft:cake 2'], oneTime: true }), 'gtnh');

    assert.deepStrictEqual(writes, ['claim', 'update', 'deactivate']);
    assert.deepStrictEqual(deactivated, ['job-4']);
});

// ---------------------------------------------------------------------------
// Instance-addressed jobs (the proxy's cake bank names ONE instance)
// ---------------------------------------------------------------------------

const IL2_PUB = { tag: 'il2', name: 'Infinity Legacy II', serverId: 'ptero-il2-pub' };
const IL2_SUP = { tag: 'il2', name: 'Infinity Legacy II SUP', serverId: 'ptero-il2-sup' };

function il2Rig(instanceOfAlp) {
    yggdrasil.getServers = async () => [SERVER, IL2_PUB, IL2_SUP];
    yggdrasil.getPlayers = async () => ({ il2: ['Alp'] });
    yggdrasil.getPlayersDetailed = async () => ({
        il2: [{ username: 'Alp', server: 'Infinity Legacy II', instance: instanceOfAlp, ping: 20 }]
    });
}

test('findServer: a tag names the pack, a name or a Pterodactyl id names one instance', () => {
    const servers = [SERVER, IL2_PUB, IL2_SUP];
    assert.deepStrictEqual(scheduler.findServer(servers, 'il2'), { server: IL2_PUB, byInstance: false });
    assert.deepStrictEqual(scheduler.findServer(servers, ' infinity legacy ii sup '), { server: IL2_SUP, byInstance: true });
    assert.deepStrictEqual(scheduler.findServer(servers, 'ptero-il2-sup'), { server: IL2_SUP, byInstance: true });
    assert.strictEqual(scheduler.findServer(servers, 'nowhere'), null);
});

test('a job addressed to one instance waits while the player stands on the sibling', async () => {
    // The console path cannot see a failed `give`. Running the job on the
    // instance the player is NOT on would drop nothing and still count as run.
    il2Rig('Infinity Legacy II');
    mongo.getActiveScheduleJobs = async () => [
        { _id: 'job-5', playerId: 'Alp', serverNames: ['Infinity Legacy II SUP'], commands: ['give Alp minecraft:cake 2'], onJoin: false, oneTime: true }
    ];
    let ran = 0;
    const original = scheduler.executePlayerTrigger;
    scheduler.executePlayerTrigger = async () => { ran++; };
    try {
        await scheduler.checkPlayerTriggers();
        assert.strictEqual(ran, 0, 'the SUP job does not fire while Alp is on the public instance');

        il2Rig('Infinity Legacy II SUP');
        await scheduler.checkPlayerTriggers();
        assert.strictEqual(ran, 1, 'and fires once Alp is on SUP');
    } finally {
        scheduler.executePlayerTrigger = original;
    }
});

test('a job addressed by Pterodactyl id resolves the same way', async () => {
    il2Rig('ptero-il2-sup');
    mongo.getActiveScheduleJobs = async () => [
        { _id: 'job-6', playerId: 'Alp', serverNames: ['ptero-il2-sup', 'Infinity Legacy II SUP'], commands: ['say hi'], onJoin: false, oneTime: true }
    ];
    const targets = [];
    const original = scheduler.executePlayerTrigger;
    scheduler.executePlayerTrigger = async (trigger, serverName) => { targets.push(serverName); };
    try {
        await scheduler.checkPlayerTriggers();
        assert.deepStrictEqual(targets, ['ptero-il2-sup'], 'one run, on the first identifier that matched');
    } finally {
        scheduler.executePlayerTrigger = original;
    }

    yggdrasil.runOp = async () => ({ state: 'completed', result: { data: { output: '' } } });
    await scheduler.executePlayerTrigger(trigger({ _id: 'job-6', oneTime: true, commands: ['say hi'] }), 'ptero-il2-sup');
    assert.deepStrictEqual(deactivated, ['job-6'], 'executePlayerTrigger finds the instance by id too');
});

test('a tag-addressed job still fires on any instance of the pack', async () => {
    il2Rig('Infinity Legacy II');
    mongo.getActiveScheduleJobs = async () => [
        { _id: 'job-7', playerId: 'Alp', serverNames: ['il2'], commands: ['say hi'], onJoin: false, oneTime: true }
    ];
    let ran = 0;
    const original = scheduler.executePlayerTrigger;
    scheduler.executePlayerTrigger = async () => { ran++; };
    try {
        await scheduler.checkPlayerTriggers();
        assert.strictEqual(ran, 1);
    } finally {
        scheduler.executePlayerTrigger = original;
    }
});

test('a oneTime job is claimed once only', async () => {
    yggdrasil.runOp = async () => ({ state: 'completed', result: { data: { output: '' } } });
    const onceFlags = [];
    mongo.claimScheduleJob = async (id, once) => { onceFlags.push(once); return { matchedCount: 1, modifiedCount: 1 }; };
    await scheduler.executePlayerTrigger(trigger({ _id: 'job-8', oneTime: true, commands: ['say hi'] }), 'gtnh');
    await scheduler.executePlayerTrigger(trigger({ _id: 'job-9', oneTime: false, commands: ['say hi'] }), 'gtnh');
    assert.deepStrictEqual(onceFlags, [true, false]);
});

// ---------------------------------------------------------------------------
// The cake bank's `give` spec: one give_item op, the console only as a fallback
// ---------------------------------------------------------------------------

const CAKE_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function giveTrigger(extra = {}) {
    return {
        _id: 'job-g', playerId: 'Alp', oneTime: true,
        commands: ['give Alp minecraft:cake 36'],
        give: { item: 'minecraft:cake', count: 100, overflow: 'fail' },
        cake: { uuid: CAKE_UUID, amount: 100, fallbackAmount: 36 },
        ...extra
    };
}

let opCalls; // every yggdrasil op call, by name, in order

/**
 * Stubs the op API. `wait`, `cancel` and `get` are the answers (an Error is thrown).
 * The run_command fallback goes through `runOp` and is recorded in `ops`.
 */
function opRig({ created = { state: 'pending', attempts: 0 }, createThrows = null, wait = null, cancel = null, get = null } = {}) {
    opCalls = [];
    yggdrasil.createOp = async (server, op) => {
        opCalls.push({ call: 'create', server, op });
        if (createThrows) throw createThrows;
        return { op: { _id: 'OPG', ...created }, replayed: false };
    };
    yggdrasil.waitOp = async (opId, ms, until) => {
        opCalls.push({ call: 'wait', opId, ms, until });
        if (wait instanceof Error) throw wait;
        return wait;
    };
    yggdrasil.cancelOp = async (opId) => {
        opCalls.push({ call: 'cancel', opId });
        if (cancel instanceof Error) throw cancel;
        return cancel;
    };
    yggdrasil.getOp = async (opId) => {
        opCalls.push({ call: 'get', opId });
        if (get instanceof Error) throw get;
        return get;
    };
    yggdrasil.runOp = async (server, op) => {
        ops.push(op.params.command);
        return { state: 'completed', result: { data: { output: '' } } };
    };
}

const calls = (name) => opCalls.filter(c => c.call === name);
const GIVE_BASE = { via: 'link', op: 'give_item', opId: 'OPG', requested: 100 };
const FALLBACK_ROW = { command: 'give Alp minecraft:cake 36', via: 'link', state: 'completed', output: '' };

test('give: flag off runs the console fallback and never creates an op', async () => {
    scheduler.opsConfig = () => ({ useOpsApi: false });
    opRig();
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(calls('create'), []);
    assert.deepStrictEqual(sent.map(s => s.cmd), ['give Alp minecraft:cake 36']);
    assert.deepStrictEqual(rows, [{ command: 'give Alp minecraft:cake 36', via: 'pterodactyl', state: 'sent', output: '' }]);
});

test('give: no link session for the INSTANCE runs the console fallback', async () => {
    const asked = [];
    yggdrasil.getLinkSession = async (ref) => { asked.push(ref); return null; };
    opRig();
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(asked[0], 'ptero-1', 'the session is looked up by Pterodactyl id, never the tag');
    assert.deepStrictEqual(calls('create'), []);
    assert.deepStrictEqual(rows.map(r => r.via), ['pterodactyl']);

    yggdrasil.getLinkSession = async () => { throw new Error('yggdrasil down'); };
    sent = [];
    opRig();
    const again = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(calls('create'), [], 'a session lookup that throws is no session');
    assert.deepStrictEqual(again.map(r => r.via), ['pterodactyl']);
});

test('give: the op is one give_item addressed to the instance, by uuid and name, replay-safe', async () => {
    opRig({ wait: { _id: 'OPG', state: 'completed', attempts: 1, result: { ok: true, data: { given: 100, requested: 100, full: false } } } });
    await scheduler.runGive(giveTrigger(), SERVER);
    const [create] = calls('create');
    assert.strictEqual(create.server, 'ptero-1', 'two instances can share the tag');
    assert.deepStrictEqual(create.op, {
        type: 'give_item',
        params: { id: 'minecraft:cake', count: 100, overflow: 'fail' },
        target: { uuid: CAKE_UUID, name: 'Alp' },
        expiresInMs: 60000,
        execTimeoutMs: 120000,
        idempotencyKey: 'cakebank:job-g'
    });
    const [wait] = calls('wait');
    assert.strictEqual(wait.ms, 75000, 'the wait outlasts the 60 s expiry and a 15 s sweep');
    assert.deepStrictEqual(wait.until, ['completed', 'failed', 'expired', 'cancelled', 'waiting_player']);

    opRig({ wait: { _id: 'OPG', state: 'completed', attempts: 1, result: { data: { given: 1 } } } });
    await scheduler.runGive(giveTrigger({ cake: { amount: 100 } }), SERVER);
    assert.deepStrictEqual(calls('create')[0].op.target, { name: 'Alp' }, 'no uuid on the job: the name alone');
});

test('give: completed writes the backend\'s count and runs nothing else', async () => {
    opRig({ wait: { _id: 'OPG', state: 'completed', attempts: 1, result: { ok: true, data: { player: 'Alp', requested: 100, given: 36, full: true } } } });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'completed', given: 36, full: true }]);
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(ops, [], 'no fallback command of any kind');
    assert.deepStrictEqual(calls('cancel'), []);
});

test('give: an op already finished in the create answer is not waited on', async () => {
    opRig({ created: { state: 'completed', attempts: 1, result: { data: { given: 100, full: false } } } });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(calls('wait'), []);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'completed', given: 100, full: false }]);
});

test('give: a completed op with no count is unknown and runs nothing else', async () => {
    opRig({ wait: { _id: 'OPG', state: 'completed', attempts: 1, result: { data: {} } } });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'unknown' }]);
    assert.deepStrictEqual(ops, []);
});

test('give: createOp that throws means no op exists, so the fallback runs', async () => {
    opRig({ createThrows: new Error('400 bad params') });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(calls('wait'), []);
    assert.deepStrictEqual(ops, ['give Alp minecraft:cake 36']);
    assert.deepStrictEqual(rows, [FALLBACK_ROW]);
});

test('give: a failed op writes given 0 with the error, then the fallback', async () => {
    opRig({ wait: { _id: 'OPG', state: 'failed', attempts: 1, result: { ok: false, error: 'unknown item tfc:cake' } } });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'failed', given: 0, error: 'unknown item tfc:cake' }, FALLBACK_ROW]);
});

test('give: an op that expired or was cancelled before any dispatch falls back', async () => {
    for (const state of ['expired', 'cancelled']) {
        ops = [];
        opRig({ wait: { _id: 'OPG', state, attempts: 0 } });
        const rows = await scheduler.runGive(giveTrigger(), SERVER);
        assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state, given: 0, dispatched: false }, FALLBACK_ROW], state);
    }
});

test('give: an op that expired AFTER a dispatch is unknown, with no fallback', async () => {
    opRig({ wait: { _id: 'OPG', state: 'expired', attempts: 2 } });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'unknown' }]);
    assert.deepStrictEqual(ops, []);
    assert.deepStrictEqual(sent, []);
});

test('give: waiting_player is cancelled, and a cancel with no dispatch since gives nothing and runs nothing', async () => {
    // The player left the instance. A console give cannot reach them either, and a
    // blind console row would read as delivered, so the proxy refunds the lot.
    opRig({
        wait: { _id: 'OPG', state: 'waiting_player', attempts: 1 },
        cancel: { _id: 'OPG', state: 'cancelled', attempts: 1 }
    });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(calls('cancel').map(c => c.opId), ['OPG']);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'cancelled', given: 0, offline: true }]);
    assert.deepStrictEqual(ops, [], 'no run_command fallback');
    assert.strictEqual(sent.length, 0, 'and no console fallback');
});

test('give: waiting_player re-dispatched before the cancel is unknown, with no fallback', async () => {
    // The player came back, Yggdrasil sent the op again, and the cancel caught it
    // in `dispatched`. The mod may run it.
    opRig({
        wait: { _id: 'OPG', state: 'waiting_player', attempts: 1 },
        cancel: { _id: 'OPG', state: 'cancelled', attempts: 2 }
    });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'unknown' }]);
    assert.deepStrictEqual(ops, []);
});

test('give: waiting_player whose cancel is refused reads the op again', async () => {
    opRig({
        wait: { _id: 'OPG', state: 'waiting_player', attempts: 1 },
        cancel: new Error('409 op is acked'),
        get: { _id: 'OPG', state: 'completed', attempts: 2, result: { data: { given: 3, full: true } } }
    });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'completed', given: 3, full: true }]);
    assert.deepStrictEqual(ops, []);
});

test('give: a timeout whose cancel lands on a never-sent op falls back', async () => {
    opRig({ wait: new Error('op OPG not in ... after 75000ms'), cancel: { _id: 'OPG', state: 'cancelled', attempts: 0 } });
    const rows = await scheduler.runGive(giveTrigger(), SERVER);
    assert.deepStrictEqual(calls('cancel').length, 1);
    assert.deepStrictEqual(rows, [{ ...GIVE_BASE, state: 'cancelled', given: 0, dispatched: false }, FALLBACK_ROW]);
});

test('give: a timeout on an op that was sent is unknown, whatever the cancel says', async () => {
    // Cancelled while `dispatched`: the mod may still run it.
    opRig({ wait: new Error('timeout'), cancel: { _id: 'OPG', state: 'cancelled', attempts: 1 } });
    assert.deepStrictEqual(await scheduler.runGive(giveTrigger(), SERVER), [{ ...GIVE_BASE, state: 'unknown' }]);

    // Acked: the cancel is refused, and the op is still running.
    opRig({ wait: new Error('timeout'), cancel: new Error('409'), get: { _id: 'OPG', state: 'acked', attempts: 1 } });
    assert.deepStrictEqual(await scheduler.runGive(giveTrigger(), SERVER), [{ ...GIVE_BASE, state: 'unknown' }]);

    // Yggdrasil unreachable: nothing is known.
    opRig({ wait: new Error('timeout'), cancel: new Error('ECONNRESET'), get: new Error('ECONNRESET') });
    assert.deepStrictEqual(await scheduler.runGive(giveTrigger(), SERVER), [{ ...GIVE_BASE, state: 'unknown' }]);

    assert.deepStrictEqual(ops, [], 'no fallback in any of the three');
    assert.deepStrictEqual(sent, []);
});

test('give: executePlayerTrigger routes a give job through runGive and persists its rows first', async () => {
    opRig({ wait: { _id: 'OPG', state: 'completed', attempts: 1, result: { data: { given: 36, full: true } } } });
    await scheduler.executePlayerTrigger(giveTrigger({ _id: 'job-g2' }), 'gtnh');
    assert.deepStrictEqual(writes, ['claim', 'update', 'deactivate']);
    assert.deepStrictEqual(updates[0].data.results, [{ ...GIVE_BASE, state: 'completed', given: 36, full: true }]);
    assert.deepStrictEqual(calls('create')[0].op.idempotencyKey, 'cakebank:job-g2');
    assert.deepStrictEqual(ops, [], 'the console commands on the job never ran');
});

test('give: the result embed reads give rows next to command rows', async () => {
    const posted = [];
    const botPath = require.resolve('../discord/bot');
    const held = require.cache[botPath];
    require.cache[botPath] = {
        id: botPath, filename: botPath, loaded: true,
        exports: { getClient: async () => ({ channels: { fetch: async () => ({ send: async (msg) => posted.push(msg) }) } }) }
    };
    try {
        await scheduler.reportResults(giveTrigger({ discord: { channelId: 'c1' } }), SERVER, [
            { ...GIVE_BASE, state: 'failed', given: 0, error: 'unknown item' },
            { command: 'give Alp minecraft:cake 36', via: 'link', state: 'completed', output: 'Gave 36' },
        ]);
    } finally {
        if (held) require.cache[botPath] = held; else delete require.cache[botPath];
    }
    assert.strictEqual(posted.length, 1, 'a give row without `command` must not break the embed');
    const fields = posted[0].embeds[0].fields;
    assert.match(fields[0].name, /give_item OPG/);
    assert.strictEqual(fields[0].value, 'unknown item');
    assert.match(fields[1].value, /Gave 36/);
});

test('waitOp: resolves on the WS event for ITS op in a wanted state, and times out otherwise', async () => {
    const noop = () => {};
    const emitter = yggdrasil.on('noop', noop); // EventEmitter#on hands back the emitter itself
    yggdrasil.off('noop', noop);
    const gets = [];
    yggdrasil.getOp = async (id) => { gets.push(id); return { _id: id, state: 'waiting_player', attempts: 1 }; };

    const pending = realWaitOp('OPW', 2000, ['completed', 'waiting_player']);
    emitter.emit('biforesting.op.updated', { opId: 'OTHER', state: 'waiting_player' });
    emitter.emit('biforesting.op.updated', { opId: 'OPW', state: 'acked' });
    assert.deepStrictEqual(gets, [], 'another op, or a state nobody waits for, reads nothing');
    emitter.emit('biforesting.op.updated', { opId: 'OPW', state: 'waiting_player' });
    const doc = await pending;
    assert.deepStrictEqual(gets, ['OPW'], 'the doc is read back once the event says so');
    assert.strictEqual(doc.state, 'waiting_player');

    await assert.rejects(realWaitOp('OPX', 20), /OPX not in completed\/failed\/expired\/cancelled after 20ms/);
});

// ---------------------------------------------------------------------------
// runCommands: a run_command op that may still fire is never run twice
// ---------------------------------------------------------------------------

/** A runOp timeout the way waitOp throws it: the op exists, with no answer yet. */
function opTimeout(opId) {
    const err = new Error(`op ${opId} not in completed/failed/expired/cancelled after 15000ms`);
    err.opId = opId;
    return err;
}

function commandRig({ run, cancel = null, get = null }) {
    const seen = { run: [], cancel: [], get: [] };
    yggdrasil.runOp = async (server, op, ms) => { seen.run.push({ server, op, ms }); return run(op.params.command); };
    yggdrasil.cancelOp = async (opId) => { seen.cancel.push(opId); if (cancel instanceof Error) throw cancel; return cancel; };
    yggdrasil.getOp = async (opId) => { seen.get.push(opId); if (get instanceof Error) throw get; return get; };
    return seen;
}

test('run_command ops are addressed by Pterodactyl id and expire when nothing dispatches them', async () => {
    const seen = commandRig({ run: () => ({ state: 'completed', result: { data: { output: '' } } }) });
    await scheduler.runCommands(trigger(), SERVER);
    assert.deepStrictEqual(seen.run.map(r => r.server), ['ptero-1', 'ptero-1'], 'a tag can name two instances');
    assert.ok(seen.run.every(r => r.op.expiresInMs === 60000), 'with the ops bit off, an op must not wait for the day it turns on');
});

test('a timed-out run_command op whose cancel lands unsent goes by console, with the rest', async () => {
    // The policy `ops` bit is off: the op sat as `pending`. Cancelled with no dispatch,
    // it can never fire later, so the console may run the line.
    const seen = commandRig({ run: () => { throw opTimeout('OPC'); }, cancel: { _id: 'OPC', state: 'cancelled', attempts: 0 } });
    const results = await scheduler.runCommands(trigger(), SERVER);
    assert.deepStrictEqual(seen.cancel, ['OPC']);
    assert.strictEqual(seen.run.length, 1, 'the link is abandoned after the first unsent op');
    assert.deepStrictEqual(sent.map(s => s.cmd), ['say one', 'say two']);
    assert.ok(results.every(r => r.via === 'pterodactyl'));
});

test('a timed-out run_command op that was sent is unknown, and the console never runs it', async () => {
    // Cancel refused: the backend acked it. It may run, so nothing runs the line again.
    let n = 0;
    const seen = commandRig({
        run: (command) => { n++; if (n === 1) throw opTimeout('OPC'); return { state: 'completed', result: { data: { output: `did ${command}` } } }; },
        cancel: new Error('409 too late to cancel'),
        get: { _id: 'OPC', state: 'acked', attempts: 1 }
    });
    const results = await scheduler.runCommands(trigger(), SERVER);
    assert.deepStrictEqual(seen.get, ['OPC']);
    assert.strictEqual(sent.length, 0, 'no console run of a line that may have run');
    assert.deepStrictEqual(results.map(r => [r.command, r.via, r.state]), [
        ['say one', 'link', 'unknown'],
        ['say two', 'link', 'completed'],
    ]);
    assert.strictEqual(results[0].opId, 'OPC');
});

test('a run_command op that expired before any dispatch goes by console; one that expired after is unknown', async () => {
    commandRig({ run: () => ({ _id: 'OPX', state: 'expired', attempts: 0 }) });
    let results = await scheduler.runCommands(trigger(), SERVER);
    assert.deepStrictEqual(sent.map(s => s.cmd), ['say one', 'say two']);
    assert.ok(results.every(r => r.via === 'pterodactyl'));

    sent.length = 0;
    commandRig({ run: () => ({ _id: 'OPX', state: 'expired', attempts: 1 }) });
    results = await scheduler.runCommands(trigger(), SERVER);
    assert.strictEqual(sent.length, 0);
    assert.deepStrictEqual(results.map(r => r.state), ['unknown', 'unknown']);
});

test('waitOp puts the op id on its timeout, so the caller can cancel that exact op', async () => {
    const saved = { getOp: yggdrasil.getOp };
    yggdrasil.getOp = async () => ({ _id: 'OPW', state: 'pending' });
    try {
        await assert.rejects(realWaitOp('OPW', 20), (err) => err.opId === 'OPW');
    } finally {
        yggdrasil.getOp = saved.getOp;
    }
});
