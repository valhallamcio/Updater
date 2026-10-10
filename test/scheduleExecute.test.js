/*
 * Unit tests for discord/commands/schedule-execute.js on a tag with several instances.
 * Run: npm test
 *
 * server-command runs on every instance of a tag and reports each one. player-trigger follows
 * the player_trigger rule: at most once per tag, on the instance the player stands on, behind
 * the same Mongo claim the scheduler takes. The panel, Yggdrasil and Mongo are fakes passed in.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const scheduleExecute = require('../discord/commands/schedule-execute');

const EVOL = [
    { tag: 'evol', name: 'Evolution', serverId: 'e7575fc9' },
    { tag: 'evol', name: 'Evolution #2', serverId: '505d921b' },
    { tag: 'evol', name: 'Evolution #3', serverId: 'e2f5e517' }
];
const GTNH = { tag: 'gtnh', name: 'GT New Horizons', serverId: 'aaaa0001' };
const SERVERS = [...EVOL, GTNH];

function fakeInteraction(strings) {
    const edits = [];
    return {
        edits,
        interaction: {
            user: { username: 'alp' },
            options: {
                getString: name => (name in strings ? strings[name] : null),
                getInteger: () => null,
                getBoolean: () => null
            },
            async editReply(payload) { edits.push(payload); }
        }
    };
}

/** Every field value of every embed in the edits, as one string. */
const embedText = edits => edits
    .flatMap(e => (e && e.embeds ? e.embeds : []))
    .flatMap(embed => (embed.data.fields || []).map(f => f.value))
    .join('\n');

function rig({ standing = '505d921b', claimMatched = 1, job = {} } = {}) {
    const state = { sent: [], claims: [], deactivated: [] };
    const trigger = { _id: 'job-1', type: 'player_trigger', active: true, playerId: 'Alp', serverNames: ['evol'], commands: ['give Alp minecraft:cake 1'], oneTime: true, ...job };
    state.deps = {
        sleep: async () => {},
        pterodactyl: { sendCommand: async (id, cmd) => { state.sent.push({ id, cmd }); } },
        yggdrasil: {
            getServers: async () => SERVERS,
            getPlayersDetailed: async () => ({ evol: standing ? [{ username: 'alp', instance: standing }] : [] })
        },
        mongo: {
            getAllScheduleJobs: async () => [trigger],
            claimScheduleJob: async (...args) => { state.claims.push(args); return { matchedCount: claimMatched }; },
            deactivateScheduleJob: async (id) => { state.deactivated.push(id); }
        }
    };
    return state;
}

test('server-command: a tag sends to every instance and reports each one', async () => {
    const state = rig();
    const fake = fakeInteraction({ servers: 'evol', command: 'say hi' });
    await scheduleExecute.executeServerCommand(fake.interaction, state.deps);

    assert.deepStrictEqual(state.sent.map(s => s.id), ['e7575fc9', '505d921b', 'e2f5e517']);
    const text = embedText(fake.edits);
    for (const s of EVOL) assert.ok(text.includes(`✅ ${s.name}`), `${s.name} is reported`);
    assert.match(text, /3\/3/);
});

test('server-command: an instance id sends to that one, and an instance named twice is sent to once', async () => {
    const state = rig();
    await scheduleExecute.executeServerCommand(fakeInteraction({ servers: '505d921b, gtnh', command: 'list' }).interaction, state.deps);
    assert.deepStrictEqual(state.sent.map(s => s.id), ['505d921b', 'aaaa0001']);

    const again = rig();
    const fake = fakeInteraction({ servers: 'evol, Evolution #2, nowhere', command: 'list' });
    await scheduleExecute.executeServerCommand(fake.interaction, again.deps);
    assert.deepStrictEqual(again.sent.map(s => s.id), ['e7575fc9', '505d921b', 'e2f5e517']);
    assert.match(embedText(fake.edits), /❓ nowhere: not found/);
});

test('player-trigger: a tag job runs once, on the instance the player stands on, after the claim', async () => {
    const state = rig({ standing: 'Evolution #2' });
    await scheduleExecute.executePlayerTrigger(fakeInteraction({ trigger_id: 'job-1' }).interaction, state.deps);

    assert.deepStrictEqual(state.sent.map(s => s.id), ['505d921b']);
    assert.deepStrictEqual(state.claims, [['job-1', true, '505d921b']]);
    assert.deepStrictEqual(state.deactivated, ['job-1']);
});

test('player-trigger: a player on no instance of the tag gets nothing, and the job stays armed', async () => {
    const state = rig({ standing: null });
    const fake = fakeInteraction({ trigger_id: 'job-1' });
    await scheduleExecute.executePlayerTrigger(fake.interaction, state.deps);

    assert.deepStrictEqual(state.sent, []);
    assert.deepStrictEqual(state.claims, []);
    assert.deepStrictEqual(state.deactivated, []);
    assert.match(fake.edits[0], /Alp is not on any of its 3 instances/);
});

test('player-trigger: a job the scheduler already claimed sends nothing', async () => {
    const state = rig({ claimMatched: 0 });
    const fake = fakeInteraction({ trigger_id: 'job-1' });
    await scheduleExecute.executePlayerTrigger(fake.interaction, state.deps);

    assert.deepStrictEqual(state.sent, []);
    assert.deepStrictEqual(state.deactivated, []);
    assert.match(fake.edits[0], /already ran or was cancelled/);
});

test('player-trigger: the server option can name one instance by id', async () => {
    const state = rig({ standing: 'Evolution #3' });
    await scheduleExecute.executePlayerTrigger(fakeInteraction({ trigger_id: 'job-1', server: 'e7575fc9' }).interaction, state.deps);
    assert.deepStrictEqual(state.sent.map(s => s.id), ['e7575fc9']);
});
