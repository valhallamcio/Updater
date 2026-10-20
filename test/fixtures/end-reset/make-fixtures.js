/*
 * Writes the binary and md5 parts of the End reset fixture: the fight file, three region files,
 * a new poi file for the move targets, two FTB Chunks team files and the manifest. plan.json,
 * result.json, boot-log.txt and the two real 26.1.2 fight files (fight-fresh.dat from evol #3
 * 2026-10-20, fight-killed.dat from evol #1 2026-10-19) are kept by hand.
 *
 * The NBT is written by hand here, so the fixture does not come from mc-nbt-lib, the reader
 * under test. Output is deterministic.
 *
 * World state after the reset and the first save:
 *   - kept chunk (12,12) with an outer gateway at (204,75,204), exit (-1,75,96) (rebuild_inner);
 *   - targets (10,5) and (11,5) of the moved party;
 *   - kept chunk (-40,3) of a solo team;
 *   - chunk (-1,6), new after the boot, with the inner gateway of spot 5 at (-1,75,96):
 *     bedrock, end_gateway, bedrock, exit at the outer gateway.
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
// The seed list of the real evol #3 fight file, minus spot 5 (rebuilt as an inner gateway).
const GATEWAYS = [11, 14, 12, 2, 4, 9, 7, 17, 6, 15, 10, 1, 16, 3, 18, 0, 13, 8, 19];

const md5 = b => crypto.createHash('md5').update(b).digest('hex');

// ── A small NBT writer: { t: type, v: value } ───────────────────────────────

const TYPE = { byte: 1, int: 3, long: 4, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 };
const byte = v => ({ t: 'byte', v });
const int = v => ({ t: 'int', v });
const long = v => ({ t: 'long', v: BigInt(v) });
const str = v => ({ t: 'string', v });
const list = (of, v) => ({ t: 'list', of, v });
const comp = v => ({ t: 'compound', v });
const ints = v => ({ t: 'intArray', v });
const longs = v => ({ t: 'longArray', v });

function nbtString(s) {
    const b = Buffer.from(s, 'utf8');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(b.length);
    return Buffer.concat([head, b]);
}

function payload(tag) {
    switch (tag.t) {
        case 'byte': return Buffer.from([tag.v & 0xff]);
        case 'int': { const b = Buffer.alloc(4); b.writeInt32BE(tag.v); return b; }
        case 'long': { const b = Buffer.alloc(8); b.writeBigInt64BE(tag.v); return b; }
        case 'string': return nbtString(tag.v);
        case 'intArray': {
            const b = Buffer.alloc(4 + 4 * tag.v.length);
            b.writeInt32BE(tag.v.length);
            tag.v.forEach((n, i) => b.writeInt32BE(n, 4 + 4 * i));
            return b;
        }
        case 'longArray': {
            const b = Buffer.alloc(4 + 8 * tag.v.length);
            b.writeInt32BE(tag.v.length);
            tag.v.forEach((n, i) => b.writeBigInt64BE(BigInt.asIntN(64, n), 4 + 8 * i));
            return b;
        }
        case 'list': {
            const head = Buffer.alloc(5);
            head.writeUInt8(tag.v.length ? TYPE[tag.of] : 0);
            head.writeInt32BE(tag.v.length, 1);
            return Buffer.concat([head, ...tag.v.map(v => payload({ t: tag.of, v }))]);
        }
        case 'compound': {
            const parts = Object.entries(tag.v).map(([k, v]) => Buffer.concat([Buffer.from([TYPE[v.t]]), nbtString(k), payload(v)]));
            return Buffer.concat([...parts, Buffer.from([0])]);
        }
    }
    throw new Error(`no writer for ${tag.t}`);
}

const root = tag => Buffer.concat([Buffer.from([TYPE.compound]), nbtString(''), payload(tag)]);

// ── Chunks ──────────────────────────────────────────────────────────────────

/** One section with the given blocks; the rest is air. blocks: [[x, y, z, name]] in world coords. */
function section(sy, blocks) {
    const names = ['minecraft:air', ...new Set(blocks.map(b => b[3]))];
    const bits = Math.max(4, Math.ceil(Math.log2(names.length)));
    const perLong = Math.floor(64 / bits);
    const data = new Array(Math.ceil(4096 / perLong)).fill(0n);
    for (const [x, y, z, name] of blocks) {
        const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
        data[Math.floor(i / perLong)] |= BigInt(names.indexOf(name)) << BigInt((i % perLong) * bits);
    }
    return {
        Y: byte(sy),
        block_states: comp({ palette: list('compound', names.map(n => ({ Name: str(n) }))), data: longs(data) }),
    };
}

function gatewayBe(x, y, z, exit) {
    return { id: str('minecraft:end_gateway'), x: int(x), y: int(y), z: int(z), Age: long(1200), ExactTeleport: byte(0), exit_portal: ints(exit) };
}

/** A 26.x chunk: DataVersion, xPos, zPos, Status, sections, block_entities. */
function chunkNbt(cx, cz, extra = {}) {
    return root(comp({
        DataVersion: int(4790), xPos: int(cx), zPos: int(cz), Status: str('minecraft:full'),
        sections: list('compound', extra.sections || []),
        block_entities: list('compound', extra.blockEntities || []),
    }));
}

/** A region file with the given chunks, zlib (type 2), each padded to 4 KiB sectors. */
function region(chunks) {
    const header = Buffer.alloc(8192);
    const bodies = [];
    let sector = 2;
    for (const c of chunks) {
        const [cx, cz] = c.at;
        const data = zlib.deflateSync(chunkNbt(cx, cz, c));
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

const fight = write(`${END}/data/minecraft/ender_dragon_fight.dat`, zlib.gzipSync(root(comp({
    DataVersion: int(4790),
    data: comp({
        respawn_time: int(0), needs_state_scanning: byte(1), dragon_killed: byte(0),
        gateways: list('int', GATEWAYS), previously_killed: byte(0),
    }),
}))));

const r00 = write(`${END}/region/r.0.0.mca`, region([
    { at: [12, 12], blockEntities: [gatewayBe(204, 75, 204, [-1, 75, 96])] },
    { at: [10, 5] },
    { at: [11, 5] },
]));
const r20 = write(`${END}/region/r.-2.0.mca`, region([{ at: [-40, 3] }]));
// r.-1.0 moved out whole; the boot made a new one for the inner gateway chunk.
write(`${END}/region/r.-1.0.mca`, region([{
    at: [-1, 6],
    sections: [section(4, [[-1, 74, 96, 'minecraft:bedrock'], [-1, 75, 96, 'minecraft:end_gateway'], [-1, 76, 96, 'minecraft:bedrock']])],
    blockEntities: [gatewayBe(-1, 75, 96, [204, 75, 204])],
}]));
// The poi track had no r.0.0 before the reset; the engine creates it for the targets.
const poi00 = write(`${END}/poi/r.0.0.mca`, region([{ at: [10, 5] }, { at: [11, 5] }]));
const teamA = write(`world/ftbchunks/${TEAM_A}.json5`, Buffer.from(claimFile([
    { x: 12, z: 12, time: 1791736480665 },
    { x: 10, z: 5, time: 1792900930000, force: 1792900930000 },
    { x: 11, z: 5, time: 1792900930000 },
], ['a1b2c3d4-0000-4000-8000-000000000001', 'a1b2c3d4-0000-4000-8000-000000000002'])));
write(`world/ftbchunks/${TEAM_B}.json5`, Buffer.from(claimFile([
    { x: -40, z: 3, time: 1791736480665 },
], ['a1b2c3d4-0000-4000-8000-000000000003'])));
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
        { path: `${END}/poi/r.0.0.mca`, backup: null, bytes: poi00.length, md5Before: null, action: 'created', md5After: md5(poi00), writtenAt: WRITTEN_AT },
    ],
};
write(`zips/end-reset-${RESET_ID}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
console.log('fixtures written');
