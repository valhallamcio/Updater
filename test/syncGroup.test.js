/*
 * Unit tests for discord/commands/sync-group.js: the staff command that reads a player sync
 * group and freezes or unfreezes its moves.
 * Run: npm test
 *
 * Yggdrasil is a fake injected through the playerSync client. Nothing here reaches a real one.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const syncGroup = require('../discord/commands/sync-group');
const { createPlayerSync } = require('../modules/playerSync');

const SERVERS = [
    { tag: 'evol', name: 'Evolution', serverId: 'e7575fc9', group: 'evol' },
    { tag: 'evol', name: 'Evolution #2', serverId: '505d921b', group: 'evol' },
    { tag: 'evol', name: 'Evolution #3', serverId: 'e2f5e517', group: 'evol' },
    { tag: 'pri', name: 'Project Infinity 0.1', serverId: '076d8208' },
    { tag: 'pri', name: 'Project Innfinity #2', serverId: '1ae705e3' }
];
const READY = SERVERS.slice(0, 3).map(s => ({ serverId: s.serverId, live: true, fp: 'fp2', fpMatch: true }));
const ONE_DOWN = READY.map((i, n) => (n === 2 ? { ...i, live: false, fp: null, fpMatch: false } : i));

function fakeYggdrasil({ frozen = false, freezeReason = null, instances = READY, missing = false } = {}) {
    const calls = [];
    const state = { mode: 'live', frozen, freezeReason };
    const view = () => ({ group: 'evol', mode: state.mode, frozen: state.frozen, freezeReason: state.freezeReason, instances });
    const http = {
        async get(url) {
            calls.push(`GET ${url}`);
            if (missing) {
                const error = new Error('not found');
                error.response = { status: 404, data: { error: { code: 'not_found' } } };
                throw error;
            }
            return { data: { data: view() } };
        },
        async put(url, body) {
            calls.push(`PUT ${url} frozen=${body.frozen}`);
            state.frozen = body.frozen;
            state.freezeReason = body.freezeReason;
            return { data: { data: view() } };
        },
        async post() { throw new Error('the command never reseeds'); }
    };
    return { http, calls, state };
}

function fakeInteraction(subcommand, strings, force = null) {
    const edits = [];
    return {
        edits,
        interaction: {
            user: { username: 'alp' },
            options: {
                getSubcommand: () => subcommand,
                getString: name => (name in strings ? strings[name] : null),
                getBoolean: name => (name === 'force' ? force : null)
            },
            async deferReply() {},
            async editReply(payload) { edits.push(payload); }
        }
    };
}

async function run(subcommand, strings, fake, force = null) {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const sync = createPlayerSync({ http: fake.http, log: quiet });
    const call = fakeInteraction(subcommand, strings, force);
    await syncGroup.execute(call.interaction, { sync, listServers: async () => SERVERS });
    const last = call.edits[call.edits.length - 1];
    const fields = last && last.embeds ? last.embeds[0].data.fields.map(f => `${f.name}: ${f.value}`).join('\n') : '';
    return { text: typeof last === 'string' ? last : `${last.content || ''}\n${fields}`, edits: call.edits };
}

const changing = calls => calls.filter(c => !c.startsWith('GET'));

test('status shows the freeze, every instance and why moves cannot open yet', async () => {
    const fake = fakeYggdrasil({ frozen: true, freezeReason: 'update evol 1.2', instances: ONE_DOWN });
    const { text } = await run('status', { group: 'evol' }, fake);

    assert.match(text, /Moves paused: Yes: update evol 1\.2/);
    assert.match(text, /🔴 `e2f5e517` Evolution #3: not linked/);
    assert.match(text, /🟢 `505d921b` Evolution #2: linked, pack fp2/);
    assert.match(text, /Ready to open moves: No: e2f5e517 not linked/);
    assert.deepStrictEqual(changing(fake.calls), [], 'status changes nothing');
});

test('a tag resolves to the sync group its instances share; a tag with none is refused', async () => {
    assert.deepStrictEqual(syncGroup.resolveGroup(SERVERS, 'EVOL'), { group: 'evol', error: null });
    assert.match(syncGroup.resolveGroup(SERVERS, 'pri').error, /share no sync group/);

    const fake = fakeYggdrasil();
    const { text } = await run('status', { group: 'pri' }, fake);
    assert.match(text, /share no sync group/);
    assert.deepStrictEqual(fake.calls, []);
});

test('freeze writes a staff reason that an update will not treat as its own', async () => {
    const fake = fakeYggdrasil();
    const { text } = await run('freeze', { group: 'evol', reason: 'dupe check' }, fake);

    assert.deepStrictEqual(changing(fake.calls), ['PUT /biforesting/sync/evol frozen=true']);
    assert.strictEqual(fake.state.freezeReason, 'staff alp: dupe check');
    assert.doesNotMatch(fake.state.freezeReason, /^(update|restore) /);
    assert.match(text, /are paused/);
});

test('freeze on a frozen group keeps the reason that is there', async () => {
    const fake = fakeYggdrasil({ frozen: true, freezeReason: 'restore evol 2026-10-09' });
    const { text } = await run('freeze', { group: 'evol' }, fake);
    assert.deepStrictEqual(changing(fake.calls), []);
    assert.strictEqual(fake.state.freezeReason, 'restore evol 2026-10-09');
    assert.match(text, /already paused/);
});

test('unfreeze opens moves once every instance is linked on one pack', async () => {
    const fake = fakeYggdrasil({ frozen: true, freezeReason: 'update evol 1.2' });
    const { text } = await run('unfreeze', { group: 'evol' }, fake);

    assert.deepStrictEqual(changing(fake.calls), ['PUT /biforesting/sync/evol frozen=false']);
    assert.strictEqual(fake.state.frozen, false);
    assert.match(text, /open again/);
    assert.match(text, /VU paused moves for `update evol 1\.2`/);
});

test('unfreeze refuses while an instance is down, unless force is set', async () => {
    const fake = fakeYggdrasil({ frozen: true, freezeReason: 'update evol 1.2', instances: ONE_DOWN });
    const refused = await run('unfreeze', { group: 'evol' }, fake);
    assert.deepStrictEqual(changing(fake.calls), []);
    assert.match(refused.text, /stay paused: e2f5e517 not linked/);
    assert.match(refused.text, /force:true/);

    const forced = await run('unfreeze', { group: 'evol' }, fake, true);
    assert.deepStrictEqual(changing(fake.calls), ['PUT /biforesting/sync/evol frozen=false']);
    assert.match(forced.text, /Opened with force past: e2f5e517 not linked/);
});

test('a group with no sync doc is reported and nothing is written', async () => {
    const fake = fakeYggdrasil({ missing: true });
    const { text } = await run('freeze', { group: 'evol' }, fake);
    assert.match(text, /no sync doc for `evol`/);
    assert.deepStrictEqual(changing(fake.calls), []);
});

test('the command is staff-only', () => {
    const json = syncGroup.data.toJSON();
    assert.strictEqual(json.default_member_permissions, '16', 'the same bar as /reboot');
    assert.strictEqual(json.dm_permission, false);
});
