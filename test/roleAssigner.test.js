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
const { packButtons, createdByAssigner, pendingMarks, releasedRoles, ROLE_REASON } = require('../schedulers/roleAssigner');

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

/*
 * Unreleased packs. A server doc with excludeFromServerList is not released yet. Its name must
 * not reach the public role channel: no button, no new role, no emoji. The buttons, the new
 * roles and the emojis all come from packs, so a hidden tag must not be in packs.
 */

const BOT = 'bot-fenrir';
const ROLE_EMBER = 'role-ember';
const ROLE_OLD_TFGM = 'role-old-tfgm';
const EMBER = { tag: 'ember', name: 'Project Ember', serverId: '08f3d7de', discordRoleId: '', excludeFromServerList: true };
const TFGM = { tag: 'tfgm', name: 'TerraFirmaGreg Modern', serverId: '08f3d7de', discordRoleId: ROLE_EMBER, modpackID: 7, excludeFromServerList: false };

test('a hidden pack gets no button, no new role and no emoji', () => {
    const { packs, conflicts, hidden } = packButtons([EMBER, GTNH]);
    assert.deepStrictEqual(packs.map(p => p.tag), ['gtnh'], 'the role-less hidden pack is not on the new-role list');
    assert.deepStrictEqual(conflicts, []);
    assert.deepStrictEqual(hidden, [{ tag: 'ember', discordRoleId: '' }]);

    const leaked = packButtons([{ ...EMBER, discordRoleId: ROLE_EMBER }, GTNH]);
    assert.deepStrictEqual(leaked.packs.map(p => p.tag), ['gtnh'], 'a hidden pack that already has a role loses its button');
    assert.deepStrictEqual(leaked.hidden, [{ tag: 'ember', discordRoleId: ROLE_EMBER }]);
});

test('a hidden instance of a released pack keeps the button, and its name stays off the label', () => {
    const codeName = { tag: 'evol', name: 'Evo', serverId: 'c0de0001', discordRoleId: 'role-evol', excludeFromServerList: true };
    const { packs, hidden } = packButtons([codeName, ...EVOL]);
    assert.deepStrictEqual(hidden, []);
    assert.strictEqual(packs.length, 1);
    assert.strictEqual(packs[0].name, 'Evolution');
    assert.strictEqual(packs[0].discordRoleId, 'role-evol');
});

test('a hidden instance with its own role id is still a conflict, checked before the hidden check', () => {
    const split = [EVOL[1], { ...EVOL[2], discordRoleId: 'role-other', excludeFromServerList: true }, GTNH];
    const { packs, conflicts, hidden } = packButtons(split);
    assert.deepStrictEqual(packs.map(p => p.tag), ['gtnh']);
    assert.deepStrictEqual(conflicts, [{ tag: 'evol', roleIds: ['role-evol', 'role-other'] }]);
    assert.deepStrictEqual(hidden, []);

    const allHidden = EVOL.map((s, i) => ({ ...s, discordRoleId: `role-${i}`, excludeFromServerList: true }));
    assert.deepStrictEqual(packButtons(allHidden).conflicts.map(c => c.tag), ['evol']);
});

test('only RoleCreate entries by the bot with the role assigner reason count as made by VU', () => {
    const entries = [
        { targetId: ROLE_EMBER, executorId: BOT, reason: ROLE_REASON },
        { targetId: 'role-by-hand', executorId: 'user-alp', reason: null },
        { targetId: 'role-other-bot-code', executorId: BOT, reason: 'something else' },
        { targetId: 'role-by-hand-same-reason', executorId: 'user-alp', reason: ROLE_REASON }
    ];
    assert.deepStrictEqual([...createdByAssigner(entries, BOT)], [ROLE_EMBER]);
});

test('a hidden tag marks a role VU made as waiting for the release, and nothing else', () => {
    const { hidden } = packButtons([
        { ...EMBER, discordRoleId: ROLE_EMBER },
        { tag: 'onyx', name: 'Project Onyx', discordRoleId: 'role-onyx', excludeFromServerList: true },
        { tag: 'gtse', name: 'GT Star Enterprise', discordRoleId: 'role-gtnh', excludeFromServerList: true },
        { tag: 'gtff', name: 'GT Final Frontier', discordRoleId: 'role-gtnh', excludeFromServerList: true },
        { tag: 'mmcc', name: 'GTNH MMCC Migration', discordRoleId: 'role-mmcc', excludeFromServerList: true }
    ]);
    const owned = new Map([
        ['role-onyx', { roleId: 'role-onyx', tag: 'onyx', pendingRelease: false }],
        ['role-mmcc', { roleId: 'role-mmcc', tag: 'mmcc', pendingRelease: true }]
    ]);
    // ember: the audit log proves it. onyx: VU created it on record. mmcc: already waiting.
    // role-gtnh: neither, so it is never touched.
    assert.deepStrictEqual(pendingMarks(hidden, owned, new Set([ROLE_EMBER])), [
        { roleId: ROLE_EMBER, tag: 'ember' },
        { roleId: 'role-onyx', tag: 'onyx' }
    ]);
});

test('on release the role VU made while the pack was hidden takes the real tag and name', () => {
    const owned = new Map([[ROLE_EMBER, { roleId: ROLE_EMBER, tag: 'ember', pendingRelease: true }]]);

    const before = packButtons([{ ...EMBER, discordRoleId: ROLE_EMBER }]);
    assert.deepStrictEqual(releasedRoles(before.packs, before.hidden, owned), [], 'no rename while hidden');

    const after = packButtons([TFGM, GTNH]);
    assert.deepStrictEqual(after.packs.map(p => p.tag), ['tfgm', 'gtnh']);
    assert.deepStrictEqual(releasedRoles(after.packs, after.hidden, owned), [
        { roleId: ROLE_EMBER, tag: 'tfgm', name: '[TFGM] TerraFirmaGreg Modern' }
    ]);

    const done = new Map([[ROLE_EMBER, { roleId: ROLE_EMBER, tag: 'tfgm', pendingRelease: false }]]);
    assert.deepStrictEqual(releasedRoles(after.packs, after.hidden, done), [], 'renamed once, not on every refresh');
});

test('a released pack whose role VU did not make keeps that role name', () => {
    const owned = new Map([[ROLE_EMBER, { roleId: ROLE_EMBER, tag: 'ember', pendingRelease: true }]]);
    // The doc points at the old hand-kept TFGM role on release.
    const { packs, hidden } = packButtons([{ ...TFGM, discordRoleId: ROLE_OLD_TFGM }]);
    assert.deepStrictEqual(releasedRoles(packs, hidden, owned), []);
    assert.deepStrictEqual(pendingMarks(hidden, owned, new Set()), []);
});

test('a role that a hidden tag still holds is not renamed for a visible tag that shares it', () => {
    const owned = new Map([[ROLE_EMBER, { roleId: ROLE_EMBER, tag: 'ember', pendingRelease: true }]]);
    const { packs, hidden } = packButtons([{ ...EMBER, discordRoleId: ROLE_EMBER }, TFGM]);
    assert.deepStrictEqual(packs.map(p => p.tag), ['tfgm']);
    assert.deepStrictEqual(releasedRoles(packs, hidden, owned), []);
});
