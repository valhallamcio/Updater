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

// ---------------------------------------------------------------------------
// Instances: a tag runs on every instance and the reply reports each one
// ---------------------------------------------------------------------------

const executeCommand = require('../discord/commands/execute');
const { runOnInstance, formatReport } = executeCommand;

const EVOL = [
    { tag: 'evol', name: 'Evolution', serverId: 'e7575fc9' },
    { tag: 'evol', name: 'Evolution #2', serverId: '505d921b' },
    { tag: 'evol', name: 'Evolution #3', serverId: 'e2f5e517' }
];
const SERVERS = [...EVOL, { tag: 'gtnh', name: 'GT New Horizons', serverId: 'aaaa0001' }];

function fakeInteraction(server, command) {
    const out = { replies: [], edits: [], followUps: [] };
    out.interaction = {
        options: { getString: name => (name === 'server' ? server : command) },
        deferred: false,
        replied: false,
        async reply(text) { out.replies.push(text); this.replied = true; },
        async deferReply() { this.deferred = true; },
        async editReply(text) { out.edits.push(text); },
        async followUp(payload) { out.followUps.push(payload); }
    };
    return out;
}

/** runOnInstance stand-in that answers with the instance id. */
function fakeRun(ran) {
    return async (server, command) => {
        ran.push(server.serverId);
        return { server, via: 'link', output: `${command} on ${server.serverId}`, error: null, timedOut: false };
    };
}

test('execute: a tag runs on every instance, and the reply has a section per instance', async () => {
    const ran = [];
    const fake = fakeInteraction('evol', 'list');
    await executeCommand.execute(fake.interaction, { servers: SERVERS, run: fakeRun(ran) });

    assert.deepStrictEqual(ran, ['e7575fc9', '505d921b', 'e2f5e517']);
    assert.strictEqual(fake.edits.length, 1);
    const [reply] = fake.edits;
    assert.match(reply, /to \*\*3 instances\*\* of `evol`/);
    for (const s of EVOL) {
        assert.ok(reply.includes(`**${s.name}** (\`${s.serverId}\`)`), `${s.name} has its own section`);
        assert.ok(reply.includes(`list on ${s.serverId}`), `${s.name} shows its own output`);
    }
});

test('execute: an instance id runs on that instance only', async () => {
    const ran = [];
    const fake = fakeInteraction('505d921b', 'list');
    await executeCommand.execute(fake.interaction, { servers: SERVERS, run: fakeRun(ran) });
    assert.deepStrictEqual(ran, ['505d921b']);
    assert.match(fake.edits[0], /^Sent `list` to \*\*Evolution #2\*\* via link/);
});

test('execute: an ambiguous cut name runs nowhere', async () => {
    const ran = [];
    const fake = fakeInteraction('Evolution...', 'stop');
    await executeCommand.execute(fake.interaction, { servers: SERVERS, run: fakeRun(ran) });
    assert.deepStrictEqual(ran, []);
    assert.match(fake.replies[0], /matches 3 instances/);
});

test('formatReport: long outputs go into one attachment with a header per instance', () => {
    const results = EVOL.map(server => ({ server, via: 'console', output: 'x'.repeat(900), error: null, timedOut: false }));
    results[1] = { server: EVOL[1], via: 'console', output: '', error: null, timedOut: true };
    const report = formatReport('list', results);

    assert.ok(report.content.length <= 1900);
    assert.match(report.content, /\*\*Evolution #2\*\* \(`505d921b`\): ⚠️/);
    assert.match(report.content, /\*\*Evolution\*\* \(`e7575fc9`\): \*output in the attachment\*/);
    for (const s of EVOL) assert.ok(report.attachment.includes(`=== ${s.name} (${s.serverId}) ===`));
});

test('runOnInstance: no link session goes to the console, and its errors are reported, not thrown', async () => {
    const sentTo = [];
    const deps = {
        getLinkSession: async () => null,
        runViaLink: async () => { throw new Error('must not be called'); },
        sendAdvancedCommand: async (id) => { sentTo.push(id); return 'done'; }
    };
    const ok = await runOnInstance(EVOL[2], 'list', deps);
    assert.deepStrictEqual(sentTo, ['e2f5e517']);
    assert.deepStrictEqual([ok.via, ok.output, ok.error], ['console', 'done', null]);

    const failed = await runOnInstance(EVOL[2], 'list', { ...deps, sendAdvancedCommand: async () => { throw new Error('socket closed'); } });
    assert.strictEqual(failed.error, 'socket closed');

    const slow = await runOnInstance(EVOL[2], 'list', { ...deps, consoleTimeoutMs: 5, sendAdvancedCommand: () => new Promise(() => {}) });
    assert.strictEqual(slow.timedOut, true);
});
