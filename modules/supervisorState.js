/*
 * supervisorState.js
 *
 * Reads standby/state.json, the file the standby supervisor writes in the server dir
 * (bifrost-lib docs/standby-supervisor.md). A server that starts through the supervisor reboots
 * inside its container: a warm reboot, a crash restore, a cold reboot. Wings stays running
 * through these, and its uptime counts from the container start. For such a server the file
 * gives the phase and the time of the last boot.
 *
 * A missing, broken or stale file means "no supervisor info". The caller then keeps the Wings
 * reading, as before the supervisor.
 */

const pterodactyl = require('./pterodactyl');
const sessionLogger = require('./sessionLogger');

const STATE_PATH = 'standby/state.json';
/** Modes with a standby: the supervisor can warm reboot and restore inside the container. */
const WARM_MODES = ['reboot-only', 'always-warm', 'always-image'];
/** A file not written for this long, while Wings says running, gives no info. */
const STALE_MS = 3 * 60 * 1000;
/** How long a "no supervisor here" answer is kept, so most servers cost one read per window. */
const DETECT_TTL_MS = 10 * 60 * 1000;
/** Phases in which the Minecraft server boots or reboots inside a running container. */
const BOOT_PHASES = ['booting', 'warm-reboot', 'cold-reboot', 'takeover'];

// serverId -> { at, supervised }
const cache = new Map();
// serverIds whose stale or unknown-schema file was logged, so a poll does not repeat it
const logged = new Set();

function time(value) {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The fields VU uses, from the raw file. Unknown fields are ignored.
 * @param {Buffer|string} raw The file contents.
 * @returns {object|null} null when the file is not schema 1 or lacks mode, phase, bootCount or updatedAt.
 */
function parse(raw) {
    let doc;
    try {
        doc = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch (_) {
        return null;
    }
    if (!doc || typeof doc !== 'object' || doc.schema !== 1) return null;
    const updatedAtMs = time(doc.updatedAt);
    const bootCount = num(doc.bootCount);
    if (typeof doc.mode !== 'string' || typeof doc.phase !== 'string' || bootCount === null || updatedAtMs === null) {
        return null;
    }
    const live = doc.live && typeof doc.live === 'object' ? doc.live : {};
    const last = doc.lastBoot && typeof doc.lastBoot === 'object' ? doc.lastBoot : {};
    return {
        mode: doc.mode,
        phase: doc.phase,
        bootCount,
        updatedAtMs,
        supervisorVersion: typeof doc.supervisorVersion === 'string' ? doc.supervisorVersion : null,
        supervisorPid: num(doc.supervisorPid),
        supervisorStartedAtMs: time(doc.supervisorStartedAt),
        live: {
            pid: num(live.pid),
            startedAtMs: time(live.startedAt),
            readyAtMs: time(live.readyAt),
            via: typeof live.via === 'string' ? live.via : null,
            bootSeconds: num(live.bootSeconds),
        },
        lastBoot: {
            kind: typeof last.kind === 'string' ? last.kind : null,
            trigger: typeof last.trigger === 'string' ? last.trigger : null,
            startedAtMs: time(last.startedAt),
            readyAtMs: time(last.readyAt),
            seconds: num(last.seconds),
            fallback: last.fallback == null ? null : last.fallback,
            cpuMs: num(last.cpuMs),
        },
    };
}

/** The supervisor wrote the file within STALE_MS (node clock against VU's clock). */
function isFresh(state, now = Date.now()) {
    return !!state && now - state.updatedAtMs <= STALE_MS;
}

function isWarmMode(state) {
    return !!state && WARM_MODES.includes(state.mode);
}

/**
 * The start of the current server JVM's boot: the later of lastBoot.startedAt and live.startedAt.
 * After a takeover, live.startedAt can be the standby's launch, long before the reboot.
 */
function bootStartedAtMs(state) {
    const times = [state.lastBoot.startedAtMs, state.live.startedAtMs].filter(t => t !== null);
    return times.length ? Math.max(...times) : null;
}

/** The ready time of the current server JVM, or null while it boots. */
function readyAtMs(state) {
    const times = [state.lastBoot.readyAtMs, state.live.readyAtMs].filter(t => t !== null);
    return times.length ? Math.max(...times) : null;
}

/**
 * The supervisor's view in Wings terms: running, starting (a boot inside the container) or
 * stopping, and the time since the last boot started (null when the file has no boot time).
 */
function view(state, now = Date.now()) {
    let power = 'running';
    if (BOOT_PHASES.includes(state.phase)) power = 'starting';
    else if (state.phase === 'stopping') power = 'stopping';
    const started = bootStartedAtMs(state);
    return { state: power, sinceBootMs: started === null ? null : Math.max(0, now - started) };
}

/** A warm reboot can start now: a standby mode, a live phase and a ready live JVM. */
function canWarmReboot(state) {
    return isWarmMode(state) && state.phase === 'live' && state.live.readyAtMs !== null;
}

/** The last known cold boot time in seconds, or null when the file has none. */
function coldBootSeconds(state) {
    if (state.lastBoot.kind === 'cold' && state.lastBoot.seconds !== null) return state.lastBoot.seconds;
    if (state.live.via === 'start' && state.live.bootSeconds !== null) return state.live.bootSeconds;
    return null;
}

/**
 * A reboot after `before` is done: the server is live and ready, a new boot was counted (or a
 * new supervisor runs, after a container restart), and it became ready after the last ready
 * time in `before`. Both times come from the node clock, so a skew with VU does not matter.
 */
function rebootDone(state, before) {
    if (!state || state.phase !== 'live') return false;
    const ready = readyAtMs(state);
    if (ready === null) return false;
    const newSupervisor = state.supervisorStartedAtMs !== null && state.supervisorStartedAtMs !== before.supervisorStartedAtMs;
    if (state.bootCount <= before.bootCount && !newSupervisor) return false;
    const readyBefore = readyAtMs(before);
    return readyBefore === null || ready > readyBefore;
}

/**
 * One panel read of the file, any age. Updates the detection cache. A failed read returns
 * null and is not cached, so the next check reads again.
 * @param {string} serverId Pterodactyl server id.
 * @returns {Promise<object|null>} The parsed state, or null.
 */
async function read(serverId) {
    let raw;
    try {
        raw = await pterodactyl.readFileOnce(serverId, STATE_PATH);
    } catch (error) {
        sessionLogger.warn('SupervisorState', `${serverId}: ${STATE_PATH} read failed (${error.message}); using the Wings state`);
        return null;
    }
    const state = raw ? parse(raw) : null;
    if (raw && !state && !logged.has(serverId)) {
        logged.add(serverId);
        sessionLogger.warn('SupervisorState', `${serverId}: ${STATE_PATH} is not a schema 1 state file; using the Wings state`);
    }
    cache.set(serverId, { at: Date.now(), supervised: isWarmMode(state) });
    return state;
}

/**
 * The fresh supervisor state of a server in a standby mode, or null. A server cached as
 * "no supervisor" within DETECT_TTL_MS costs no read. Call it only while Wings says running:
 * the stale check assumes the supervisor is up.
 * @param {string} serverId Pterodactyl server id.
 * @returns {Promise<object|null>}
 */
async function current(serverId) {
    const hit = cache.get(serverId);
    if (hit && !hit.supervised && Date.now() - hit.at < DETECT_TTL_MS) return null;
    const state = await read(serverId);
    if (!isWarmMode(state)) return null;
    if (!isFresh(state)) {
        if (!logged.has(serverId)) {
            logged.add(serverId);
            sessionLogger.warn('SupervisorState',
                `${serverId}: ${STATE_PATH} last written ${Math.round((Date.now() - state.updatedAtMs) / 1000)}s ago; using the Wings state`);
        }
        return null;
    }
    logged.delete(serverId);
    return state;
}

/** Drops the cached detection of one server, or of all servers. */
function forget(serverId) {
    if (serverId) {
        cache.delete(serverId);
        logged.delete(serverId);
    } else {
        cache.clear();
        logged.clear();
    }
}

module.exports = {
    STATE_PATH,
    WARM_MODES,
    STALE_MS,
    DETECT_TTL_MS,
    parse,
    isFresh,
    isWarmMode,
    view,
    readyAtMs,
    canWarmReboot,
    coldBootSeconds,
    rebootDone,
    read,
    current,
    forget,
};
