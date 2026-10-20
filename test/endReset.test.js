/*
 * Unit tests for modules/endReset.js: job parsing, the request files VU writes, the plan
 * summary and the player mails. Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const endReset = require('../modules/endReset');

const FIXTURE = path.join(__dirname, 'fixtures/end-reset');
const plan = () => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'plan.json'), 'utf8'));
const PLAN_ID = '01JBX5P9N2C4D6F8G0H1J3K5MB';
const RESET_ID = '01JBX6Z2M4K8Q0R1S3T5V7W9YA';
const SHA = 'a'.repeat(64);

const job = extra => ({ _id: 'job-1', type: 'end_reset', instanceServerId: 'e2f5e517', requestedBy: 'alp', ...extra });

// ── parseJob ────────────────────────────────────────────────────────────────

test('parseJob accepts a plan job and keeps the instance id', () => {
    const r = endReset.parseJob(job({ action: 'plan', serverTag: 'evol' }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.job.action, 'plan');
    assert.strictEqual(r.job.instanceServerId, 'e2f5e517');
    assert.strictEqual(r.job.serverTag, 'evol');
});

test('parseJob refuses a bare tag and a missing instance id', () => {
    for (const instanceServerId of ['evol', '', undefined, 'e2f5e517-0000', 'E2F5E51']) {
        const r = endReset.parseJob(job({ action: 'plan', instanceServerId }));
        assert.strictEqual(r.ok, false, String(instanceServerId));
        assert.match(r.error, /instanceServerId/);
    }
});

test('parseJob refuses another type and an unknown action', () => {
    assert.strictEqual(endReset.parseJob({ ...job({ action: 'plan' }), type: 'scheduled_reboot' }).ok, false);
    const r = endReset.parseJob(job({ action: 'wipe' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Unknown action "wipe"/);
});

test('parseJob: apply needs a planId and gets the defaults', () => {
    assert.strictEqual(endReset.parseJob(job({ action: 'apply' })).ok, false);
    assert.strictEqual(endReset.parseJob(job({ action: 'apply', planId: 'not-a-ulid' })).ok, false);
    const r = endReset.parseJob(job({ action: 'apply', planId: PLAN_ID }));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(
        { planId: r.job.planId, warn: r.job.warnWindow, window: r.job.windowMinutes, fireAt: r.job.fireAt, ignore: r.job.ignoreUnsupported, mails: r.job.sendMails, dry: r.job.mailDryRun },
        { planId: PLAN_ID, warn: 15, window: 60, fireAt: null, ignore: false, mails: true, dry: false });
});

test('parseJob: apply options and a stored phase', () => {
    const r = endReset.parseJob(job({
        action: 'apply', planId: PLAN_ID, fireAt: '2026-10-21T04:00:00Z', warnWindow: 10, windowMinutes: 90,
        ignoreUnsupported: true, sendMails: false, mailDryRun: true, phase: 'awaiting_result', resetId: RESET_ID,
        notBefore: Date.parse('2026-10-21T03:55:00Z'), notAfter: Date.parse('2026-10-21T05:30:00Z'),
    }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.job.fireAt, Date.parse('2026-10-21T04:00:00Z'));
    assert.strictEqual(r.job.warnWindow, 10);
    assert.strictEqual(r.job.windowMinutes, 90);
    assert.strictEqual(r.job.ignoreUnsupported, true);
    assert.strictEqual(r.job.sendMails, false);
    assert.strictEqual(r.job.mailDryRun, true);
    assert.strictEqual(r.job.phase, 'awaiting_result');
    assert.strictEqual(r.job.resetId, RESET_ID);
});

test('parseJob refuses bad times and windows', () => {
    assert.strictEqual(endReset.parseJob(job({ action: 'apply', planId: PLAN_ID, fireAt: 'soon' })).ok, false);
    assert.strictEqual(endReset.parseJob(job({ action: 'apply', planId: PLAN_ID, warnWindow: 0 })).ok, false);
    assert.strictEqual(endReset.parseJob(job({ action: 'apply', planId: PLAN_ID, warnWindow: 61 })).ok, false);
    assert.strictEqual(endReset.parseJob(job({ action: 'apply', planId: PLAN_ID, windowMinutes: 5 })).ok, false);
});

test('parseJob: verify, mail and restore need a resetId; restore keeps confirmLoss', () => {
    for (const action of ['verify', 'mail', 'restore']) {
        assert.strictEqual(endReset.parseJob(job({ action })).ok, false, action);
        assert.strictEqual(endReset.parseJob(job({ action, resetId: RESET_ID })).ok, true, action);
    }
    assert.strictEqual(endReset.parseJob(job({ action: 'restore', resetId: RESET_ID })).job.confirmLoss, false);
    assert.strictEqual(endReset.parseJob(job({ action: 'restore', resetId: RESET_ID, confirmLoss: true })).job.confirmLoss, true);
    assert.strictEqual(endReset.parseJob(job({ action: 'mail', resetId: RESET_ID, mailDryRun: true })).job.mailDryRun, true);
    assert.strictEqual(endReset.parseJob(job({ action: 'restore', resetId: RESET_ID, restoreId: PLAN_ID })).job.restoreId, PLAN_ID);
    assert.strictEqual(endReset.parseJob(job({ action: 'restore', resetId: RESET_ID, restoreId: 'x' })).ok, false);
});

// ── ids and the request files ───────────────────────────────────────────────

test('ulid: 26 Crockford characters, time first', () => {
    const a = endReset.ulid(Date.parse('2026-10-21T04:00:00Z'), Buffer.alloc(10, 0));
    const b = endReset.ulid(Date.parse('2026-10-21T04:00:01Z'), Buffer.alloc(10, 0xff));
    assert.match(a, endReset.ULID_RE);
    assert.match(b, endReset.ULID_RE);
    assert.ok(a < b);
    assert.strictEqual(a.slice(10), '0000000000000000');
    assert.strictEqual(b.slice(10), 'ZZZZZZZZZZZZZZZZ');
    assert.strictEqual(endReset.ulid(0, Buffer.alloc(10)), '0'.repeat(26));
});

test('requestWindow opens 5 min before the reboot and closes windowMinutes after it', () => {
    const fireAt = Date.parse('2026-10-21T04:00:00Z');
    assert.deepStrictEqual(endReset.requestWindow(fireAt, 60), {
        notBefore: Date.parse('2026-10-21T03:55:00Z'),
        notAfter: Date.parse('2026-10-21T05:00:00Z'),
    });
});

test('buildRequest writes the contract fields, UTC with Z', () => {
    const text = endReset.buildRequest({
        resetId: RESET_ID, planId: PLAN_ID, planSha256: SHA,
        notBefore: Date.parse('2026-10-21T03:55:00.123Z'), notAfter: Date.parse('2026-10-21T05:00:00Z'),
        requestedBy: 'alp', ignoreUnsupported: false,
    });
    assert.ok(text.endsWith('\n'));
    assert.deepStrictEqual(JSON.parse(text), {
        schema: 1,
        resetId: RESET_ID,
        planId: PLAN_ID,
        planSha256: SHA,
        notBefore: '2026-10-21T03:55:00Z',
        notAfter: '2026-10-21T05:00:00Z',
        requestedBy: 'alp',
        ignoreUnsupported: false,
    });
});

test('buildRequest refuses bad ids, a bad sha and an empty window', () => {
    const ok = { resetId: RESET_ID, planId: PLAN_ID, planSha256: SHA, notBefore: 1, notAfter: 2, requestedBy: 'alp' };
    assert.doesNotThrow(() => endReset.buildRequest(ok));
    assert.throws(() => endReset.buildRequest({ ...ok, resetId: 'x' }), /resetId/);
    assert.throws(() => endReset.buildRequest({ ...ok, planId: 'x' }), /planId/);
    assert.throws(() => endReset.buildRequest({ ...ok, planSha256: 'abc' }), /planSha256/);
    assert.throws(() => endReset.buildRequest({ ...ok, notAfter: 1 }), /notAfter/);
});

test('buildRestore writes the contract fields with its own restoreId', () => {
    assert.throws(() => endReset.buildRestore({ resetId: RESET_ID, notBefore: 1, notAfter: 2 }), /restoreId/);
    const text = endReset.buildRestore({
        restoreId: PLAN_ID, resetId: RESET_ID, notBefore: Date.parse('2026-10-22T03:55:00Z'), notAfter: Date.parse('2026-10-22T05:00:00Z'), requestedBy: 'alp',
    });
    assert.deepStrictEqual(JSON.parse(text), {
        schema: 1, restoreId: PLAN_ID, resetId: RESET_ID, notBefore: '2026-10-22T03:55:00Z', notAfter: '2026-10-22T05:00:00Z', requestedBy: 'alp',
    });
});

test('contract files: a schema other than 1 is refused', () => {
    assert.throws(() => endReset.parsePlan(JSON.stringify({ schema: 2 })), /schema 2/);
    assert.throws(() => endReset.parseResult('{not json'), /not valid JSON/);
    assert.strictEqual(endReset.parsePlan(fs.readFileSync(path.join(FIXTURE, 'plan.json'))).planId, PLAN_ID);
});

// ── preflight and summary ───────────────────────────────────────────────────

const BIG_DISK = { limitBytes: 100 * 1024 ** 3, usedBytes: 10 * 1024 ** 3 };

test('preflight: the fixture plan passes with room on the disk', () => {
    assert.deepStrictEqual(endReset.preflight(plan(), { disk: BIG_DISK }), []);
    assert.deepStrictEqual(endReset.preflight(plan(), { disk: { limitBytes: 0, usedBytes: 5e12 } }), [], 'limit 0 = no limit');
});

test('preflight: unsupported mods stop the apply unless ignoreUnsupported', () => {
    const p = { ...plan(), unsupported: [{ mod: 'somehomes', reason: 'no rewrite rule' }] };
    const problems = endReset.preflight(p, { disk: BIG_DISK });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /somehomes/);
    assert.deepStrictEqual(endReset.preflight(p, { disk: BIG_DISK, ignoreUnsupported: true }), []);
});

test('preflight: free disk under twice the backup size stops the apply', () => {
    const backup = plan().backupBytes;
    const tight = { limitBytes: 10 * 1024 ** 3, usedBytes: 10 * 1024 ** 3 - 2 * backup + 1 };
    assert.match(endReset.preflight(plan(), { disk: tight })[0], /less than twice/);
    const exact = { limitBytes: 10 * 1024 ** 3, usedBytes: 10 * 1024 ** 3 - 2 * backup };
    assert.deepStrictEqual(endReset.preflight(plan(), { disk: exact }), []);
    assert.match(endReset.preflight(plan(), { disk: null })[0], /no disk numbers/);
});

test('preflight: other Minecraft versions and dimensions are refused', () => {
    assert.match(endReset.preflight({ ...plan(), mc: '1.21.1' }, { disk: BIG_DISK })[0], /1\.21\.1/);
    assert.match(endReset.preflight({ ...plan(), dimension: 'minecraft:the_nether' }, { disk: BIG_DISK })[0], /the_nether/);
});

test('summarizePlan gives the chunk counts and the affected players', () => {
    const text = endReset.summarizePlan(plan(), { serverLabel: 'Evolution #3 (e2f5e517)', planSha256: SHA });
    assert.match(text, /Chunks: kept 2, moved 2, wiped 1534/);
    assert.match(text, /Affected players \(4\): StretchyBacon, CoolBreeze02050, Nullifiedlife67, Kestrel_9/);
    assert.match(text, /Team Epic_Gamers#eee65f7e: 2 chunks, offset 9 0/);
    assert.match(text, /Homes: 1 move, 1 remove/);
    assert.match(text, /Region files: 2 rebuild, 1 move/);
    assert.match(text, /Unsupported: none/);
    assert.match(text, /Evolution #3 \(e2f5e517\)/);
});

// ── mails ───────────────────────────────────────────────────────────────────

test('mail line per reason kind', () => {
    const cases = {
        claim_moved: [{ kind: 'claim_moved', old: [16, 0, 80], new: [160, 0, 80], detail: 'chunk [1, 5] to [10, 5], team Epic Gamers' },
            'Claim moved from 16 0 80 to 160 0 80 (chunk [1, 5] to [10, 5], team Epic Gamers).'],
        home_moved: [{ kind: 'home_moved', old: [29, 76, 88], new: [173, 76, 88], detail: 'base' },
            'Home "base" moved from 29 76 88 to 173 76 88.'],
        home_removed: [{ kind: 'home_removed', old: [-30, 64, 40], new: null, detail: 'farm' },
            'Home "farm" at -30 64 40 was removed. The land there was reset.'],
        waystone_moved: [{ kind: 'waystone_moved', old: [30, 75, 92], new: [174, 75, 92], detail: 'Gate' },
            'Waystone "Gate" moved from 30 75 92 to 174 75 92.'],
        waystone_removed: [{ kind: 'waystone_removed', old: [5, 62, -3], new: null, detail: 'Spawn Hub' },
            'Waystone "Spawn Hub" at 5 62 -3 was removed. The land there was reset.'],
        back_moved: [{ kind: 'back_moved', old: [20, 70, 85], new: [164, 70, 85] },
            'Your /back point moved from 20 70 85 to 164 70 85.'],
        back_removed: [{ kind: 'back_removed', old: [20, 70, 20], new: null },
            'Your /back point at 20 70 20 was removed.'],
        player_moved: [{ kind: 'player_moved', old: [40, 80, 82], new: [184, 80, 82] },
            'You logged out in a moved claim. You moved from 40 80 82 to 184 80 82.'],
        player_to_spawn: [{ kind: 'player_to_spawn', old: [-12, 60, 7], new: null, newDim: 'minecraft:overworld' },
            'You logged out at -12 60 7 in the reset area. You will log in at world spawn.'],
    };
    for (const [kind, [reason, line]] of Object.entries(cases)) {
        assert.strictEqual(endReset.reasonLine(reason), line, kind);
        const text = endReset.mailText({ reasons: [reason] }, { serverLabel: 'Evolution #3' });
        assert.strictEqual(text, `The End on Evolution #3 was reset. Changes for you:\n${line}`, kind);
    }
    assert.strictEqual(endReset.reasonLine({ kind: 'warp_moved', old: [1, 2, 3], new: [4, 5, 6] }), 'warp moved: 1 2 3 to 4 5 6.');
});

test('claim moves with one shift become one line', () => {
    const reasons = [
        { kind: 'claim_moved', old: [16, 0, 80], new: [160, 0, 80] },
        { kind: 'home_moved', old: [29, 76, 88], new: [173, 76, 88], detail: 'base' },
        { kind: 'claim_moved', old: [32, 0, 80], new: [176, 0, 80] },
        { kind: 'claim_moved', old: [-16, 0, -32], new: [-16, 0, -176] },
    ];
    assert.deepStrictEqual(endReset.reasonLines(reasons), [
        '2 claimed chunks moved by x +144, z +0. Example: 16 0 80 is now 160 0 80.',
        'Home "base" moved from 29 76 88 to 173 76 88.',
        'Claim moved from -16 0 -32 to -16 0 -176.',
    ]);
});

test('a long mail stays at 500 characters and says how many lines it left out', () => {
    const reasons = [];
    for (let i = 0; i < 30; i++) reasons.push({ kind: 'home_removed', old: [i * 10, 64, 40], new: null, detail: `home number ${i}` });
    const text = endReset.mailText({ reasons }, { serverLabel: 'Evolution #3' });
    assert.ok(text.length <= 500, String(text.length));
    const m = /And (\d+) more\. Ask staff for the full list\.$/.exec(text);
    assert.ok(m, text);
    const shown = text.split('\n').length - 2;
    assert.strictEqual(shown + Number(m[1]), 30);
});

test('player text cannot carry MiniMessage tags', () => {
    const text = endReset.mailText({ reasons: [{ kind: 'home_moved', old: [1, 2, 3], new: [4, 5, 6], detail: '<click:run_command:/op me>base</click>' }] });
    assert.ok(!/[<>]/.test(text), text);
    assert.match(text, /Home "click:run_command:\/op mebase\/click"/);
});

test('buildMails: one admin mail doc per player with a dedupe key', () => {
    const now = new Date('2026-10-21T04:10:00Z');
    const mails = endReset.buildMails(plan().affectedPlayers, { resetId: RESET_ID, serverId: 'e2f5e517', serverLabel: 'Evolution #3', now });
    assert.strictEqual(mails.length, 4);
    for (const m of mails) {
        assert.ok(m.doc, m.error);
        assert.ok(m.doc.body.length <= 500);
        assert.strictEqual(m.doc.kind, 'admin');
        assert.strictEqual(m.doc.from.name, 'ValhallaMC');
        assert.strictEqual(m.doc.readAt, null);
        assert.strictEqual(m.doc.sentAt, now);
        assert.deepStrictEqual(m.doc.meta, { via: 'end_reset', resetId: RESET_ID, serverId: 'e2f5e517', key: `end-reset-${RESET_ID}-${m.player}` });
    }
    assert.strictEqual(mails[0].doc.to, 'a1b2c3d4-0000-4000-8000-000000000001');
    assert.strictEqual(mails[0].doc.toName, 'StretchyBacon');
});

test('buildMails: an undashed uuid is dashed, a bad one is reported', () => {
    const mails = endReset.buildMails([
        { player: 'A1B2C3D4000040008000000000000009', name: 'Upper', reasons: [{ kind: 'back_removed', old: [1, 2, 3] }] },
        { player: 'nope', name: 'Bad', reasons: [{ kind: 'back_removed', old: [1, 2, 3] }] },
    ], { resetId: RESET_ID });
    assert.strictEqual(mails[0].doc.to, 'a1b2c3d4-0000-4000-8000-000000000009');
    assert.strictEqual(mails[1].doc, undefined);
    assert.match(mails[1].error, /uuid/);
    assert.match(endReset.mailsAsText(mails), /NOT SENT/);
});
