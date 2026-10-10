/*
 * Unit tests for modules/serverTargets.js: what a typed server value names.
 * Run: npm test
 *
 * Tags are not unique. A tag must name every instance of the pack, never the first one only.
 * A Pterodactyl id or an exact instance name names one instance.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveTargets, autocompleteChoices, instancesOfTag } = require('../modules/serverTargets');

const EVOL = [
    { tag: 'evol', name: 'Evolution', serverId: 'e7575fc9' },
    { tag: 'evol', name: 'Evolution #2', serverId: '505d921b' },
    { tag: 'evol', name: 'Evolution #3', serverId: 'e2f5e517' }
];
const PRI = [
    { tag: 'pri', name: 'Project Infinity 0.1', serverId: '076d8208' },
    { tag: 'pri', name: 'Project Innfinity #2', serverId: '1ae705e3' }
];
const GTNH = { tag: 'gtnh', name: 'GT New Horizons', serverId: 'aaaa0001' };
const SERVERS = [...EVOL, GTNH, ...PRI];
const ids = result => result.servers.map(s => s.serverId);

test('a tag names every instance of the pack, in the given order', () => {
    assert.deepStrictEqual(ids(resolveTargets(SERVERS, 'evol')), ['e7575fc9', '505d921b', 'e2f5e517']);
    assert.deepStrictEqual(ids(resolveTargets(SERVERS, ' PRI ')), ['076d8208', '1ae705e3']);
    assert.strictEqual(resolveTargets(SERVERS, 'evol').by, 'tag');
});

test('a Pterodactyl id or an exact instance name names one instance', () => {
    assert.deepStrictEqual(ids(resolveTargets(SERVERS, '505d921b')), ['505d921b']);
    assert.deepStrictEqual(ids(resolveTargets(SERVERS, 'evolution #3')), ['e2f5e517']);
    assert.deepStrictEqual(ids(resolveTargets(SERVERS, 'GT New Horizons')), ['aaaa0001']);
    assert.strictEqual(resolveTargets(SERVERS, '505d921b').by, 'id');
    assert.strictEqual(resolveTargets(SERVERS, 'Evolution #3').by, 'name');
});

test('a cut name matches one instance, and an ambiguous one is refused', () => {
    assert.deepStrictEqual(ids(resolveTargets(SERVERS, 'Project Innfinity...')), ['1ae705e3']);
    const ambiguous = resolveTargets(SERVERS, 'Evolution...');
    assert.deepStrictEqual(ambiguous.servers, [], 'never the first of several matches');
    assert.match(ambiguous.error, /matches 3 instances/);
});

test('two instances with one name are refused, an unknown value is empty', () => {
    const twins = [{ tag: 'a', name: 'Twin', serverId: '1' }, { tag: 'b', name: 'Twin', serverId: '2' }];
    assert.deepStrictEqual(resolveTargets(twins, 'twin').servers, []);
    assert.match(resolveTargets(twins, 'twin').error, /2 instances are named/);
    assert.deepStrictEqual(resolveTargets(SERVERS, 'nowhere'), { servers: [], by: null, error: null });
    assert.deepStrictEqual(resolveTargets(SERVERS, '  ').servers, []);
});

test('autocomplete offers the whole tag and each instance by id', () => {
    const choices = autocompleteChoices(SERVERS, '', ['all']);
    assert.deepStrictEqual(choices[0], { name: 'all', value: 'all' });
    assert.ok(choices.some(c => c.value === 'evol' && /all 3 instances/.test(c.name)));
    for (const s of EVOL) assert.ok(choices.some(c => c.value === s.serverId), `${s.name} is offered by id`);
    assert.ok(choices.some(c => c.value === 'gtnh'), 'a single-instance pack is offered by tag');
    for (const c of choices.slice(1)) {
        assert.ok(resolveTargets(SERVERS, c.value).servers.length > 0, `${c.value} resolves back`);
    }
    assert.deepStrictEqual(autocompleteChoices(SERVERS, '505d').map(c => c.value), ['505d921b']);
});

test('instancesOfTag ignores case and an empty tag', () => {
    assert.strictEqual(instancesOfTag(SERVERS, 'EVOL').length, 3);
    assert.deepStrictEqual(instancesOfTag(SERVERS, ''), []);
});
