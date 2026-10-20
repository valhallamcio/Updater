/*
 * Unit tests for modules/endResetVerify.js on the fixture in test/fixtures/end-reset.
 * The fight files there are real 26.1.2 files; the region files come from make-fixtures.js.
 * Each failure case wraps the fixture io and changes one file. Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const endReset = require('../modules/endReset');
const verify = require('../modules/endResetVerify');

const FIXTURE = path.join(__dirname, 'fixtures/end-reset');
const read = rel => fs.readFileSync(path.join(FIXTURE, rel));
const TEAM_A = 'eee65f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const R00 = 'world/dimensions/minecraft/the_end/region/r.0.0.mca';

function inputs() {
    const result = endReset.parseResult(read('result.json'));
    return {
        plan: endReset.parsePlan(read('plan.json')),
        result,
        manifest: endReset.parseManifest(read(result.manifest)),
        logText: read('boot-log.txt').toString('utf8'),
    };
}

/** The fixture io with some files swapped: { path: Buffer|null } and { path: stat }. */
function patched(files = {}, stats = {}) {
    const base = verify.localIo(FIXTURE);
    return {
        async readBinary(p) { return p in files ? files[p] : base.readBinary(p); },
        async readText(p) { const b = await this.readBinary(p); return b ? b.toString('utf8') : null; },
        async stat(p) { return p in stats ? stats[p] : base.stat(p); },
    };
}

const failed = report => report.checks.filter(c => !c.ok).map(c => c.name);

test('the fixture reset passes every check', async () => {
    const report = await verify.verifyReset(verify.localIo(FIXTURE), inputs());
    assert.deepStrictEqual(failed(report), [], verify.verifyText(report));
    assert.deepStrictEqual(report.checks.map(c => c.name), ['result', 'manifest', 'fight', 'kept chunks', 'move targets', 'claims', 'kept gateways', 'inner gateways', 'md5', 'log']);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.scanRan, false);
    assert.match(report.notes.join(' '), /scan has not run yet/);
});

test('readFight reads the real fresh and trapped 26.1.2 files', () => {
    const fresh = verify.readFight(read('fight-fresh.dat'));
    assert.deepStrictEqual(fresh, {
        needs_state_scanning: true, dragon_killed: false, previously_killed: false,
        hasDragonUuid: false, exitPortal: null,
        gateways: [11, 14, 12, 2, 4, 9, 7, 17, 5, 6, 15, 10, 1, 16, 3, 18, 0, 13, 8, 19],
    });
    const trapped = verify.readFight(read('fight-killed.dat'));
    assert.strictEqual(trapped.dragon_killed, true);
    assert.strictEqual(trapped.previously_killed, true);
    assert.strictEqual(trapped.hasDragonUuid, true);
    assert.deepStrictEqual(trapped.exitPortal, [0, 57, 0]);
});

test('a killed fight file fails the fight check', async () => {
    const io = patched({ 'world/dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat': read('fight-killed.dat') });
    const report = await verify.verifyReset(io, inputs());
    assert.ok(failed(report).includes('fight'));
    assert.match(report.checks.find(c => c.name === 'fight').detail, /dragon_killed true/);
});

test('the "killed already" line fails the log check', async () => {
    const input = inputs();
    input.logText += '[21Oct2026 05:10:00.000] [Server thread/INFO] [minecraft/EnderDragonFight]: Found that the dragon has been killed in this world already.\n';
    const report = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.deepStrictEqual(failed(report), ['log']);
    assert.match(report.checks.find(c => c.name === 'log').detail, /killed in this world already/);
});

test('a missing done line fails the log check', async () => {
    const input = inputs();
    input.logText = input.logText.split('\n').filter(l => !l.includes('end reset 01JBX6Z2M4K8Q0R1S3T5V7W9YA:')).join('\n');
    const report = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.deepStrictEqual(failed(report), ['log']);
});

test('a step line alone is no DONE line, and a FAILED outcome fails', async () => {
    const input = inputs();
    input.logText = input.logText.split('\n').filter(l => !l.includes(': DONE applied')).join('\n');
    assert.match(input.logText, /end reset 01JBX6Z2M4K8Q0R1S3T5V7W9YA step:/);
    const noDone = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.deepStrictEqual(failed(noDone), ['log']);
    input.logText += '[x] [Server thread/INFO] [b/]: [Biforesting] end reset 01JBX6Z2M4K8Q0R1S3T5V7W9YA: FAILED failed: disk full\n';
    const bad = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.match(bad.checks.find(c => c.name === 'log').detail, /FAILED line: FAILED failed: disk full/);
});

test('after the scan ran, a live dragon and an exit portal still pass', async () => {
    const zlib = require('zlib');
    // The scan sets needs_state_scanning 0 and writes the exit portal and the dragon uuid.
    const fresh = zlib.gunzipSync(read('world/dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat'));
    const trapped = verify.readFight(read('fight-killed.dat'));
    assert.ok(trapped.exitPortal);
    const input = inputs();
    input.logText += '[21Oct2026 05:10:00.000] [Server thread/INFO] [minecraft/EnderDragonFight]: Found that the dragon has not yet been killed in this world.\n';
    const flipped = Buffer.from(fresh);
    const at = flipped.indexOf(Buffer.from('needs_state_scanning')) + 'needs_state_scanning'.length;
    assert.strictEqual(flipped[at], 1);
    flipped[at] = 0;
    const io = patched({ 'world/dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat': zlib.gzipSync(flipped) });
    const report = await verify.verifyReset(io, input);
    assert.strictEqual(report.scanRan, true);
    assert.ok(!failed(report).includes('fight'), verify.verifyText(report));
    // md5 of the fight file differs now, and its mtime is not writtenAt: not a failure.
    assert.match(report.checks.find(c => c.name === 'md5').detail, /saved by the game after the reset/);
});

test('needs_state_scanning 0 before any scan fails', async () => {
    const zlib = require('zlib');
    const raw = Buffer.from(zlib.gunzipSync(read('world/dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat')));
    raw[raw.indexOf(Buffer.from('needs_state_scanning')) + 'needs_state_scanning'.length] = 0;
    const report = await verify.verifyReset(patched({ 'world/dimensions/minecraft/the_end/data/minecraft/ender_dragon_fight.dat': zlib.gzipSync(raw) }), inputs());
    assert.match(report.checks.find(c => c.name === 'fight').detail, /needs_state_scanning false, result says true/);
});

test('a gateway index the result dropped fails the fight check; the plan list is the fallback', async () => {
    const input = inputs();
    input.result.fight.gateways = input.result.fight.gateways.filter(g => g !== 19);
    const report = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.match(report.checks.find(c => c.name === 'fight').detail, /gateways 19 are not in the result/);
    delete input.result.fight.gateways;
    input.plan.fight.gateways = input.plan.fight.gateways.filter(g => g !== 13);
    const fallback = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.match(fallback.checks.find(c => c.name === 'fight').detail, /gateways 13 are not in the plan/);
});

test('an empty header slot of a kept chunk fails the kept check', async () => {
    const bytes = Buffer.from(read(R00));
    bytes.writeUInt32BE(0, ((12 & 31) + (12 & 31) * 32) * 4);
    const report = await verify.verifyReset(patched({ [R00]: bytes }, { [R00]: { size: bytes.length, mtime: '2026-10-21T05:00:00Z' } }), inputs());
    assert.ok(failed(report).includes('kept chunks'));
    assert.match(report.checks.find(c => c.name === 'kept chunks').detail, /kept \[12, 12\]: header slot is empty/);
});

test('a target slot that holds another chunk fails the target check', async () => {
    const bytes = Buffer.from(read(R00));
    // Point the (11,5) slot at the payload of (10,5).
    bytes.writeUInt32BE(bytes.readUInt32BE((10 + 5 * 32) * 4), (11 + 5 * 32) * 4);
    const report = await verify.verifyReset(patched({ [R00]: bytes }), inputs());
    assert.match(report.checks.find(c => c.name === 'move targets').detail, /target \[11, 5\]: chunk says xPos 10 zPos 5/);
});

test('a missing region file fails the kept check', async () => {
    const r20 = 'world/dimensions/minecraft/the_end/region/r.-2.0.mca';
    const report = await verify.verifyReset(patched({ [r20]: null }), inputs());
    assert.match(report.checks.find(c => c.name === 'kept chunks').detail, /kept \[-40, 3\]: region file missing/);
});

test('claims: a lost target, a lost force-load and a claim left in the zone fail', async () => {
    const teamFile = `world/ftbchunks/${TEAM_A}.json5`;
    const text = read(teamFile).toString('utf8')
        .replace(/x: 11,\n\s*z: 5,/, 'x: 2,\n        z: 5,')
        .replace(/\s*force_loaded: \d+,/, '');
    const report = await verify.verifyReset(patched({ [teamFile]: Buffer.from(text) }), inputs());
    const detail = report.checks.find(c => c.name === 'claims').detail;
    assert.match(detail, /target \[11, 5\] is not claimed/);
    assert.match(detail, /target \[10, 5\] lost its force-load/);
    assert.match(detail, /claims left in the zone: team eee65f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b \[2, 5\]/);
});

test('md5: a changed file with mtime equal to writtenAt fails; a later save does not', async () => {
    const bytes = Buffer.from(read(R00));
    bytes[bytes.length - 1] ^= 0xff;
    const same = await verify.verifyReset(patched({ [R00]: bytes }, { [R00]: { size: bytes.length, mtime: '2026-10-21T04:02:40.700+00:00' } }), inputs());
    assert.match(same.checks.find(c => c.name === 'md5').detail, /r\.0\.0\.mca: md5 differs, mtime equals writtenAt/);
    assert.strictEqual(same.ok, false);
    const later = await verify.verifyReset(patched({ [R00]: bytes }, { [R00]: { size: bytes.length, mtime: '2026-10-21T04:30:00+00:00' } }), inputs());
    assert.ok(!failed(later).includes('md5'));
    assert.match(later.checks.find(c => c.name === 'md5').detail, /4 files match md5After, 1 saved by the game/);
});

test('md5: a created file is checked like a rewritten one', async () => {
    const poi = 'world/dimensions/minecraft/the_end/poi/r.0.0.mca';
    const input = inputs();
    assert.strictEqual(input.manifest.files.find(f => f.path === poi).action, 'created');
    const bytes = Buffer.from(read(poi));
    bytes[bytes.length - 1] ^= 0xff;
    const report = await verify.verifyReset(patched({ [poi]: bytes }, { [poi]: { size: bytes.length, mtime: '2026-10-21T04:02:40Z' } }), input);
    assert.match(report.checks.find(c => c.name === 'md5').detail, /poi\/r\.0\.0\.mca: md5 differs/);
});

test('inner gateways: no step line yet fails', async () => {
    const input = inputs();
    input.logText = input.logText.split('\n').filter(l => !l.includes('inner gateway')).join('\n');
    const report = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.deepStrictEqual(failed(report), ['inner gateways']);
    assert.match(report.checks.find(c => c.name === 'inner gateways').detail, /no "inner gateways: N built" line yet/);
});

test('inner gateways: a failed status, a wrong exit and a missing chunk fail', async () => {
    const input = inputs();
    input.logText = input.logText.replace('inner gateways: 1 built, 0 failed', 'inner gateways: 0 built, 1 failed');
    input.result.innerGateways[0].status = 'failed';
    input.result.innerGateways[0].reason = 'java.lang.IllegalStateException: no End level';
    const failedStatus = await verify.verifyReset(verify.localIo(FIXTURE), input);
    const detail = failedStatus.checks.find(c => c.name === 'inner gateways').detail;
    assert.match(detail, /log says 0 built, 1 failed, of 1/);
    assert.match(detail, /spot 5: status failed \(java\.lang\.IllegalStateException: no End level\)/);

    const wrongExit = inputs();
    wrongExit.result.innerGateways[0].exitPortal = [196, 75, 196];
    const exitReport = await verify.verifyReset(verify.localIo(FIXTURE), wrongExit);
    assert.match(exitReport.checks.find(c => c.name === 'inner gateways').detail, /spot 5: exit 204 75 204, want the outer gateway 196 75 196/);

    const noChunk = await verify.verifyReset(patched({ 'world/dimensions/minecraft/the_end/region/r.-1.0.mca': null }), inputs());
    assert.match(noChunk.checks.find(c => c.name === 'inner gateways').detail, /spot 5: region file of chunk \[-1, 6\] missing/);
});

test('inner gateways: the block must be end_gateway between bedrock', async () => {
    const input = inputs();
    input.result.innerGateways[0].pos = [-1, 74, 96];
    input.result.innerGateways[0].exitPortal = [204, 75, 204];
    const report = await verify.verifyReset(verify.localIo(FIXTURE), input);
    const detail = report.checks.find(c => c.name === 'inner gateways').detail;
    assert.match(detail, /block at -1 74 96 is minecraft:bedrock/);
    assert.match(detail, /below and above are minecraft:air and minecraft:end_gateway/);
});

test('inner gateways: the plan rebuilds some, result.json lists none', async () => {
    const input = inputs();
    delete input.result.innerGateways;
    const report = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.match(report.checks.find(c => c.name === 'inner gateways').detail, /the plan rebuilds 1, result\.json lists none/);
});

test('kept gateways: the exit must match the action', async () => {
    const input = inputs();
    input.result.gatewaysInKeptChunks[0].action = 'clear_exit';
    const cleared = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.match(cleared.checks.find(c => c.name === 'kept gateways').detail, /clear_exit, but the old exit -1 75 96 is still set/);
    input.result.gatewaysInKeptChunks[0] = { ...input.result.gatewaysInKeptChunks[0], action: 'move_exit', newExitPortal: [100, 70, 100] };
    const moved = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.match(moved.checks.find(c => c.name === 'kept gateways').detail, /move_exit, exit -1 75 96, want 100 70 100/);
    input.result.gatewaysInKeptChunks[0] = { pos: [204, 75, 205], chunk: [12, 12], exitPortal: [-1, 75, 96], moved: false, action: 'keep' };
    const missing = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.match(missing.checks.find(c => c.name === 'kept gateways').detail, /204 75 205: no block entity/);
});

test('innerGatewaysLine and blockAt', () => {
    const log = read('boot-log.txt').toString('utf8');
    assert.deepStrictEqual(verify.innerGatewaysLine(log, '01JBX6Z2M4K8Q0R1S3T5V7W9YA'), { built: 1, failed: 0 });
    assert.strictEqual(verify.innerGatewaysLine(log, '01JBX7AAAAAAAAAAAAAAAAAAAA'), null);
    const { MCAFile } = require('mc-nbt-lib/mca-handler');
    const bytes = read('world/dimensions/minecraft/the_end/region/r.-1.0.mca');
    const loc = bytes.readUInt32BE(((-1 & 31) + (6 & 31) * 32) * 4);
    const chunk = verify.plain(new MCAFile().readChunk(bytes, { offset: loc >>> 8, count: loc & 0xff }));
    assert.deepStrictEqual([73, 74, 75, 76, 77].map(y => verify.blockAt(chunk, -1, y, 96)),
        ['minecraft:air', 'minecraft:bedrock', 'minecraft:end_gateway', 'minecraft:bedrock', 'minecraft:air']);
    assert.strictEqual(verify.blockAt(chunk, -2, 75, 96), 'minecraft:air');
    assert.strictEqual(verify.blockAt(chunk, -1, 10, 96), 'minecraft:air');
});

test('a missing or incomplete manifest fails', async () => {
    const input = inputs();
    const none = await verify.verifyReset(verify.localIo(FIXTURE), { ...input, manifest: null });
    assert.ok(failed(none).includes('manifest'));
    const open = await verify.verifyReset(verify.localIo(FIXTURE), { ...input, manifest: { ...input.manifest, complete: false } });
    assert.ok(failed(open).includes('manifest'));
});

test('a result that is not applied fails the result check', async () => {
    const input = inputs();
    input.result = { ...input.result, status: 'aborted', reason: 'claims differ from the plan' };
    const report = await verify.verifyReset(verify.localIo(FIXTURE), input);
    assert.ok(failed(report).includes('result'));
});

test('parseJson5 reads the FTB Chunks subset', () => {
    const doc = verify.parseJson5(`// team file
{
  max_claim_chunks: 500, /* inline */
  name: 'Epic \\'Gamers\\'',
  chunks: {
    "minecraft:the_end": [ { x: -3, z: 4, time: 1791736480665, force_loaded: 1791602113664, }, ],
  },
  flag: true, none: null, hex: 0x1F, neg: -2.5e1,
}`);
    assert.strictEqual(doc.max_claim_chunks, 500);
    assert.strictEqual(doc.name, "Epic 'Gamers'");
    assert.deepStrictEqual(doc.chunks['minecraft:the_end'], [{ x: -3, z: 4, time: 1791736480665, force_loaded: 1791602113664 }]);
    assert.deepStrictEqual([doc.flag, doc.none, doc.hex, doc.neg], [true, null, 31, -25]);
    assert.throws(() => verify.parseJson5('{ a: 1 '), /JSON5/);
    assert.deepStrictEqual(verify.endClaims(read(`world/ftbchunks/${TEAM_A}.json5`)), [
        { x: 12, z: 12, forceLoaded: false },
        { x: 10, z: 5, forceLoaded: true },
        { x: 11, z: 5, forceLoaded: false },
    ]);
});

test('readSlot: positions, empty slots and outside-file chunks', () => {
    const bytes = read(R00);
    assert.deepStrictEqual(verify.readSlot(bytes, 12, 12), { present: true, x: 12, z: 12 });
    assert.deepStrictEqual(verify.readSlot(bytes, 1, 5), { present: false, why: 'header slot is empty' });
    assert.deepStrictEqual(verify.readSlot(Buffer.alloc(100), 1, 5), { present: false, why: 'region file shorter than its header' });
    const external = Buffer.from(bytes);
    const loc = external.readUInt32BE((10 + 5 * 32) * 4);
    external[(loc >>> 8) * 4096 + 4] = 0x82;
    assert.deepStrictEqual(verify.readSlot(external, 10, 5), { present: true, external: true });
});
