/*
 * endResetVerify.js
 *
 * Checks an applied End reset with mc-nbt-lib, a reader that shares no code with the Java
 * writer in the mod. It reads the files through an `io` object, so the same checks run on
 * the panel (panelIo) and on a local copy or fixture dir (localIo).
 *
 * Checks (bifrost-lib docs/invariants/end-reset.md, "Verify"):
 *   - result.json says applied and matches the reset; the manifest is complete;
 *   - the fight file has the result.json flags;
 *   - every kept chunk and every move target sits in its region file at its own position;
 *   - every move target is claimed by the same team, and no read claim is left in the zone;
 *   - each gateway in a kept chunk has the exit its action says;
 *   - each rebuilt inner gateway is an end_gateway between bedrock with its exit at the outer
 *     gateway, after the `inner gateways: N built` step line;
 *   - each rewritten file still has its md5After, unless the game saved it after the reset;
 *   - the boot log has the engine's done line and no "killed already" line.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { NBT } = require('mc-nbt-lib/nbt-core');
const { MCAFile } = require('mc-nbt-lib/mca-handler');
const { md5, PATHS } = require('./endReset');

const END = 'minecraft:the_end';
const KILLED_LINE = 'Found that the dragon has been killed in this world already';
const NOT_KILLED_LINE = 'Found that the dragon has not yet been killed in this world';
const DEFAULT_RADIUS = 8;

const endDir = level => `${level || 'world'}/dimensions/minecraft/the_end`;
const fightPath = level => `${endDir(level)}/data/minecraft/ender_dragon_fight.dat`;
const regionPath = (level, cx, cz) => `${endDir(level)}/region/r.${cx >> 5}.${cz >> 5}.mca`;
const claimPath = (level, teamId) => `${level || 'world'}/ftbchunks/${teamId}.json5`;
// Exactly one outcome line per job starts with `[Biforesting] end reset <resetId>:`. Step lines
// use `end reset <resetId> step:` and never match.
const outcomeLine = resetId => `[Biforesting] end reset ${resetId}:`;
const doneLine = resetId => `${outcomeLine(resetId)} DONE applied`;

/** `{built, failed}` from the inner gateway step line, or null before the server started. */
function innerGatewaysLine(logText, resetId) {
    const esc = String(resetId).replace(/[^0-9A-Z]/g, '');
    const m = new RegExp(`\\[Biforesting\\] end reset ${esc} step: inner gateways: (\\d+) built, (\\d+) failed`).exec(String(logText || ''));
    return m ? { built: Number(m[1]), failed: Number(m[2]) } : null;
}

// ── JSON5 (FTB Chunks team files) ───────────────────────────────────────────

/**
 * A small JSON5 reader: unquoted keys, single quotes, trailing commas and comments.
 * That is the part FTB Chunks writes.
 */
function parseJson5(text) {
    const s = String(text);
    let i = 0;
    const fail = msg => { throw new Error(`JSON5: ${msg} at offset ${i}`); };
    const IDENT = /[A-Za-z_$][\w$]*/y;
    const NUMBER = /[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)/y;

    function skip() {
        for (;;) {
            const c = s[i];
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\ufeff') { i++; continue; }
            if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
            if (c === '/' && s[i + 1] === '*') {
                const end = s.indexOf('*/', i + 2);
                if (end < 0) fail('open comment');
                i = end + 2;
                continue;
            }
            return;
        }
    }
    function str() {
        const q = s[i++];
        let out = '';
        while (i < s.length && s[i] !== q) {
            if (s[i] === '\\') {
                const e = s[i + 1];
                if (e === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
                out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' }[e] ?? e;
                i += 2;
                continue;
            }
            out += s[i++];
        }
        if (s[i] !== q) fail('open string');
        i++;
        return out;
    }
    function word(re) {
        re.lastIndex = i;
        const m = re.exec(s);
        if (!m) return null;
        i = re.lastIndex;
        return m[0];
    }
    function value() {
        skip();
        const c = s[i];
        if (c === '{') return obj();
        if (c === '[') return arr();
        if (c === '"' || c === "'") return str();
        const num = word(NUMBER);
        if (num !== null) return num.startsWith('0x') || num.startsWith('0X') ? parseInt(num, 16) : Number(num);
        const id = word(IDENT);
        if (id === 'true') return true;
        if (id === 'false') return false;
        if (id === 'null') return null;
        return fail(`unexpected ${id === null ? JSON.stringify(c) : id}`);
    }
    function obj() {
        i++;
        const o = {};
        for (;;) {
            skip();
            if (s[i] === '}') { i++; return o; }
            const key = s[i] === '"' || s[i] === "'" ? str() : word(IDENT);
            if (key === null) fail('expected a key');
            skip();
            if (s[i] !== ':') fail('expected :');
            i++;
            const v = value();
            if (key !== '__proto__') o[key] = v;
            skip();
            if (s[i] === ',') i++;
            else if (s[i] !== '}') fail('expected , or }');
        }
    }
    function arr() {
        i++;
        const a = [];
        for (;;) {
            skip();
            if (s[i] === ']') { i++; return a; }
            a.push(value());
            skip();
            if (s[i] === ',') i++;
            else if (s[i] !== ']') fail('expected , or ]');
        }
    }
    const out = value();
    skip();
    if (i < s.length) fail('text after the value');
    return out;
}

/** The End chunks of one FTB Chunks team file. */
function endClaims(text) {
    const doc = parseJson5(text);
    const list = doc && doc.chunks && Array.isArray(doc.chunks[END]) ? doc.chunks[END] : [];
    return list.map(c => ({ x: Number(c.x), z: Number(c.z), forceLoaded: c.force_loaded != null }));
}

// ── NBT ────────────────────────────────────────────────────────────────────

function nbtValue(tag) {
    return tag && tag.value !== undefined ? tag.value : undefined;
}

/** The 26.x fight file: gzip NBT with the fields under `data`. */
function readFight(bytes) {
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
    const root = NBT.parse(raw);
    const data = nbtValue(nbtValue(root) && nbtValue(root).data);
    if (!data) throw new Error('the fight file has no data compound');
    const flag = name => (data[name] ? Number(nbtValue(data[name])) !== 0 : null);
    const gateways = data.gateways ? nbtValue(nbtValue(data.gateways)) : null;
    return {
        needs_state_scanning: flag('needs_state_scanning'),
        dragon_killed: flag('dragon_killed'),
        previously_killed: flag('previously_killed'),
        hasDragonUuid: !!data.dragon_uuid,
        exitPortal: data.exit_portal_location ? Array.from(nbtValue(data.exit_portal_location)) : null,
        gateways: Array.isArray(gateways) ? gateways.map(Number) : null,
    };
}

/**
 * One chunk slot of a region file. The header is read here; the payload goes through
 * mc-nbt-lib. A chunk stored outside the file (.mcc) is checked by its header only.
 * @returns {{present: boolean, why?: string, x?: number, z?: number, external?: boolean}}
 */
function readSlot(bytes, cx, cz) {
    if (!bytes) return { present: false, why: 'region file missing' };
    if (bytes.length < 8192) return { present: false, why: 'region file shorter than its header' };
    const slot = (cx & 31) + (cz & 31) * 32;
    const loc = bytes.readUInt32BE(slot * 4);
    const offset = loc >>> 8;
    const count = loc & 0xff;
    if (offset === 0 || count === 0) return { present: false, why: 'header slot is empty' };
    if (offset < 2 || offset * 4096 + 5 > bytes.length) return { present: false, why: 'header points outside the file' };
    if (bytes.readUInt8(offset * 4096 + 4) & 0x80) return { present: true, external: true };
    try {
        const chunk = new MCAFile().readChunk(bytes, { offset, count });
        const root = nbtValue(chunk) || {};
        return { present: true, x: nbtValue(root.xPos), z: nbtValue(root.zPos) };
    } catch (err) {
        return { present: false, why: `payload unreadable: ${err.message}` };
    }
}

/** mc-nbt-lib's typed tree as plain values. Longs stay BigInt. */
function plain(tag) {
    if (!tag || typeof tag !== 'object' || !('type' in tag)) return tag;
    if (tag.type === 'compound') {
        const out = {};
        for (const [k, v] of Object.entries(tag.value)) out[k] = plain(v);
        return out;
    }
    if (tag.type === 'list') return tag.value.value.map(v => plain({ type: tag.value.type, value: v }));
    return tag.value;
}

/** The decoded chunk at a block position, or a reason why not. */
async function chunkAt(files, level, x, z) {
    const cx = x >> 4;
    const cz = z >> 4;
    const bytes = await files.readBinary(regionPath(level, cx, cz));
    if (!bytes) return { why: `region file of chunk [${cx}, ${cz}] missing` };
    if (bytes.length < 8192) return { why: `region file of chunk [${cx}, ${cz}] shorter than its header` };
    const loc = bytes.readUInt32BE(((cx & 31) + (cz & 31) * 32) * 4);
    if (!(loc >>> 8)) return { why: `chunk [${cx}, ${cz}] not in its region file` };
    if (bytes.readUInt8((loc >>> 8) * 4096 + 4) & 0x80) return { why: `chunk [${cx}, ${cz}] is stored outside the region file` };
    try {
        return { chunk: plain(new MCAFile().readChunk(bytes, { offset: loc >>> 8, count: loc & 0xff })) };
    } catch (err) {
        return { why: `chunk [${cx}, ${cz}] unreadable: ${err.message}` };
    }
}

/** The block name at a position: palette index packed in longs, entries never span two longs. */
function blockAt(chunk, x, y, z) {
    const section = (chunk.sections || []).find(s => Number(s.Y) === (y >> 4));
    const states = section && section.block_states;
    const palette = (states && states.palette) || [];
    if (!palette.length) return 'minecraft:air';
    if (palette.length === 1 || !states.data) return palette[0].Name;
    const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const perLong = Math.floor(64 / bits);
    const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    const word = BigInt.asUintN(64, BigInt(states.data[Math.floor(i / perLong)]));
    const index = Number((word >> BigInt((i % perLong) * bits)) & ((1n << BigInt(bits)) - 1n));
    return palette[index] ? palette[index].Name : `palette index ${index} out of range`;
}

function blockEntityAt(chunk, x, y, z) {
    return (chunk.block_entities || []).find(be => be.x === x && be.y === y && be.z === z) || null;
}

const samePos = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a.every((v, i) => Number(v) === Number(b[i]));
const posText = p => (Array.isArray(p) ? p.join(' ') : String(p));

// ── File access ────────────────────────────────────────────────────────────

/** Files under a local dir. Paths are server-root relative. */
function localIo(root) {
    const full = p => path.join(root, p);
    return {
        async readBinary(p) {
            try { return fs.readFileSync(full(p)); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
        },
        async readText(p) {
            const b = await this.readBinary(p);
            return b ? b.toString('utf8') : null;
        },
        async stat(p) {
            try {
                const st = fs.statSync(full(p));
                return { size: st.size, mtime: st.mtime.toISOString() };
            } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
        },
    };
}

/**
 * Files on a panel server. Small files come from files/contents, big ones (region files,
 * the log) through a signed download link: the panel caps files/contents in size.
 * @param {string} serverId Panel id.
 * @param {object} ptero modules/pterodactyl (or a test stand-in).
 * @param {object} http axios (or a test stand-in).
 */
function panelIo(serverId, ptero, http) {
    return {
        async readBinary(p) {
            const url = await ptero.getDownloadLink(serverId, p);
            if (!url) return null;
            const response = await http.get(url, {
                responseType: 'arraybuffer',
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            return Buffer.from(response.data);
        },
        async readText(p) {
            const b = await ptero.getFileContents(serverId, p);
            return b ? b.toString('utf8') : null;
        },
        async stat(p) {
            const slash = p.lastIndexOf('/');
            const dir = slash > 0 ? p.slice(0, slash) : '/';
            const name = p.slice(slash + 1);
            const entries = await ptero.listFiles(serverId, dir);
            const entry = entries.find(e => e.name === name && e.is_file !== false);
            return entry ? { size: Number(entry.size), mtime: String(entry.modified_at) } : null;
        },
    };
}

function cached(io) {
    const memo = new Map();
    return {
        ...io,
        readBinary(p) {
            if (!memo.has(p)) memo.set(p, io.readBinary(p));
            return memo.get(p);
        },
    };
}

function sameSecond(a, b) {
    const x = Date.parse(a);
    const y = Date.parse(b);
    return Number.isFinite(x) && Number.isFinite(y) && Math.floor(x / 1000) === Math.floor(y / 1000);
}

function chunkText(c) {
    return `[${c[0]}, ${c[1]}]`;
}

// ── Verify ─────────────────────────────────────────────────────────────────

/**
 * Runs every check.
 * @param {object} io { readBinary, readText, stat } (localIo or panelIo).
 * @param {object} input { plan, result, manifest, logText }. plan and result are parsed JSON.
 * @returns {Promise<{ok: boolean, checks: Array<{name, ok, detail}>, notes: string[], scanRan: boolean}>}
 */
async function verifyReset(io, input) {
    const { plan, result, manifest } = input;
    const logText = String(input.logText || '');
    const files = cached(io);
    const checks = [];
    const notes = [];
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
    const level = plan.level || 'world';
    const radius = plan.zone && Number.isInteger(plan.zone.radiusChunks) ? plan.zone.radiusChunks : DEFAULT_RADIUS;
    const resetId = result.resetId;

    // result.json and the manifest
    check('result', result.kind === 'reset' && result.status === 'applied',
        `kind ${result.kind}, status ${result.status}${result.reason ? `, reason ${result.reason}` : ''}`);
    if (!manifest) {
        check('manifest', false, `no manifest at ${result.manifest || PATHS.manifest(resetId)}`);
    } else {
        check('manifest', manifest.complete === true && manifest.resetId === resetId,
            `complete ${manifest.complete}, resetId ${manifest.resetId}, ${(manifest.files || []).length} files`);
    }

    // The fight
    const scanRan = logText.includes(NOT_KILLED_LINE);
    const killedLine = logText.includes(KILLED_LINE);
    const want = result.fight || {};
    const fightBytes = await files.readBinary(fightPath(level));
    if (!fightBytes) {
        check('fight', false, `missing ${fightPath(level)}`);
    } else {
        let fight = null;
        try {
            fight = readFight(fightBytes);
        } catch (err) {
            check('fight', false, `unreadable: ${err.message}`);
        }
        if (fight) {
            const problems = [];
            if (fight.dragon_killed !== false) problems.push(`dragon_killed ${fight.dragon_killed}`);
            if (fight.previously_killed !== !!want.previously_killed) problems.push(`previously_killed ${fight.previously_killed}, result says ${!!want.previously_killed}`);
            if (want.dragon_killed) problems.push('result.json itself says dragon_killed');
            if (!scanRan) {
                // Before the first scan the file must be what the engine wrote.
                if (fight.needs_state_scanning !== !!want.needs_state_scanning) problems.push(`needs_state_scanning ${fight.needs_state_scanning}, result says ${!!want.needs_state_scanning}`);
                if (fight.hasDragonUuid) problems.push('dragon_uuid is set');
                if (fight.exitPortal) problems.push(`exit_portal_location ${fight.exitPortal.join(' ')} is set`);
            }
            const planned = Array.isArray(want.gateways) ? want.gateways : (plan.fight && plan.fight.gateways) || [];
            const allowed = new Set(planned.map(Number));
            const extra = (fight.gateways || []).filter(g => !allowed.has(g));
            if (extra.length) problems.push(`gateways ${extra.join(', ')} are not in the ${Array.isArray(want.gateways) ? 'result' : 'plan'}`);
            check('fight', problems.length === 0, problems.length ? problems.join('; ')
                : `dragon_killed false, previously_killed false, needs_state_scanning ${fight.needs_state_scanning}, ${(fight.gateways || []).length} gateways`);
        }
    }
    if (!scanRan && !killedLine) notes.push('The dragon scan has not run yet. Run verify again after a player visits the main island.');

    // Kept chunks and move targets in their region files
    const slotProblems = async (list, label) => {
        const bad = [];
        for (const c of list) {
            const slot = readSlot(await files.readBinary(regionPath(level, c[0], c[1])), c[0], c[1]);
            if (!slot.present) bad.push(`${label} ${chunkText(c)}: ${slot.why}`);
            else if (!slot.external && (slot.x !== c[0] || slot.z !== c[1])) bad.push(`${label} ${chunkText(c)}: chunk says xPos ${slot.x} zPos ${slot.z}`);
        }
        return bad;
    };
    const kept = (plan.keptChunks || []).map(k => k.chunk);
    const keptBad = await slotProblems(kept, 'kept');
    check('kept chunks', keptBad.length === 0, keptBad.length ? keptBad.join('; ') : `${kept.length} chunks in place`);

    const moves = [];
    // The applied moves when result.json has them; the engine aborts when they differ from the plan.
    for (const m of result.zoneClaimMoves || plan.zoneClaimMoves || []) {
        for (const c of m.chunks || []) moves.push({ team: m.team && m.team.id, source: c.source, target: c.target, forceLoaded: !!c.forceLoaded });
    }
    const targetBad = await slotProblems(moves.map(m => m.target), 'target');
    check('move targets', targetBad.length === 0, targetBad.length ? targetBad.join('; ') : `${moves.length} chunks in place`);

    // Claims: the teams in the plan
    const teams = new Set([...moves.map(m => m.team), ...(plan.keptChunks || []).map(k => k.team)].filter(Boolean));
    const claims = new Map();
    const claimBad = [];
    for (const team of teams) {
        const text = await files.readText(claimPath(level, team));
        if (text == null) { claimBad.push(`team ${team}: no claim file`); continue; }
        try {
            claims.set(team, endClaims(text));
        } catch (err) {
            claimBad.push(`team ${team}: ${err.message}`);
        }
    }
    const has = (team, c) => (claims.get(team) || []).find(x => x.x === c[0] && x.z === c[1]);
    for (const m of moves) {
        if (!claims.has(m.team)) continue;
        const entry = has(m.team, m.target);
        if (!entry) claimBad.push(`target ${chunkText(m.target)} is not claimed by team ${m.team}`);
        else if (m.forceLoaded && !entry.forceLoaded) claimBad.push(`target ${chunkText(m.target)} lost its force-load`);
    }
    for (const k of plan.keptChunks || []) {
        if (claims.has(k.team) && !has(k.team, k.chunk)) claimBad.push(`kept ${chunkText(k.chunk)} is not claimed by team ${k.team}`);
    }
    const inZone = [];
    for (const [team, list] of claims) {
        for (const c of list) {
            if (Math.abs(c.x) <= radius && Math.abs(c.z) <= radius) inZone.push(`team ${team} [${c.x}, ${c.z}]`);
        }
    }
    if (inZone.length) claimBad.push(`claims left in the zone: ${inZone.join(', ')}`);
    check('claims', claimBad.length === 0, claimBad.length ? claimBad.join('; ')
        : `${moves.length} targets claimed, no claim in the zone (${teams.size} team files read)`);

    // Gateways in kept chunks: the exit their action says. A cleared exit may come back as a new
    // one once a player uses the gateway, so only the old exit is refused there.
    const keptGateways = result.gatewaysInKeptChunks || plan.gatewaysInKeptChunks || [];
    const gatewayBad = [];
    for (const g of keptGateways) {
        const [x, y, z] = g.pos;
        const at = await chunkAt(files, level, x, z);
        if (!at.chunk) { gatewayBad.push(`${posText(g.pos)}: ${at.why}`); continue; }
        const be = blockEntityAt(at.chunk, x, y, z);
        if (!be) { gatewayBad.push(`${posText(g.pos)}: no block entity`); continue; }
        const exit = be.exit_portal ? Array.from(be.exit_portal) : null;
        if (g.action === 'clear_exit') {
            if (samePos(exit, g.exitPortal)) gatewayBad.push(`${posText(g.pos)}: clear_exit, but the old exit ${posText(g.exitPortal)} is still set`);
            continue;
        }
        const want = g.action === 'move_exit' ? g.newExitPortal : g.exitPortal;
        if (!samePos(exit, want)) gatewayBad.push(`${posText(g.pos)}: ${g.action}, exit ${exit ? posText(exit) : 'none'}, want ${posText(want)}`);
    }
    check('kept gateways', gatewayBad.length === 0, gatewayBad.length ? gatewayBad.join('; ')
        : (keptGateways.length ? `${keptGateways.length} gateways have the planned exit` : 'none'));

    // Inner gateways: built at ServerStartedEvent, after the outcome line.
    const planInner = plan.innerGateways || [];
    const inner = result.innerGateways || [];
    const innerBad = [];
    if (planInner.length && !inner.length) innerBad.push(`the plan rebuilds ${planInner.length}, result.json lists none`);
    if (inner.length) {
        const line = innerGatewaysLine(logText, resetId);
        if (!line) innerBad.push('no "inner gateways: N built" line yet');
        else if (line.built !== inner.length || line.failed) innerBad.push(`log says ${line.built} built, ${line.failed} failed, of ${inner.length}`);
        for (const g of inner) {
            const [x, y, z] = g.pos;
            if (g.status !== 'built') { innerBad.push(`spot ${g.index}: status ${g.status}${g.reason ? ` (${g.reason})` : ''}`); continue; }
            const at = await chunkAt(files, level, x, z);
            if (!at.chunk) { innerBad.push(`spot ${g.index}: ${at.why}`); continue; }
            const blocks = [y - 1, y, y + 1].map(by => blockAt(at.chunk, x, by, z));
            if (blocks[1] !== 'minecraft:end_gateway') innerBad.push(`spot ${g.index}: block at ${posText(g.pos)} is ${blocks[1]}`);
            if (blocks[0] !== 'minecraft:bedrock' || blocks[2] !== 'minecraft:bedrock') innerBad.push(`spot ${g.index}: below and above are ${blocks[0]} and ${blocks[2]}`);
            const be = blockEntityAt(at.chunk, x, y, z);
            const exit = be && be.exit_portal ? Array.from(be.exit_portal) : null;
            if (!be || be.id !== 'minecraft:end_gateway') innerBad.push(`spot ${g.index}: no end_gateway block entity`);
            else if (!samePos(exit, g.exitPortal)) innerBad.push(`spot ${g.index}: exit ${exit ? posText(exit) : 'none'}, want the outer gateway ${posText(g.exitPortal)}`);
        }
    }
    check('inner gateways', innerBad.length === 0, innerBad.length ? innerBad.join('; ')
        : (inner.length ? `${inner.length} built, each exits to its outer gateway` : 'none'));

    // md5 of the files the engine rewrote
    if (manifest) {
        const md5Bad = [];
        let same = 0;
        let changed = 0;
        for (const f of manifest.files || []) {
            if ((f.action !== 'rewritten' && f.action !== 'created') || !f.md5After) continue;
            const bytes = await files.readBinary(f.path);
            if (!bytes) { md5Bad.push(`${f.path}: missing`); continue; }
            if (md5(bytes) === f.md5After) { same++; continue; }
            const st = await files.stat(f.path);
            if (st && f.writtenAt && sameSecond(st.mtime, f.writtenAt)) md5Bad.push(`${f.path}: md5 differs, mtime equals writtenAt`);
            else changed++;
        }
        check('md5', md5Bad.length === 0, md5Bad.length ? md5Bad.join('; ')
            : `${same} files match md5After${changed ? `, ${changed} saved by the game after the reset (not compared)` : ''}`);
    }

    // The boot log
    const done = logText.includes(doneLine(resetId));
    const failedOutcome = logText.split('\n').find(l => l.includes(`${outcomeLine(resetId)} FAILED`));
    check('log', done && !failedOutcome && !killedLine, [
        done ? 'DONE line present' : `no "${doneLine(resetId)}" line`,
        failedOutcome ? `FAILED line: ${failedOutcome.slice(failedOutcome.indexOf('FAILED'), failedOutcome.indexOf('FAILED') + 200)}` : null,
        killedLine ? `"${KILLED_LINE}" is present` : 'no "killed already" line',
        scanRan ? 'scan ran: dragon not killed' : null,
    ].filter(Boolean).join(', '));

    return { ok: checks.every(c => c.ok), checks, notes, scanRan };
}

/** The verify outcome as staff text. */
function verifyText(report) {
    const lines = report.checks.map(c => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
    return [...lines, ...report.notes].join('\n');
}

module.exports = {
    KILLED_LINE,
    NOT_KILLED_LINE,
    endDir,
    fightPath,
    regionPath,
    claimPath,
    outcomeLine,
    doneLine,
    innerGatewaysLine,
    plain,
    blockAt,
    parseJson5,
    endClaims,
    readFight,
    readSlot,
    localIo,
    panelIo,
    verifyReset,
    verifyText,
};
