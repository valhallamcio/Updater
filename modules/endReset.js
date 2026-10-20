/*
 * endReset.js
 *
 * Pure parts of the `end_reset` job: job parsing, the files VU writes for the mod
 * (request.json, restore.json), the plan summary for staff and the player mails.
 *
 * The contract is bifrost-lib docs/invariants/end-reset.md. The mod reads and writes NBT in
 * the JVM. VU only reads files through the panel and writes the two request files.
 */

const crypto = require('crypto');
const { buildMailDoc, hasForbiddenTags, BODY_CAP } = require('../discord/commands/util/mailDoc');

const JOB_TYPE = 'end_reset';
const SCHEMA = 1;
const ACTIONS = ['plan', 'apply', 'verify', 'mail', 'restore'];

const JOB_DIR = 'config/biforesting/end-reset';
const PATHS = {
    dir: JOB_DIR,
    plan: `${JOB_DIR}/plan.json`,
    request: `${JOB_DIR}/request.json`,
    restore: `${JOB_DIR}/restore.json`,
    result: `${JOB_DIR}/result.json`,
    resultOf: id => `${JOB_DIR}/result.${id}.json`,
    manifest: resetId => `zips/end-reset-${resetId}/manifest.json`,
};

/** The verify step reads the 26.x layout only. Phase 4 adds the other versions. */
const SUPPORTED_MC = /^26\./;

const PLAN_OP = 'end_reset_plan';
const FIX_STATE_APPLIED = 'applied';
const SERVER_ID_RE = /^[0-9a-f]{8}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const DEFAULT_WARN_MINUTES = 15;
const DEFAULT_WINDOW_MINUTES = 60;
// The request opens a little before the stop, so clock skew between VU and the node does
// not refuse it, and a crash restart long before the planned reboot does not apply it.
const WINDOW_LEAD_MS = 5 * 60000;

const MAIL_FROM = 'ValhallaMC';

/** A ULID: 48 bits of time in ms, then 80 random bits, Crockford base32. */
function ulid(now = Date.now(), random = crypto.randomBytes(10)) {
    let t = Math.floor(now);
    let time = '';
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[t % 32] + time;
        t = Math.floor(t / 32);
    }
    let bits = 0n;
    for (const b of random) bits = (bits << 8n) | BigInt(b);
    let rand = '';
    for (let i = 0; i < 16; i++) {
        rand = CROCKFORD[Number(bits & 31n)] + rand;
        bits >>= 5n;
    }
    return time + rand;
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function md5(bytes) {
    return crypto.createHash('md5').update(bytes).digest('hex');
}

function isoZ(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toEpochMs(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : NaN;
}

function boundedInt(value, fallback, min, max) {
    if (value == null) return { ok: true, value: fallback };
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return { ok: false };
    return { ok: true, value: n };
}

/**
 * Checks one schedule_jobs doc of type end_reset.
 * @returns {{ok: true, job: object}|{ok: false, error: string}}
 */
function parseJob(doc) {
    const fail = error => ({ ok: false, error });
    if (!doc || doc.type !== JOB_TYPE) return fail(`The job type is not ${JOB_TYPE}.`);

    const action = String(doc.action || '');
    if (!ACTIONS.includes(action)) return fail(`Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`);

    const instanceServerId = String(doc.instanceServerId || '').trim().toLowerCase();
    if (!SERVER_ID_RE.test(instanceServerId)) {
        return fail('instanceServerId must be the 8-character panel id. Tags are not unique, so a tag is refused.');
    }

    const job = {
        id: doc._id,
        action,
        instanceServerId,
        serverTag: doc.serverTag ? String(doc.serverTag) : null,
        requestedBy: String(doc.requestedBy || 'unknown'),
        phase: doc.phase || null,
        mailDryRun: doc.mailDryRun === true,
    };

    if (action === 'apply') {
        const planId = String(doc.planId || '');
        if (!ULID_RE.test(planId)) return fail('An apply job needs the planId of a dry run.');
        job.planId = planId;
        job.ignoreUnsupported = doc.ignoreUnsupported === true;
        job.sendMails = doc.sendMails !== false;
    }

    if (action === 'verify' || action === 'mail' || action === 'restore' || (action === 'apply' && doc.resetId)) {
        const resetId = String(doc.resetId || '');
        if (!ULID_RE.test(resetId)) return fail(`A ${action} job needs the resetId of a reset.`);
        job.resetId = resetId;
    }

    if (action === 'restore') {
        job.confirmLoss = doc.confirmLoss === true;
        if (doc.restoreId) {
            if (!ULID_RE.test(String(doc.restoreId))) return fail('restoreId is not a ULID.');
            job.restoreId = String(doc.restoreId);
        }
    }

    if (action === 'apply' || action === 'restore') {
        const warn = boundedInt(doc.warnWindow, DEFAULT_WARN_MINUTES, 1, 60);
        if (!warn.ok) return fail('warnWindow must be a whole number of minutes from 1 to 60.');
        const windowMinutes = boundedInt(doc.windowMinutes, DEFAULT_WINDOW_MINUTES, 15, 720);
        if (!windowMinutes.ok) return fail('windowMinutes must be a whole number from 15 to 720.');
        const fireAt = toEpochMs(doc.fireAt);
        if (Number.isNaN(fireAt)) return fail('fireAt is not a time.');
        job.warnWindow = warn.value;
        job.windowMinutes = windowMinutes.value;
        job.fireAt = fireAt;
        job.notBefore = toEpochMs(doc.notBefore);
        job.notAfter = toEpochMs(doc.notAfter);
    }
    return { ok: true, job };
}

/** Parses one of the mod's JSON files and refuses a schema this reader does not know. */
function parseContractFile(text, name) {
    let data;
    try {
        data = JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : String(text));
    } catch (err) {
        throw new Error(`${name} is not valid JSON: ${err.message}`);
    }
    if (!data || typeof data !== 'object') throw new Error(`${name} is not a JSON object.`);
    if (data.schema !== SCHEMA) throw new Error(`${name} has schema ${data.schema}. This reader knows schema ${SCHEMA} only.`);
    return data;
}

const parsePlan = text => parseContractFile(text, 'plan.json');
const parseResult = text => parseContractFile(text, 'result.json');
const parseManifest = text => parseContractFile(text, 'manifest.json');

function listOf(value) {
    return Array.isArray(value) ? value : [];
}

function countBy(records, key) {
    const out = {};
    for (const r of listOf(records)) {
        const k = String(r[key] || 'unknown');
        out[k] = (out[k] || 0) + 1;
    }
    return out;
}

function countText(counts) {
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`);
    return parts.length ? parts.join(', ') : 'none';
}

function playerLabel(p) {
    return cleanName(p.name) || String(p.player || '?');
}

/** Totals for the summary. The plan's own totals win; the lists fill the gaps. */
function planTotals(plan) {
    const t = plan.totals || {};
    const moved = listOf(plan.zoneClaimMoves).reduce((n, m) => n + listOf(m.chunks).length, 0);
    return {
        kept: t.kept ?? listOf(plan.keptChunks).length,
        moved: t.moved ?? moved,
        wiped: t.wiped ?? (plan.wipe && plan.wipe.chunkCount) ?? 0,
        players: listOf(plan.affectedPlayers).length,
    };
}

/**
 * The staff text for a dry run.
 * @param {object} plan Parsed plan.json.
 * @param {object} [opts] { serverLabel, planSha256 }.
 * @returns {string}
 */
function summarizePlan(plan, opts = {}) {
    const totals = planTotals(plan);
    const radius = plan.zone && plan.zone.radiusChunks;
    const lines = [];
    lines.push(`Server: ${opts.serverLabel || plan.serverId} (${plan.mc || '?'} ${plan.loader || ''})`.trim());
    lines.push(`Plan: \`${plan.planId}\`${opts.planSha256 ? ` sha256 \`${opts.planSha256.slice(0, 12)}\`` : ''}, made ${plan.createdAt || '?'}`);
    lines.push(`Zone: ${radius ?? '?'} chunks around 0,0`);
    lines.push(`Chunks: kept ${totals.kept}, moved ${totals.moved}, wiped ${totals.wiped}`);
    lines.push(`Region files: ${countText(countBy(plan.wipe && plan.wipe.regions, 'action'))}`);

    for (const move of listOf(plan.zoneClaimMoves)) {
        const team = move.team || {};
        const off = listOf(move.offset);
        lines.push(`- Team ${cleanName(team.shortName) || team.id}: ${listOf(move.chunks).length} chunks, offset ${off[0]} ${off[1]}`);
    }

    lines.push(`Force-loads: ${countText(countBy(plan.forceLoads, 'action'))}`);
    lines.push(`Homes: ${countText(countBy(plan.homes, 'action'))}`);
    lines.push(`Waystones: ${countText(countBy(plan.waystones, 'action'))}`);
    lines.push(`Warps: ${countText(countBy(plan.warps, 'action'))}`);
    lines.push(`Back positions: ${countText(countBy(plan.backPositions, 'action'))}`);
    lines.push(`Offline players: ${countText(countBy(plan.offlinePlayers, 'action'))}`);

    const fight = plan.fight || {};
    lines.push(`Fight: needs scan ${fight.needs_state_scanning ? 'yes' : 'no'}, dragon killed ${fight.dragon_killed ? 'yes' : 'no'}, ${listOf(fight.gateways).length} gateways left`);
    const kept = listOf(plan.gatewaysInKeptChunks);
    if (kept.length) lines.push(`Gateways in kept chunks: ${kept.length} (${countText(countBy(kept, 'action'))})`);
    const inner = listOf(plan.innerGateways);
    if (inner.length) lines.push(`Inner gateways to rebuild: ${inner.length} (spots ${inner.map(g => g.index).join(', ')})`);
    const fixes = listOf(plan.requiresFixes);
    if (fixes.length) lines.push(`Requires fixes: ${fixes.join(', ')}. Apply checks they are applied on the server.`);

    if (plan.backupBytes != null) lines.push(`Backup size: ${(plan.backupBytes / 1024 ** 3).toFixed(2)} GB`);

    const unsupported = listOf(plan.unsupported);
    lines.push(unsupported.length
        ? `Unsupported: ${unsupported.map(u => `${u.mod} (${u.reason})`).join('; ')}. Apply stops unless the job sets ignoreUnsupported.`
        : 'Unsupported: none');

    const affected = listOf(plan.affectedPlayers);
    const names = affected.map(playerLabel);
    const shown = names.slice(0, 40).join(', ');
    lines.push(`Affected players (${affected.length}): ${shown || 'none'}${names.length > 40 ? `, and ${names.length - 40} more` : ''}`);
    return lines.join('\n');
}

/** Fix states from the `bf fixes` lines: `<id>: <state>, on|off, target ...`. */
function parseFixStates(output) {
    const states = new Map();
    for (const line of String(output || '').split('\n')) {
        const m = /^\s*([a-z0-9][a-z0-9_.-]*): (applied|pending\([^)]*\)|skipped\([^)]*\)),/.exec(line);
        if (m) states.set(m[1], m[2]);
    }
    return states;
}

/**
 * Problems that stop an apply. An empty list is a go.
 * @param {object} plan Parsed plan.json.
 * @param {object} opts { ignoreUnsupported, disk: {limitBytes, usedBytes}|null,
 *   fixStates: Map of fix id to state from the live server, or null when unknown }.
 * @returns {string[]}
 */
function preflight(plan, opts = {}) {
    const problems = [];
    // A required fix stops the boot even with ignoreUnsupported, so it stops the apply too.
    for (const fix of listOf(plan.requiresFixes)) {
        const listed = listOf(plan.unsupported).find(u => String(u.reason || '').startsWith(`fix ${fix} is `));
        const state = opts.fixStates ? opts.fixStates.get(fix) : undefined;
        if (listed) problems.push(`The dry run found ${listed.reason}.`);
        else if (!opts.fixStates) problems.push(`The plan requires fix ${fix}, and VU could not read the fix states of the server.`);
        else if (state !== FIX_STATE_APPLIED) problems.push(`The plan requires fix ${fix}. The server says ${state || 'nothing about it'}.`);
    }
    if (!SUPPORTED_MC.test(String(plan.mc || ''))) {
        problems.push(`The plan is for Minecraft ${plan.mc}. VU can verify 26.x only.`);
    }
    if (plan.dimension && plan.dimension !== 'minecraft:the_end') {
        problems.push(`The plan is for ${plan.dimension}. Only minecraft:the_end is allowed.`);
    }
    const unsupported = listOf(plan.unsupported);
    if (unsupported.length && !opts.ignoreUnsupported) {
        problems.push(`The plan lists unsupported mods: ${unsupported.map(u => u.mod).join(', ')}. Set ignoreUnsupported on the job to go on.`);
    }
    const backup = Number(plan.backupBytes);
    if (!Number.isFinite(backup) || backup < 0) {
        problems.push('The plan has no backupBytes value.');
    } else if (!opts.disk) {
        problems.push('The panel gave no disk numbers, so the backup space is not known.');
    } else if (opts.disk.limitBytes > 0) {
        const free = opts.disk.limitBytes - opts.disk.usedBytes;
        if (free < 2 * backup) {
            const gb = b => `${(b / 1024 ** 3).toFixed(2)} GB`;
            problems.push(`Free disk ${gb(free)} is less than twice the backup size (${gb(2 * backup)}).`);
        }
    }
    return problems;
}

/**
 * The request window around the reboot.
 * @returns {{notBefore: number, notAfter: number}} epoch ms.
 */
function requestWindow(fireAt, windowMinutes = DEFAULT_WINDOW_MINUTES) {
    return { notBefore: fireAt - WINDOW_LEAD_MS, notAfter: fireAt + windowMinutes * 60000 };
}

/** The bytes of request.json. */
function buildRequest({ resetId, planId, planSha256, notBefore, notAfter, requestedBy, ignoreUnsupported }) {
    if (!ULID_RE.test(String(resetId))) throw new Error('resetId is not a ULID.');
    if (!ULID_RE.test(String(planId))) throw new Error('planId is not a ULID.');
    if (!/^[0-9a-f]{64}$/.test(String(planSha256))) throw new Error('planSha256 is not a sha256 hex value.');
    if (!(notAfter > notBefore)) throw new Error('notAfter must be after notBefore.');
    return JSON.stringify({
        schema: SCHEMA,
        resetId,
        planId,
        planSha256,
        notBefore: isoZ(notBefore),
        notAfter: isoZ(notAfter),
        requestedBy: String(requestedBy || 'unknown'),
        ignoreUnsupported: ignoreUnsupported === true,
    }, null, 2) + '\n';
}

/** The bytes of restore.json. restoreId is the id the restore uses up; resetId names the reset to undo. */
function buildRestore({ restoreId, resetId, notBefore, notAfter, requestedBy }) {
    if (!ULID_RE.test(String(restoreId))) throw new Error('restoreId is not a ULID.');
    if (!ULID_RE.test(String(resetId))) throw new Error('resetId is not a ULID.');
    if (!(notAfter > notBefore)) throw new Error('notAfter must be after notBefore.');
    return JSON.stringify({
        schema: SCHEMA,
        restoreId,
        resetId,
        notBefore: isoZ(notBefore),
        notAfter: isoZ(notAfter),
        requestedBy: String(requestedBy || 'unknown'),
    }, null, 2) + '\n';
}

// ── Mails ────────────────────────────────────────────────────────────────────

/** Player text goes out as MiniMessage, so angle brackets and control characters go. */
function cleanName(value, max = 64) {
    return String(value == null ? '' : value).replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function pos(p) {
    return Array.isArray(p) && p.length >= 3 ? `${p[0]} ${p[1]} ${p[2]}` : '?';
}

function quoted(detail) {
    const name = cleanName(detail);
    return name ? ` "${name}"` : '';
}

function signed(n) {
    return n >= 0 ? `+${n}` : String(n);
}

/** One line per reason kind. A kind this table does not know still gets a line. */
const REASON_LINES = {
    claim_moved: r => `Claim moved from ${pos(r.old)} to ${pos(r.new)}${r.detail ? ` (${cleanName(r.detail, 100)})` : ''}.`,
    home_moved: r => `Home${quoted(r.detail)} moved from ${pos(r.old)} to ${pos(r.new)}.`,
    home_removed: r => `Home${quoted(r.detail)} at ${pos(r.old)} was removed. The land there was reset.`,
    waystone_moved: r => `Waystone${quoted(r.detail)} moved from ${pos(r.old)} to ${pos(r.new)}.`,
    waystone_removed: r => `Waystone${quoted(r.detail)} at ${pos(r.old)} was removed. The land there was reset.`,
    back_moved: r => `Your /back point moved from ${pos(r.old)} to ${pos(r.new)}.`,
    back_removed: r => `Your /back point at ${pos(r.old)} was removed.`,
    player_moved: r => `You logged out in a moved claim. You moved from ${pos(r.old)} to ${pos(r.new)}.`,
    player_to_spawn: r => `You logged out at ${pos(r.old)} in the reset area. You will log in at world spawn.`,
};

function reasonLine(r) {
    const make = REASON_LINES[r.kind];
    if (make) return make(r);
    const kind = cleanName(r.kind).replace(/_/g, ' ') || 'change';
    return r.new ? `${kind}: ${pos(r.old)} to ${pos(r.new)}.` : `${kind}: ${pos(r.old)}.`;
}

/**
 * The lines for one player. Several claim moves with the same shift become one line, so a
 * team with many chunks still fits in one mail.
 */
function reasonLines(reasons) {
    const lines = [];
    const claimGroups = new Map();
    for (const r of listOf(reasons)) {
        if (r.kind === 'claim_moved' && Array.isArray(r.old) && Array.isArray(r.new)) {
            const key = `${r.new[0] - r.old[0]},${r.new[2] - r.old[2]}`;
            if (!claimGroups.has(key)) {
                claimGroups.set(key, []);
                lines.push({ group: key });
            }
            claimGroups.get(key).push(r);
        } else {
            lines.push({ text: reasonLine(r) });
        }
    }
    return lines.map(l => {
        if (!l.group) return l.text;
        const group = claimGroups.get(l.group);
        if (group.length === 1) return reasonLine(group[0]);
        const [dx, dz] = l.group.split(',').map(Number);
        const first = group[0];
        return `${group.length} claimed chunks moved by x ${signed(dx)}, z ${signed(dz)}. Example: ${pos(first.old)} is now ${pos(first.new)}.`;
    });
}

/**
 * The mail text for one affected player, at most BODY_CAP characters.
 * @param {object} player { player, name, reasons }.
 * @param {object} [opts] { serverLabel }.
 */
function mailText(player, opts = {}) {
    const where = opts.serverLabel ? ` on ${cleanName(opts.serverLabel)}` : '';
    const head = `The End${where} was reset. Changes for you:`;
    const lines = reasonLines(player.reasons);
    let text = head;
    for (let i = 0; i < lines.length; i++) {
        const rest = lines.length - i - 1;
        const tail = rest > 0 ? `\nAnd ${rest} more. Ask staff for the full list.` : '';
        const next = `${text}\n${lines[i]}`;
        if (next.length + tail.length > BODY_CAP) {
            const more = lines.length - i;
            const cut = `${text}\nAnd ${more} more. Ask staff for the full list.`;
            return cut.length <= BODY_CAP ? cut : cut.slice(0, BODY_CAP);
        }
        text = next;
    }
    return text;
}

function normalizeUuid(value) {
    const raw = String(value || '').trim().toLowerCase();
    const hex = raw.replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/.test(hex)) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The dedupe key of one mail: a re-run of the mail step skips players who have it. */
function mailKey(resetId, uuid) {
    return `end-reset-${resetId}-${uuid}`;
}

/**
 * One bifrost.mail doc per affected player.
 * @param {object[]} affectedPlayers The affectedPlayers list of result.json (or plan.json for a dry run).
 * @param {object} opts { resetId, serverId, serverLabel, now }.
 * @returns {Array<{player, name, text, doc?, error?}>}
 */
function buildMails(affectedPlayers, opts = {}) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const out = [];
    for (const p of listOf(affectedPlayers)) {
        const uuid = normalizeUuid(p.player);
        const name = cleanName(p.name);
        const text = mailText(p, opts);
        if (!uuid) {
            out.push({ player: String(p.player), name, text, error: 'No valid uuid.' });
            continue;
        }
        if (hasForbiddenTags(text)) {
            out.push({ player: uuid, name, text, error: 'The text has a click or hover tag.' });
            continue;
        }
        const built = buildMailDoc({ toUuid: uuid, toName: name, fromName: MAIL_FROM, text, now });
        if (!built.ok) {
            out.push({ player: uuid, name, text, error: built.error });
            continue;
        }
        built.doc.meta = {
            via: 'end_reset',
            resetId: String(opts.resetId || ''),
            serverId: String(opts.serverId || ''),
            key: mailKey(opts.resetId, uuid),
        };
        out.push({ player: uuid, name, text, doc: built.doc });
    }
    return out;
}

/** The mails as plain text, for a dry run print or a staff attachment. */
function mailsAsText(mails) {
    return mails.map(m => {
        const head = `To ${m.name || '?'} (${m.player}), ${m.text.length} chars${m.error ? `, NOT SENT: ${m.error}` : ''}`;
        return `${head}\n${m.text}`;
    }).join('\n\n');
}

module.exports = {
    JOB_TYPE,
    SCHEMA,
    ACTIONS,
    PATHS,
    PLAN_OP,
    FIX_STATE_APPLIED,
    SUPPORTED_MC,
    ULID_RE,
    DEFAULT_WARN_MINUTES,
    DEFAULT_WINDOW_MINUTES,
    WINDOW_LEAD_MS,
    ulid,
    sha256,
    md5,
    isoZ,
    parseJob,
    parsePlan,
    parseResult,
    parseManifest,
    planTotals,
    summarizePlan,
    parseFixStates,
    preflight,
    requestWindow,
    buildRequest,
    buildRestore,
    cleanName,
    reasonLine,
    reasonLines,
    mailText,
    normalizeUuid,
    mailKey,
    buildMails,
    mailsAsText,
};
