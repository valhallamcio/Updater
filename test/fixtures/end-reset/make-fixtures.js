/*
 * Writes the binary and md5 parts of the End reset fixture: two region files, two FTB Chunks
 * team files and the manifest. plan.json, result.json, boot-log.txt and the two fight files
 * are kept by hand. The fight files are real 26.1.2 files: ender_dragon_fight.dat is a fresh
 * one (evol #3, 2026-10-20), fight-killed.dat is a trapped one (evol #1, 2026-10-19).
 *
 * The chunk NBT is written by hand here, so the fixture does not come from mc-nbt-lib, the
 * reader under test. Output is deterministic.
 *
 * Run: node test/fixtures/end-reset/make-fixtures.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;
const RESET_ID = '01JBX6Z2M4K8Q0R1S3T5V7W9YA';
const END = 'world/dimensions/minecraft/the_end';
const TEAM_A = 'eee65f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const TEAM_B = '5b1e4c2a-7d8e-4f90-a1b2-c3d4e5f60718';
const WRITTEN_AT = '2026-10-21T04:02:40Z';

const md5 = b => crypto.createHash('md5').update(b).digest('hex');

function nbtString(s) {
    const b = Buffer.from(s, 'utf8');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(b.length);
    return Buffer.concat([head, b]);
}

function nbtInt(name, value) {
    const v = Buffer.alloc(4);
    v.writeInt32BE(value);
    return Buffer.concat([Buffer.from([3]), nbtString(name), v]);
}

/** A minimal 26.x chunk: DataVersion, xPos, zPos, Status. */
function chunkNbt(cx, cz) {
    return Buffer.concat([
        Buffer.from([10]), nbtString(''),
        nbtInt('DataVersion', 4790), nbtInt('xPos', cx), nbtInt('zPos', cz),
        Buffer.from([8]), nbtString('Status'), nbtString('minecraft:full'),
        Buffer.from([0]),
    ]);
}

/** A region file with the given chunks, zlib (type 2), each padded to 4 KiB sectors. */
function region(chunks) {
    const header = Buffer.alloc(8192);
    const bodies = [];
    let sector = 2;
    for (const [cx, cz] of chunks) {
        const data = zlib.deflateSync(chunkNbt(cx, cz));
        const head = Buffer.alloc(5);
        head.writeUInt32BE(data.length + 1);
        head.writeUInt8(2, 4);
        const raw = Buffer.concat([head, data]);
        const sectors = Math.ceil(raw.length / 4096);
        const slot = (cx & 31) + (cz & 31) * 32;
        header.writeUInt32BE((sector << 8) | sectors, slot * 4);
        header.writeUInt32BE(1792900960, 4096 + slot * 4);
        bodies.push(Buffer.concat([raw, Buffer.alloc(sectors * 4096 - raw.length)]));
        sector += sectors;
    }
    return Buffer.concat([header, ...bodies]);
}

function claimFile(endChunks, members) {
    const entry = c => [
        '      {',
        `        x: ${c.x},`,
        `        z: ${c.z},`,
        `        time: ${c.time},`,
        ...(c.force ? [`        force_loaded: ${c.force},`] : []),
        '      },',
    ].join('\n');
    return [
        '{',
        '  max_claim_chunks: 500,',
        '  max_force_load_chunks: 40,',
        '  last_login_time: 1792900000000,',
        '  chunks: {',
        '    "minecraft:overworld": [',
        entry({ x: -160, z: -95, time: 1791736480665 }),
        '    ],',
        '    "minecraft:the_end": [',
        ...endChunks.map(entry),
        '    ],',
        '  },',
        '  member_data: {',
        ...members.map(m => [
            `    "${m}": {`,
            '      max_claimed_chunks: 500,',
            '      max_force_loaded_chunks: 25,',
            '      offline_force_loader: false,',
            '    },',
        ].join('\n')),
        '  },',
        '}',
        '',
    ].join('\n');
}

function write(rel, bytes) {
    const full = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    return bytes;
}

const r00 = write(`${END}/region/r.0.0.mca`, region([[12, 12], [10, 5], [11, 5]]));
const r20 = write(`${END}/region/r.-2.0.mca`, region([[-40, 3]]));
const teamA = write(`world/ftbchunks/${TEAM_A}.json5`, Buffer.from(claimFile([
    { x: 12, z: 12, time: 1791736480665 },
    { x: 10, z: 5, time: 1792900930000, force: 1792900930000 },
    { x: 11, z: 5, time: 1792900930000 },
], ['a1b2c3d4-0000-4000-8000-000000000001', 'a1b2c3d4-0000-4000-8000-000000000002'])));
write(`world/ftbchunks/${TEAM_B}.json5`, Buffer.from(claimFile([
    { x: -40, z: 3, time: 1791736480665 },
], ['a1b2c3d4-0000-4000-8000-000000000003'])));
const fight = fs.readFileSync(path.join(ROOT, `${END}/data/minecraft/ender_dragon_fight.dat`));
const plan = fs.readFileSync(path.join(ROOT, 'plan.json'));

const rewritten = (p, bytes, n, ext) => ({
    path: p, backup: `files/${String(n).padStart(4, '0')}.${ext}`, bytes: bytes.length,
    md5Before: md5(`before ${p}`), action: 'rewritten', md5After: md5(bytes), writtenAt: WRITTEN_AT,
});

const manifest = {
    schema: 1,
    resetId: RESET_ID,
    planSha256: crypto.createHash('sha256').update(plan).digest('hex'),
    createdAt: '2026-10-21T04:02:11Z',
    complete: true,
    files: [
        rewritten(`${END}/region/r.0.0.mca`, r00, 1, 'mca'),
        { path: `${END}/region/r.-1.0.mca`, backup: 'files/0002.mca', bytes: 2097152, md5Before: md5('before r.-1.0'), action: 'moved', md5After: null, writtenAt: null },
        rewritten(`${END}/region/r.-2.0.mca`, r20, 3, 'mca'),
        rewritten(`${END}/data/minecraft/ender_dragon_fight.dat`, fight, 4, 'dat'),
        rewritten(`world/ftbchunks/${TEAM_A}.json5`, teamA, 5, 'json5'),
    ],
};
write(`zips/end-reset-${RESET_ID}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
console.log('fixtures written');
