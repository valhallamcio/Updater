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
