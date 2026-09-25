/*
 * Unit tests for the link path of discord/commands/execute.js.
 * Run: npm test   (node --test test/)
 *
 * The hard rule: a command that reached the backend over the link must never run
 * again through the console. The op keeps its output in `result.data.output`.
 * Only an op that provably never left Yggdrasil (expired or cancelled, attempts 0)
 * hands the command back to the console.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const yggdrasil = require('../modules/yggdrasil');
const { runViaLink } = require('../discord/commands/execute');

let created; // the op specs sent to runOp
let cancelled;

beforeEach(() => {
    created = [];
    cancelled = [];
    yggdrasil.cancelOp = async (id) => { cancelled.push(id); return null; };
    yggdrasil.getOp = async () => null;
});

test('completed op: the output comes from result.data.output', async () => {
    yggdrasil.runOp = async (server, op) => {
        created.push(op);
        return { _id: 'op1', state: 'completed', attempts: 1, result: { ok: true, data: { output: 'Added Imah__ to the whitelist', value: 1 } } };
    };
    assert.strictEqual(await runViaLink('ptero-1', 'whitelist add Imah__'), 'Added Imah__ to the whitelist');
    assert.strictEqual(created[0].expiresInMs, 60000);
});

test('completed op with no output still counts as run', async () => {
    yggdrasil.runOp = async () => ({ _id: 'op1', state: 'completed', attempts: 1, result: { ok: true, data: { output: '', value: 1 } } });
    assert.strictEqual(await runViaLink('ptero-1', 'save-all'), '(no output)');
});

test('failed op ran on the backend: no console run', async () => {
    yggdrasil.runOp = async () => ({ _id: 'op1', state: 'failed', attempts: 1, result: { ok: false, error: 'Unknown command' } });
    assert.match(await runViaLink('ptero-1', 'nope'), /Command failed: Unknown command/);
});

test('timeout: the op is cancelled, and a cancel before dispatch hands back to the console', async () => {
    yggdrasil.runOp = async () => { const e = new Error('timeout'); e.opId = 'op9'; throw e; };
    yggdrasil.cancelOp = async (id) => { cancelled.push(id); return { _id: id, state: 'cancelled', attempts: 0 }; };
    assert.strictEqual(await runViaLink('ptero-1', 'say hi'), null);
    assert.deepStrictEqual(cancelled, ['op9']);
});

test('timeout after dispatch: no console run', async () => {
    yggdrasil.runOp = async () => { const e = new Error('timeout'); e.opId = 'op9'; throw e; };
    yggdrasil.getOp = async (id) => ({ _id: id, state: 'dispatched', attempts: 1 });
    assert.match(await runViaLink('ptero-1', 'say hi'), /may still run/);
});

test('timeout and Yggdrasil unreachable: no console run', async () => {
    yggdrasil.runOp = async () => { const e = new Error('timeout'); e.opId = 'op9'; throw e; };
    yggdrasil.cancelOp = async () => { throw new Error('ECONNREFUSED'); };
    yggdrasil.getOp = async () => { throw new Error('ECONNREFUSED'); };
    assert.match(await runViaLink('ptero-1', 'say hi'), /op op9/);
});

test('op never created: the error reaches the caller, which uses the console', async () => {
    yggdrasil.runOp = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(runViaLink('ptero-1', 'say hi'), /ECONNREFUSED/);
});
