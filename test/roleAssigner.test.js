/*
 * Unit tests for the role buttons of schedulers/roleAssigner.js (packButtons).
 * Run: npm test
 *
 * The instances of a tag share one Discord role, so they share one button. The role id comes
 * from every instance together. The first instance in Yggdrasil's order decides nothing: before
 * this, an instance with an empty role id that happened to be listed first made VU create a new
 * role and write it over the tag.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { packButtons } = require('../schedulers/roleAssigner');

const EVOL = [
    { tag: 'evol', name: 'Evolution #3', serverId: 'e2f5e517', discordRoleId: '' },
    { tag: 'evol', name: 'Evolution', serverId: 'e7575fc9', discordRoleId: 'role-evol', modpackID: 42, hostname: 'evol.example', platform: 'curseforge' },
    { tag: 'evol', name: 'Evolution #2', serverId: '505d921b', discordRoleId: 'role-evol' }
];
const GTNH = { tag: 'gtnh', name: 'GT New Horizons', discordRoleId: 'role-gtnh' };

test('one button per tag, with the role id an instance carries even when the first has none', () => {
    const { packs, conflicts } = packButtons([...EVOL, GTNH]);
    assert.deepStrictEqual(conflicts, []);
    assert.deepStrictEqual(packs.map(p => p.tag), ['evol', 'gtnh']);
    const evol = packs.find(p => p.tag === 'evol');
    assert.strictEqual(evol.discordRoleId, 'role-evol', 'no new role for evol');
    assert.strictEqual(evol.modpackID, 42, 'the emoji data comes from the instance that has it');
});

test('the label of a multi-instance pack does not depend on the instance order', () => {
    const forward = packButtons(EVOL).packs[0].name;
    const backward = packButtons([...EVOL].reverse()).packs[0].name;
    assert.strictEqual(forward, 'Evolution');
    assert.strictEqual(backward, forward);
    assert.strictEqual(packButtons([GTNH]).packs[0].name, 'GT New Horizons');
});

test('instances with different role ids are a conflict: no button and no new role', () => {
    const split = [EVOL[1], { ...EVOL[2], discordRoleId: 'role-other' }, GTNH];
    const { packs, conflicts } = packButtons(split);
    assert.deepStrictEqual(packs.map(p => p.tag), ['gtnh']);
    assert.deepStrictEqual(conflicts, [{ tag: 'evol', roleIds: ['role-evol', 'role-other'] }]);
});

test('a tag where no instance has a role is listed once with an empty role id', () => {
    const bare = EVOL.map(s => ({ ...s, discordRoleId: '' }));
    const { packs } = packButtons(bare);
    assert.strictEqual(packs.length, 1, 'one new role for the tag, not one per instance');
    assert.strictEqual(packs[0].discordRoleId, '');
});

test('the mention and Bifrost rows pass through unchanged', () => {
    const mention = { name: 'Updates', tag: 'updates', discordRoleId: 'role-updates' };
    const { packs } = packButtons([mention, GTNH]);
    assert.deepStrictEqual(packs[0], { tag: 'updates', name: 'Updates', discordRoleId: 'role-updates', hostname: undefined, modpackID: undefined, platform: undefined });
});
