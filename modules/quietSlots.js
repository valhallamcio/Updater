/*
 * quietSlots.js
 *
 * The quietest moment of the day per server, for the daily reboot. Source: Prometheus player
 * history (biforesting_players, label server_id = the panel serverId). Each server gets the
 * 15 min slot inside the allowed daily window with the lowest median player count over the last
 * 14 days. The slot is the time of the stop; the countdown runs in the minutes before it.
 *
 * Rules:
 * - Lowest median wins, then the lowest mean, then the slot nearest the fixed batch time.
 * - Too little history (minDays days with a sample in the window): the server keeps the fixed
 *   daily batch (rebootScheduler.triggerRebootSequence).
 * - Instances of one tag never share a slot: they get slots at least siblingGapMinutes apart. If
 *   one instance has no slot, the whole tag keeps the fixed batch, where today's sync group
 *   stagger applies.
 * - Times are in the scheduler's time zone (GMT+3, timeManager), as minutes after midnight.
 *
 * Read-only: one Prometheus range query per plan.
 */

const axios = require('axios');

const DEFAULTS = {
    enabled: false,
    prometheusUrl: 'http://127.0.0.1:9090',
    // Average players over the 15 min before each step, one series per server
    query: 'avg_over_time(biforesting_players[15m])',
    serverLabel: 'server_id',
    window: '09:00-11:00',      // the stop happens inside this window (GMT+3)
    fallbackTime: '09:00',      // when the fixed batch reboots today (timeManager.checkRebootWindow)
    utcOffsetMinutes: 180,
    lookbackDays: 14,
    slotMinutes: 15,
    minDays: 7,
    siblingGapMinutes: 45,      // warning 15 min + boot + the 15 min sync group stagger
};

/** "09:30" -> 570, or null. */
function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) return null;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
}

/** 570 -> "09:30". */
function formatTime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The config with defaults, and the window as minutes. A window that does not parse, or that
 * crosses midnight, gives the default window.
 */
function config(raw = {}) {
    const cfg = { ...DEFAULTS, ...(raw || {}) };
    let [start, end] = String(cfg.window).split('-').map(parseTime);
    if (start === null || end === null || start === undefined || end === undefined || end <= start) {
        [start, end] = DEFAULTS.window.split('-').map(parseTime);
    }
    cfg.windowStart = start;
    cfg.windowEnd = end;
    const fallback = parseTime(cfg.fallbackTime);
    cfg.fallbackMinutes = fallback === null ? start : fallback;
    return cfg;
}

/**
 * The player history as a Prometheus range query, steps aligned to the slot length.
 * @param {object} cfg config() output.
 * @param {object} [deps] { get (axios.get), now (ms) } for tests.
 * @returns {Promise<Array<{metric: object, values: Array}>>} The matrix result.
 */
async function fetchHistory(cfg, deps = {}) {
    const get = deps.get || axios.get;
    const nowSec = Math.floor((deps.now || Date.now()) / 1000);
    const step = cfg.slotMinutes * 60;
    const end = nowSec - (nowSec % step);
    const start = end - cfg.lookbackDays * 86400;
    const url = `${String(cfg.prometheusUrl).replace(/\/$/, '')}/api/v1/query_range`;
    // the read-only proxy on new-lithium (valhalla-monitoring prom-ro) wants this bearer; plain Prometheus ignores it
    const token = process.env.PROMETHEUS_RO_TOKEN;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await get(url, { params: { query: cfg.query, start, end, step }, headers, timeout: 30000 });
    const body = response && response.data;
    if (!body || body.status !== 'success' || !body.data || body.data.resultType !== 'matrix') {
        throw new Error(`Prometheus answered ${body && body.status ? body.status : 'nothing usable'}`);
    }
    return body.data.result;
}

/**
 * serverId -> Map(step seconds -> players). A server whose panel id was reused for another pack
 * has an old series that ended long ago: only series that ended within an hour of the server's
 * newest sample count, merged by max.
 */
function currentSeries(result, label = DEFAULTS.serverLabel) {
    const byServer = new Map();
    for (const series of result || []) {
        const id = series.metric && series.metric[label];
        if (!id || !Array.isArray(series.values) || !series.values.length) continue;
        const last = Number(series.values[series.values.length - 1][0]);
        if (!byServer.has(id)) byServer.set(id, []);
        byServer.get(id).push({ last, values: series.values });
    }
    const out = new Map();
    for (const [id, list] of byServer) {
        const newest = Math.max(...list.map(s => s.last));
        const points = new Map();
        for (const s of list.filter(s => newest - s.last <= 3600)) {
            for (const [t, v] of s.values) {
                const value = Number(v);
                if (!Number.isFinite(value)) continue;
                const ts = Number(t);
                points.set(ts, Math.max(points.has(ts) ? points.get(ts) : -Infinity, value));
            }
        }
        out.set(id, points);
    }
    return out;
}

function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Per slot of the day: median and mean players and the number of days with a sample. The value
 * at step t covers the slot that ends at t.
 * @returns {Map<number, {median: number, mean: number, days: number}>} Keyed by the slot start in minutes.
 */
function profile(points, cfg) {
    const slots = new Map();
    for (const [ts, value] of points) {
        const localMin = Math.floor((ts * 1000 + cfg.utcOffsetMinutes * 60000) / 60000) - cfg.slotMinutes;
        const minuteOfDay = ((localMin % 1440) + 1440) % 1440;
        const slot = minuteOfDay - (minuteOfDay % cfg.slotMinutes);
        if (!slots.has(slot)) slots.set(slot, []);
        slots.get(slot).push(value);
    }
    const out = new Map();
    for (const [slot, values] of slots) {
        out.set(slot, { median: median(values), mean: values.reduce((a, b) => a + b, 0) / values.length, days: values.length });
    }
    return out;
}

/** Slot starts inside the window, in minutes. */
function windowSlots(cfg) {
    const out = [];
    for (let m = cfg.windowStart; m < cfg.windowEnd; m += cfg.slotMinutes) out.push(m);
    return out;
}

/**
 * The plan for a set of servers.
 * @param {Array} servers Yggdrasil server docs (serverId, tag, name).
 * @param {Array|null} history fetchHistory output, or null when Prometheus failed.
 * @param {object} cfg config() output.
 * @returns {{entries: Array, error: (string|null)}} One entry per server: { serverId, tag, name,
 *   slot (minutes or null), median, mean, days, fallbackMedian, reason }.
 */
function plan(servers, history, cfg, error = null) {
    const series = history ? currentSeries(history, cfg.serverLabel) : new Map();
    const candidates = windowSlots(cfg);
    const entries = servers.map(server => {
        const entry = { serverId: server.serverId, tag: server.tag || null, name: server.name || server.tag || server.serverId, slot: null, ranked: [], reason: '' };
        const points = series.get(server.serverId);
        if (!history) { entry.reason = `no history (${error || 'Prometheus failed'})`; return entry; }
        if (!points || !points.size) { entry.reason = 'no player series for this serverId'; return entry; }
        const prof = profile(points, cfg);
        const fb = prof.get(cfg.fallbackMinutes);
        entry.fallbackMedian = fb ? fb.median : null;
        // Ties go to the slot nearest the fixed batch time, so a server that is as empty at
        // 09:00 as at any other time keeps today's time.
        const away = (slot) => Math.abs(slot - cfg.fallbackMinutes);
        const ranked = candidates
            .map(slot => ({ slot, ...(prof.get(slot) || { median: null, mean: null, days: 0 }) }))
            .filter(c => c.days >= cfg.minDays)
            .sort((a, b) => a.median - b.median || a.mean - b.mean || away(a.slot) - away(b.slot) || a.slot - b.slot);
        if (!ranked.length) {
            const most = Math.max(0, ...candidates.map(slot => (prof.get(slot) || { days: 0 }).days));
            entry.reason = `${most} days of history in the window, ${cfg.minDays} needed`;
            return entry;
        }
        entry.ranked = ranked;
        return entry;
    });

    // Siblings of one tag: the slots at least siblingGapMinutes apart with the lowest sum of medians.
    const byTag = new Map();
    entries.forEach(e => {
        const key = e.tag || e.serverId;
        if (!byTag.has(key)) byTag.set(key, []);
        byTag.get(key).push(e);
    });
    for (const [tag, group] of byTag) {
        if (group.some(e => !e.ranked.length)) {
            for (const e of group) {
                if (e.ranked.length) e.reason = `tag ${tag}: another instance has no slot, so the whole tag keeps the fixed batch`;
                e.ranked = [];
            }
            continue;
        }
        const picks = assignSiblings(group, cfg.siblingGapMinutes);
        if (!picks) {
            for (const e of group) {
                e.reason = `tag ${tag}: no slots ${cfg.siblingGapMinutes} min apart for all ${group.length} instances in the window`;
            }
            continue;
        }
        for (const [e, pick] of picks) {
            Object.assign(e, { slot: pick.slot, median: pick.median, mean: pick.mean, days: pick.days });
            const best = e.ranked[0];
            e.reason = pick.slot === best.slot
                ? `lowest median in the window`
                : `best slot ${formatTime(best.slot)} (median ${round(best.median)}) is too close to a sibling`;
        }
    }
    entries.forEach(e => delete e.ranked);
    return { entries, error };
}

/**
 * One slot per instance, at least gap minutes apart, with the lowest sum of medians. Depth-first
 * over each instance's ranked slots, cut where the sum can no longer beat the best found; on a
 * tie the first found (each instance's better-ranked slots) stays.
 * @returns {Array<[object, object]>|null} [entry, chosen candidate] pairs, or null when no
 *   assignment fits.
 */
function assignSiblings(group, gap) {
    const order = [...group].sort((a, b) => a.ranked[0].median - b.ranked[0].median || String(a.serverId).localeCompare(String(b.serverId)));
    const rest = order.map((_, i) => order.slice(i).reduce((sum, e) => sum + e.ranked[0].median, 0));
    rest.push(0);
    const chosen = [];
    let best = null;
    let bestSum = Infinity;
    const search = (i, sum) => {
        if (i === order.length) {
            bestSum = sum;
            best = [...chosen];
            return;
        }
        for (const c of order[i].ranked) {
            if (sum + c.median + rest[i + 1] >= bestSum) break;
            if (chosen.some(p => Math.abs(p.slot - c.slot) < gap)) continue;
            chosen.push(c);
            search(i + 1, sum + c.median);
            chosen.pop();
        }
    };
    search(0, 0);
    return best ? order.map((e, i) => [e, best[i]]) : null;
}

function round(n) {
    return n === null || n === undefined ? '?' : Math.round(n * 10) / 10;
}

/** One line per server: the slot and why, or the fallback and why. */
function format(result, cfg) {
    const head = `Quiet slots: window ${formatTime(cfg.windowStart)}-${formatTime(cfg.windowEnd)} GMT+3, ${cfg.slotMinutes} min slots, ` +
        `median of ${cfg.lookbackDays} days, ${cfg.minDays} days minimum, siblings ${cfg.siblingGapMinutes} min apart; fixed batch at ${formatTime(cfg.fallbackMinutes)}` +
        (result.error ? `\nPrometheus: ${result.error}` : '');
    const rows = [...result.entries].sort((a, b) =>
        (a.slot === null) - (b.slot === null) || (a.slot || 0) - (b.slot || 0) || String(a.tag).localeCompare(String(b.tag)));
    const lines = rows.map(e => {
        const who = `${e.name} [${e.tag || '-'} ${e.serverId}]`;
        if (e.slot === null) return `${who}: fixed batch ${formatTime(cfg.fallbackMinutes)} (${e.reason})`;
        const fb = e.fallbackMedian === null || e.fallbackMedian === undefined ? '' : `; ${formatTime(cfg.fallbackMinutes)} median ${round(e.fallbackMedian)}`;
        return `${who}: stop ${formatTime(e.slot)}, median ${round(e.median)} (mean ${round(e.mean)}, ${e.days} days)${fb}; ${e.reason}`;
    });
    return [head, ...lines].join('\n');
}

/**
 * The epoch ms of a slot on the scheduler's day.
 * @param {string} day "YYYY-MM-DD" in the scheduler's time zone (timeManager.getTodayDateString).
 */
function slotTimeMs(day, minutes, cfg) {
    return Date.parse(`${day}T00:00:00Z`) - cfg.utcOffsetMinutes * 60000 + minutes * 60000;
}

module.exports = {
    DEFAULTS,
    config,
    parseTime,
    formatTime,
    fetchHistory,
    currentSeries,
    profile,
    plan,
    format,
    slotTimeMs,
};
