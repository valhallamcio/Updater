/*
 * Unit tests for discord/commands/creativeok.js: staff clear a player for creative per server.
 * Run: npm test
 *
 * 2026-10-29: gahooner asked to clear TheChosenHam on PRI. Both PRI servers carry the tag, and
 * Bifrost's permission-api keeps one entry per node, so the command edits the whole array.
 * The db is a fake. Nothing here reaches Mongo.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const creativeok = require('../discord/commands/creativeok');

const { CREATIVE_PERM } = creativeok;
const SERVERS = [
    { serverId: '076d8208', name: 'Project Infinity 0.1', tag: 'pri' },
    { serverId: '1ae705e3', name: 'Project Innfinity #2', tag: 'pri' },
    { serverId: '6c1193cf', name: 'Legendary Edition', tag: 'lg' }
];
const scoped = s => ({ key: CREATIVE_PERM, value: true, context: [{ key: 'server', value: s }] });

function fakeDb(player) {
    const writes = [];
    const coll = name => ({
        find: () => ({ toArray: async () => (name === 'servers' ? SERVERS : [player]), limit() { return this; } }),
        findOne: async q => (new RegExp(q.username.$regex, 'i').test(player.username) ? player : null),
        updateOne: async (q, u) => {
            const same = JSON.stringify(q.permissions) === JSON.stringify(player.permissions);
            if (!same) return { matchedCount: 0 };
            writes.push(u.$set.permissions);
            player.permissions = u.$set.permissions;
            return { matchedCount: 1 };
        }
    });
    return { db: { collection: coll }, writes };
}

function fakeInteraction(sub, strings) {
    const edits = [];
    return {
        edits,
        interaction: {
            user: { username: 'gahooner' },
            options: { getSubcommand: () => sub, getString: n => (n in strings ? strings[n] : null) },
            async deferReply() {},
            async editReply(m) { edits.push(m); }
        }
    };
}

test('a tag names every server that carries it; an id or a name names one', () => {
    assert.deepStrictEqual(creativeok.matchServers(SERVERS, 'PRI').map(s => s.serverId), ['076d8208', '1ae705e3']);
    assert.deepStrictEqual(creativeok.matchServers(SERVERS, '1ae705e3').map(s => s.serverId), ['1ae705e3']);
    assert.deepStrictEqual(creativeok.matchServers(SERVERS, 'legendary edition').map(s => s.serverId), ['6c1193cf']);
    assert.deepStrictEqual(creativeok.matchServers(SERVERS, 'evol'), []);
});

test('edits keep other nodes and one entry per server', () => {
    const base = [{ key: 'group.default', value: true }, scoped('Legendary Edition')];
    const added = creativeok.editClearance(base, 'add', ['Project Infinity 0.1', 'Project Innfinity #2']);
    assert.deepStrictEqual(creativeok.clearedServers(added), ['Legendary Edition', 'Project Infinity 0.1', 'Project Innfinity #2']);
    assert.strictEqual(creativeok.editClearance(added, 'add', ['Legendary Edition']).filter(e => e.key === CREATIVE_PERM).length, 3);
    assert.deepStrictEqual(creativeok.clearedServers(creativeok.editClearance(added, 'remove', ['Project Infinity 0.1'])),
        ['Legendary Edition', 'Project Innfinity #2']);
    assert.deepStrictEqual(creativeok.editClearance([...base, { key: CREATIVE_PERM, value: true }], 'remove', null),
        [{ key: 'group.default', value: true }]);
});

test('add on a tag writes the array without the node, then with one entry per server', async () => {
    const player = { uuid: 'u1', username: 'TheChosenHam', permissions: [{ key: 'group.default', value: true }] };
    const { db, writes } = fakeDb(player);
    const { interaction, edits } = fakeInteraction('add', { player: 'thechosenham', server: 'pri' });
    await creativeok.execute(interaction, { db });
    assert.strictEqual(writes.length, 2);
    assert.deepStrictEqual(writes[0], [{ key: 'group.default', value: true }]);
    assert.deepStrictEqual(creativeok.clearedServers(writes[1]), ['Project Infinity 0.1', 'Project Innfinity #2']);
    assert.match(edits[0].embeds[0].data.title, /TheChosenHam is cleared/);
});

test('remove all clears every entry; an unknown server writes nothing', async () => {
    const player = { uuid: 'u1', username: 'TheChosenHam', permissions: [scoped('Project Infinity 0.1'), scoped('Legendary Edition')] };
    const { db, writes } = fakeDb(player);
    const bad = fakeInteraction('add', { player: 'TheChosenHam', server: 'nope' });
    await creativeok.execute(bad.interaction, { db });
    assert.strictEqual(writes.length, 0);
    assert.match(bad.edits[0], /No server matches/);
    const all = fakeInteraction('remove', { player: 'TheChosenHam', server: 'all' });
    await creativeok.execute(all.interaction, { db });
    assert.deepStrictEqual(player.permissions, []);
});
