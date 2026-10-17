/*
 * File: hauntedWrapped.js
 * Project: valhalla-updater
 * -----
 * Haunted Wrapped: one player's Herobrine log from Halloween 2026. It reads the
 * bifrost.herobrine_players doc the way the proxy's herobrine plugin does
 * (src/plugins/herobrine/rules.ts, normalizeDoc). Pure: no Discord calls and no Mongo.
 * The yearly recap lives in wrappedGenerator.js.
 */

const { EmbedBuilder, escapeMarkdown } = require('discord.js');

const HOUR_MS = 3600 * 1000;
// Nov 1 to Nov 8 2026, UTC dates. The end is the first moment of Nov 9.
const WINDOW_START = Date.UTC(2026, 10, 1);
const WINDOW_END = Date.UTC(2026, 10, 9);
// The proxy's default ladder. `rung` is an index into it.
const STEPS = ['glimpse', 'stalk', 'signs', 'base', 'chase'];
const STEP_LABELS = {
    glimpse: 'a glimpse',
    stalk: 'the stalk',
    signs: 'the signs',
    base: 'your base',
    chase: 'the chase'
};
// The proxy keeps this many history rows, newest last.
const HISTORY_KEPT = 30;
// The herobrine plugin's dayResetUtcHour. One reward day covers an evening and its night.
const DAY_RESET_UTC_HOUR = 12;
const OUTCOMES = new Set(['seen', 'unseen', 'no_spawn']);
const LOG_LINES = 5;
const COLOR = 0xE8710A;

/**
 * Where `now` sits against the Haunted Wrapped window.
 * @param {number} now Epoch ms.
 * @returns {'before'|'open'|'after'}
 */
function windowState(now) {
    if (now < WINDOW_START) return 'before';
    return now < WINDOW_END ? 'open' : 'after';
}

/**
 * The reward day of a moment, as herobrine's `rewardDayKey`: the UTC date of now minus
 * `resetHour` hours.
 * @param {number} now Epoch ms.
 * @param {number} [resetHour]
 * @returns {string} `YYYY-MM-DD`.
 */
function rewardDayKey(now, resetHour = DAY_RESET_UTC_HOUR) {
    return new Date(now - resetHour * HOUR_MS).toISOString().slice(0, 10);
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
const epochMs = v => (v instanceof Date ? v.getTime() : finite(v) ? v : 0);
const count = v => (finite(v) && v > 0 ? Math.floor(v) : 0);
const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads a stored herobrine_players doc. A missing or bad field takes the proxy's default.
 * Dates and epoch numbers both work for `lastAt` and `history.at`.
 * @param {object|null} raw The doc from Mongo.
 * @returns {object|null} `{name, rung, encounters, seen, catches, lastAt, history}`, or null for no doc.
 */
function normalizeLadder(raw) {
    if (!isObject(raw)) return null;
    const history = [];
    if (Array.isArray(raw.history)) {
        for (const h of raw.history.slice(-HISTORY_KEPT)) {
            if (!isObject(h)) continue;
            history.push({
                at: epochMs(h.at),
                serverId: typeof h.serverId === 'string' ? h.serverId : '',
                step: typeof h.step === 'string' ? h.step : '',
                outcome: typeof h.outcome === 'string' && OUTCOMES.has(h.outcome) ? h.outcome : 'unseen',
                reason: typeof h.reason === 'string' ? h.reason : ''
            });
        }
    }
    return {
        name: typeof raw.name === 'string' ? raw.name : '',
        rung: count(raw.rung),
        encounters: count(raw.encounters),
        seen: count(raw.seen),
        catches: count(raw.catches),
        lastAt: epochMs(raw.lastAt),
        history
    };
}

/**
 * The distinct reward days in the history. A row with no time does not count.
 * @param {object[]} history Normalized history rows.
 * @returns {number}
 */
function countNights(history) {
    const days = new Set();
    for (const h of history) if (h.at > 0) days.add(rewardDayKey(h.at));
    return days.size;
}

/**
 * The highest step the player reached: the rung, or a higher step in the history.
 * @param {object} doc Normalized doc.
 * @returns {number} Index into STEPS.
 */
function stepReached(doc) {
    let reached = Math.min(doc.rung, STEPS.length - 1);
    for (const h of doc.history) {
        if (h.outcome === 'no_spawn') continue;
        reached = Math.max(reached, STEPS.indexOf(h.step));
    }
    return reached;
}

/**
 * True when he spawned for the player at least once.
 * @param {object|null} doc Normalized doc.
 * @returns {boolean}
 */
function hasSightings(doc) {
    if (!doc) return false;
    return doc.encounters > 0 || doc.seen > 0 || doc.history.some(h => h.outcome !== 'no_spawn');
}

/**
 * Server id to the pack name players know. The proxy's server id is the Pterodactyl id.
 * An early-access or hidden instance shows the public name of its tag.
 * @param {Array} servers Server docs from Yggdrasil.
 * @returns {Map<string, string>}
 */
function serverNameMap(servers) {
    const names = new Map();
    for (const s of servers || []) {
        let name = s.name;
        if (s.earlyAccess || s.excludeFromServerList) {
            const face = servers.find(o => o.tag === s.tag && !o.earlyAccess && !o.excludeFromServerList);
            name = face ? face.name : null;
        }
        if (!name) continue;
        for (const id of [s.serverId, s.id]) if (id) names.set(String(id), name);
    }
    return names;
}

const stepLabel = step => STEP_LABELS[step] || step || 'unknown';

/**
 * The newest sightings, newest first. A row where he did not spawn is left out.
 * @param {object[]} history Normalized history rows.
 * @param {Map<string, string>} serverNames From serverNameMap.
 * @returns {string[]}
 */
function logLines(history, serverNames) {
    return history
        .filter(h => h.outcome !== 'no_spawn')
        .slice(-LOG_LINES)
        .reverse()
        .map(h => {
            const when = h.at > 0 ? `<t:${Math.floor(h.at / 1000)}:d> ` : '';
            const what = h.outcome === 'seen' ? 'you saw him' : 'he stayed hidden';
            const server = serverNames.get(h.serverId);
            return `${when}${stepLabel(h.step)}, ${what}${server ? ` on ${escapeMarkdown(server)}` : ''}`;
        });
}

/**
 * The Haunted Wrapped embed for one player.
 * @param {object} doc Normalized doc.
 * @param {object} [opts]
 * @param {string} [opts.username] The Minecraft name to show.
 * @param {Map<string, string>} [opts.serverNames] From serverNameMap.
 * @returns {EmbedBuilder}
 */
function buildHauntedEmbed(doc, opts = {}) {
    const username = opts.username || doc.name || 'you';
    const serverNames = opts.serverNames || new Map();
    const reached = stepReached(doc);
    const line = doc.seen > 0 ? 'i saw you too.' : 'you never saw me. i saw you.';

    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`Haunted Wrapped: ${escapeMarkdown(username)}`)
        .setDescription(`*${line}*`)
        .addFields(
            { name: 'Nights', value: String(countNights(doc.history)), inline: true },
            { name: 'Encounters', value: String(doc.encounters), inline: true },
            { name: 'You saw him', value: String(doc.seen), inline: true },
            { name: 'He caught you', value: String(doc.catches), inline: true },
            { name: 'Steps reached', value: `${reached + 1} of ${STEPS.length}: ${stepLabel(STEPS[reached])}`, inline: true }
        )
        .setFooter({ text: 'ValhallaMC Halloween 2026' });

    const lines = logLines(doc.history, serverNames);
    if (lines.length > 0) embed.addFields({ name: 'Last sightings', value: lines.join('\n') });
    if (/^\w{1,16}$/.test(username)) embed.setThumbnail(`https://mc-heads.net/avatar/${username}/128`);
    return embed;
}

module.exports = {
    WINDOW_START,
    WINDOW_END,
    STEPS,
    HISTORY_KEPT,
    windowState,
    rewardDayKey,
    normalizeLadder,
    countNights,
    stepReached,
    hasSightings,
    serverNameMap,
    buildHauntedEmbed
};
