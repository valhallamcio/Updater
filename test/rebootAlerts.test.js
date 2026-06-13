/*
 * Unit tests for modules/rebootAlerts.js — the version -> console-command contract.
 * Run: npm test   (node --test test/)
 *
 * These pin the exact wire decisions: right command syntax, right sound-name era,
 * no /title on 1.7, no /bossbar < 1.13, /title actionbar only >= 1.11, playsound
 * <source> only >= 1.9.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ra = require('../modules/rebootAlerts');

const has = (cmds, substr) => cmds.some((c) => c.includes(substr));
const titleCmds = (cmds) => cmds.filter((c) => c.startsWith('title @a'));

test('parseMcVersion handles patch / no-patch / garbage', () => {
    assert.deepStrictEqual(ra.parseMcVersion('1.7.10'), { major: 1, minor: 7, patch: 10 });
    assert.deepStrictEqual(ra.parseMcVersion('1.12'), { major: 1, minor: 12, patch: 0 });
    assert.deepStrictEqual(ra.parseMcVersion('1.20.1'), { major: 1, minor: 20, patch: 1 });
    assert.strictEqual(ra.parseMcVersion('garbage'), null);
    assert.strictEqual(ra.parseMcVersion(undefined), null);
});

test('tierFor maps versions to capability tiers', () => {
    assert.strictEqual(ra.tierFor('1.7.10'), 'legacy17');
    assert.strictEqual(ra.tierFor('1.8.9'), 'title18');
    assert.strictEqual(ra.tierFor('1.10.2'), 'title18');
    assert.strictEqual(ra.tierFor('1.11'), 'actionbar11');
    assert.strictEqual(ra.tierFor('1.12.2'), 'actionbar11');
    assert.strictEqual(ra.tierFor('1.13.2'), 'modern13');
    assert.strictEqual(ra.tierFor('1.16.5'), 'modern13');
    assert.strictEqual(ra.tierFor('1.20.1'), 'modern13');
    assert.strictEqual(ra.tierFor('1.21'), 'modern13');
    assert.strictEqual(ra.tierFor('weird'), 'chatonly');
});

test('1.7.10 milestone: chat + sound + say, NO title/actionbar, legacy playsound (no source)', () => {
    const cmds = ra.buildMilestoneCommands('1.7.10', 300, { serverName: 'GTNH' });
    assert.strictEqual(titleCmds(cmds).length, 0, 'no /title on 1.7');
    assert.ok(has(cmds, 'tellraw @a'), 'has rich chat');
    assert.ok(has(cmds, 'playsound note.pling @a'), 'legacy sound name + no source category');
    assert.ok(!has(cmds, 'playsound note.pling master'), 'must not include a source category');
    assert.ok(has(cmds, 'say '), 'keeps a say fallback');
    assert.ok(cmds.some((c) => c.includes('5 minutes')), 'humanized label');
});

test('1.8.9 milestone: has title, NO actionbar, legacy sound era (pre-1.9, no source)', () => {
    const cmds = ra.buildMilestoneCommands('1.8.9', 300);
    assert.ok(has(cmds, 'title @a times'), 'has title times');
    assert.ok(has(cmds, 'title @a title'), 'has title text');
    assert.ok(!has(cmds, 'title @a actionbar'), 'no actionbar subcommand before 1.11');
    assert.ok(has(cmds, 'playsound note.pling @a'), '1.8 still uses pre-1.9 names, no source');
});

test('1.9.4 milestone: title but no actionbar; 1.9 sound name + source category', () => {
    const cmds = ra.buildMilestoneCommands('1.9.4', 300);
    assert.ok(has(cmds, 'title @a title'));
    assert.ok(!has(cmds, 'title @a actionbar'), 'actionbar added at 1.11, not 1.9');
    assert.ok(has(cmds, 'playsound block.note.pling master @a'), '1.9-1.12 sound name + master source');
});

test('1.12.2 milestone: actionbar present, 1.9-era sound name', () => {
    const cmds = ra.buildMilestoneCommands('1.12.2', 300);
    assert.ok(has(cmds, 'title @a actionbar'), '1.11+ has actionbar');
    assert.ok(has(cmds, 'playsound block.note.pling master @a'));
});

test('1.20.1 milestone: full kit, 1.13-flattening sound name', () => {
    const cmds = ra.buildMilestoneCommands('1.20.1', 300, { serverName: 'ATM10' });
    assert.ok(has(cmds, 'title @a times'));
    assert.ok(has(cmds, 'title @a title'));
    assert.ok(has(cmds, 'title @a actionbar'));
    assert.ok(has(cmds, 'tellraw @a'));
    assert.ok(has(cmds, 'playsound block.note_block.pling master @a'), '1.13+ flattened sound name');
    assert.ok(has(cmds, 'say '));
});

test('unknown version is safe: chat + say only, no title/sound/bossbar', () => {
    const cmds = ra.buildMilestoneCommands('snapshot-xyz', 300);
    assert.strictEqual(titleCmds(cmds).length, 0);
    assert.ok(!has(cmds, 'playsound'), 'no sound when version unknown');
    assert.ok(has(cmds, 'tellraw @a'));
    assert.ok(has(cmds, 'say '));
});

test('bossbar setup/teardown only exist on 1.13+', () => {
    assert.deepStrictEqual(ra.buildBossbarSetup('1.12.2', 60), []);
    assert.deepStrictEqual(ra.buildBossbarSetup('1.8.9', 60), []);
    assert.deepStrictEqual(ra.buildBossbarTeardown('1.12.2'), []);

    const setup = ra.buildBossbarSetup('1.13.2', 60);
    assert.ok(has(setup, `bossbar add ${ra.BOSSBAR_ID}`));
    assert.ok(has(setup, `bossbar set ${ra.BOSSBAR_ID} max 60`));
    assert.ok(has(setup, `bossbar set ${ra.BOSSBAR_ID} players @a`));
    assert.deepStrictEqual(ra.buildBossbarTeardown('1.20.1'), [`bossbar remove ${ra.BOSSBAR_ID}`]);
});

test('countdown: modern shows title (every 10s + final 5s) + bossbar value + sound', () => {
    const at30 = ra.buildCountdownCommands('1.20.1', 30);
    assert.ok(has(at30, 'title @a title'), 'title at a 10s tick');
    assert.ok(has(at30, `bossbar set ${ra.BOSSBAR_ID} value 30`), 'bossbar drains');
    assert.ok(has(at30, 'playsound block.note_block.pling master @a'), 'notify sound at 10s tick');

    assert.ok(has(at30, `bossbar set ${ra.BOSSBAR_ID} name`), 'bossbar name refreshes on a tick second');

    const at27 = ra.buildCountdownCommands('1.20.1', 27);
    assert.ok(!has(at27, 'title @a title'), 'no title on a non-tick second');
    assert.ok(has(at27, `bossbar set ${ra.BOSSBAR_ID} value 27`), 'bossbar value still updates every second');
    assert.ok(!has(at27, `bossbar set ${ra.BOSSBAR_ID} name`), 'bossbar name NOT refreshed on a plain second (keeps per-tick burst small)');
    assert.ok(!has(at27, 'playsound'), 'no sound on a non-tick second');

    const at3 = ra.buildCountdownCommands('1.20.1', 3);
    assert.ok(has(at3, 'playsound entity.wither.spawn master @a'), 'urgent sound in final 5s');
});

test('countdown: legacy 1.7 gets sparse chat + sound, never title/bossbar', () => {
    const at30 = ra.buildCountdownCommands('1.7.10', 30);
    assert.strictEqual(titleCmds(at30).length, 0);
    assert.ok(!has(at30, 'bossbar'), 'no bossbar on 1.7');
    assert.ok(has(at30, 'tellraw @a'), 'chat countdown at 30s');
    assert.ok(has(at30, 'playsound note.pling @a'), 'sound at 30s');

    const at3 = ra.buildCountdownCommands('1.7.10', 3);
    assert.ok(has(at3, 'tellraw @a'), 'chat in final seconds');
    assert.ok(has(at3, 'playsound mob.wither.spawn @a'), 'legacy urgent sound name, no source');
});

test('channels toggle: disabling say/title removes them', () => {
    const cmds = ra.buildMilestoneCommands('1.20.1', 300, { channels: { say: false, title: false } });
    assert.strictEqual(titleCmds(cmds).filter((c) => !c.includes('actionbar')).length, 0, 'title text suppressed');
    assert.ok(!has(cmds, 'say '), 'say suppressed');
    assert.ok(has(cmds, 'tellraw @a'), 'chat still present');
});
