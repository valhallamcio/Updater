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

beforeEach(() => {
    sent = [];
    ops = [];
    deactivated = [];
    functions.sleep = async () => {};
    pterodactyl.sendCommand = async (serverId, cmd) => sent.push({ serverId, cmd });
    mongo.deactivateScheduleJob = async (id) => deactivated.push(id);
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
