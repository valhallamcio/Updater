/*
 * File: halloweenTreat.js
 * Project: valhalla-updater
 * -----
 * Halloween 2026 item E13, the Discord side of "Treat from Discord". `/treat` writes one
 * row into bifrost.halloween_discord_treats. The proxy reads the row
 * (Bifrost src/plugins/halloween/items/e13.ts). When the target is online, it moves one
 * cake from the giver's bank to them, and it marks the row done or failed.
 *
 * Every check that decides lives here: the window, the link, the name, the self check
 * and the rate limit. The db and the clock come in from the caller, so a test needs no
 * Discord and no Mongo. The proxy checks friends and the cake bank itself.
 */

const COLLECTION = 'halloween_discord_treats';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const GAP_MS = 10 * MINUTE_MS;
const DAILY_MAX = 5;
// The proxy's holdMs. A row waits this long for its target to come online.
const HOLD_HOURS = 12;
const WATCH_MS = 60 * 1000;
const WATCH_EVERY_MS = 5 * 1000;
// Longer than any Minecraft name. A longer entry is unknown without a query.
const NAME_MAX = 32;
const NAME_MATCHES = 5;
const ECHO_MAX = 20;
// Oct 24 to Nov 2 2026, UTC dates. The end is the first moment of Nov 3.
const WINDOW = { opensAt: Date.UTC(2026, 9, 24), closesAt: Date.UTC(2026, 10, 3) };
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const ERROR_TEXT = () => 'something went wrong on our side';
const REASONS = {
    not_friends: name => `you are not friends with ${bold(name)} in game`,
    no_cake: () => 'you have no cake in your bank',
    expired: name => `${bold(name)} did not come online within ${HOLD_HOURS} hours`,
    closed: () => 'the event is over',
    not_linked: () => 'your Discord is no longer linked to a Minecraft account',
    self: () => 'you cannot treat yourself',
    gift_refused: () => 'the cake bank refused the gift',
    error: ERROR_TEXT,
    bad_row: ERROR_TEXT
};

const epochMs = v => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : NaN);

/**
 * The event window. config.json may move it under `halloween.treat`. A missing or bad
 * value keeps the default.
 * @param {object} [cfg] `{opensAt, closesAt}` as ISO strings or epoch ms.
 * @returns {{opensAt: number, closesAt: number}} Epoch ms. `closesAt` is exclusive.
 */
function readWindow(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const pick = (value, fallback) => {
        const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(ms) ? ms : fallback;
    };
    const opensAt = pick(c.opensAt, WINDOW.opensAt);
    const closesAt = pick(c.closesAt, WINDOW.closesAt);
    return opensAt < closesAt ? { opensAt, closesAt } : { ...WINDOW };
}

/**
 * The refusal outside the window.
 * @param {number} now Epoch ms.
 * @param {{opensAt: number, closesAt: number}} win From readWindow.
 * @returns {string|null} Null inside the window.
 */
function windowRefusal(now, win) {
    if (now < win.opensAt) {
        const day = new Date(win.opensAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        return `Treats open on ${day}.`;
    }
    return now >= win.closesAt ? 'The event is over.' : null;
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The players filter for one typed name: the whole name, any case. The proxy resolves
 * names with the same filter.
 * @param {string} name What the clicker typed.
 * @returns {object} A Mongo filter.
 */
function nameFilter(name) {
    return { username: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } };
}

/**
 * A uuid in the form the proxy matches on: lower case with dashes.
 * @param {*} raw A uuid with or without dashes.
 * @returns {string|null} Null when it is not a uuid.
 */
function normalizeUuid(raw) {
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) return null;
    const hex = raw.replace(/-/g, '').toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bold(name) {
    return `**${String(name).replace(/[\\*_~`|>]/g, '\\$&')}**`;
}

/**
 * What the clicker typed, safe inside a code span.
 * @param {string} raw Their entry.
 * @returns {string} Backticks gone, cut short.
 */
function echo(raw) {
    const text = String(raw == null ? '' : raw).replace(/`/g, '').replace(/\s+/g, ' ').trim();
    return text.length > ECHO_MAX ? `${text.slice(0, ECHO_MAX)}...` : text;
}

function startOfUtcDay(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * When the clicker may send the next treat. Every row counts, whatever its state.
 * @param {Array<Date|number>} times `at` of their rows since the start of the UTC day,
 *     or since 10 minutes ago when that is earlier.
 * @param {number} now Epoch ms.
 * @returns {{why: 'gap'|'daily', next: number}|null} Null when a treat is possible now.
 */
function nextTreatAt(times, now) {
    const ms = times.map(epochMs).filter(Number.isFinite);
    const dayStart = startOfUtcDay(now);
    if (ms.filter(t => t >= dayStart).length >= DAILY_MAX) return { why: 'daily', next: dayStart + DAY_MS };
    const last = ms.reduce((a, b) => Math.max(a, b), -Infinity);
    return now - last < GAP_MS ? { why: 'gap', next: last + GAP_MS } : null;
}

function rateLimitText(limit) {
    const when = `<t:${Math.ceil(limit.next / 1000)}:R>`;
    return limit.why === 'daily'
        ? `You sent ${DAILY_MAX} treats today. Your next one is possible ${when}, at 00:00 UTC.`
        : `You can send one treat every 10 minutes. Your next one is possible ${when}.`;
}

/**
 * The row the proxy reads. Its checks: a snowflake string, a lower-case dashed uuid, a
 * Date, and state pending.
 * @param {string} discordId The giver's Discord id.
 * @param {string} uuid The target's uuid.
 * @param {string} name The target's username as stored.
 * @param {number} now Epoch ms.
 * @returns {object} The row.
 */
function buildRow(discordId, uuid, name, now) {
    return {
        discordId: String(discordId),
        targetUuid: normalizeUuid(uuid),
        targetName: String(name),
        at: new Date(now),
        state: 'pending'
    };
}

/**
 * The reply edit for a row the proxy finished.
 * @param {object|null} row `{state, reason}`.
 * @param {string} name The target's name.
 * @returns {string|null} Null while the row is still pending or delivering.
 */
function outcomeText(row, name) {
    if (!row) return null;
    if (row.state === 'done') return `Your treat landed. ${bold(name)} got one cake from your bank.`;
    if (row.state !== 'failed') return null;
    const why = Object.prototype.hasOwnProperty.call(REASONS, row.reason) ? REASONS[row.reason] : ERROR_TEXT;
    return `Your treat did not arrive: ${why(name)}.`;
}

/**
 * The /treat flow over an injected db and clock.
 * @param {object} deps
 * @param {function(): Promise<object>} deps.db The `bifrost` Db, or a fake with the same calls.
 * @param {function(): string} deps.linkChannelId The #link channel id.
 * @param {object} [deps.window] The config override for readWindow.
 * @param {function(): number} [deps.now] Epoch ms.
 * @param {function(number): Promise<void>} [deps.sleep]
 * @param {function(string): void} [deps.log] Warnings.
 * @returns {{send: Function, watch: Function}}
 */
function createTreat(deps) {
    const now = deps.now || Date.now;
    const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const log = deps.log || (() => {});
    const win = readWindow(deps.window);
    // Discord ids with a send in progress. The rate limit reads the rows first and
    // inserts after, so two sends at once would both pass it.
    const busy = new Set();

    async function findTarget(players, name) {
        const docs = await players
            .find(nameFilter(name), { projection: { _id: 0, uuid: 1, username: 1, discord_id: 1 } })
            .limit(NAME_MATCHES)
            .toArray();
        const found = docs
            .map(d => ({
                uuid: normalizeUuid(d.uuid),
                username: typeof d.username === 'string' ? d.username : null,
                discordId: d.discord_id == null ? null : String(d.discord_id)
            }))
            .filter(d => d.uuid && d.username);
        return found.find(d => d.username === name) || found[0] || null;
    }

    async function decide(discordId, rawName) {
        const db = await deps.db();
        const players = db.collection('players');
        const mine = await players
            .find({ discord_id: discordId }, { projection: { _id: 0, uuid: 1 } })
            .toArray();
        if (mine.length === 0) {
            return {
                reason: 'not_linked',
                text: `Link your Discord to your Minecraft account first. Open <#${deps.linkChannelId()}> ` +
                    'and press **Link account**. You need the code from `/link` in game.'
            };
        }

        const name = String(rawName == null ? '' : rawName).trim();
        const target = name && name.length <= NAME_MAX ? await findTarget(players, name) : null;
        if (!target) return { reason: 'unknown', text: `No player named \`${echo(name)}\` has played on ValhallaMC.` };
        const own = new Set(mine.map(p => normalizeUuid(p.uuid)).filter(Boolean));
        if (own.has(target.uuid) || target.discordId === discordId) {
            return { reason: 'self', text: `You cannot treat yourself. ${bold(target.username)} is linked to your Discord.` };
        }

        const treats = db.collection(COLLECTION);
        const t = now();
        const since = new Date(Math.min(startOfUtcDay(t), t - GAP_MS));
        const recent = await treats
            .find({ discordId: discordId, at: { $gte: since } }, { projection: { _id: 0, at: 1 } })
            .toArray();
        const limit = nextTreatAt(recent.map(r => r.at), t);
        if (limit) return { reason: 'rate', text: rateLimitText(limit), next: limit.next };

        const row = buildRow(discordId, target.uuid, target.username, t);
        const result = await treats.insertOne(row);
        return {
            reason: 'sent',
            id: result.insertedId,
            targetName: row.targetName,
            text: `Your treat is on its way. It lands when ${bold(row.targetName)} is online in the next ${HOLD_HOURS} hours.`
        };
    }

    /**
     * One /treat. Writes at most one row.
     * @param {string} discordId The clicker's Discord id.
     * @param {string} rawName The name they typed.
     * @returns {Promise<object>} `{reason, text}`; reason 'sent' adds `id` and `targetName`.
     */
    async function send(discordId, rawName) {
        const id = String(discordId);
        const closed = windowRefusal(now(), win);
        if (closed) return { reason: 'window', text: closed };
        if (busy.has(id)) return { reason: 'busy', text: 'Your last treat is still being sent. Try again in a moment.' };
        busy.add(id);
        try {
            return await decide(id, rawName);
        } finally {
            busy.delete(id);
        }
    }

    /**
     * Reads the row again for a minute and stops when the proxy finished it.
     * @param {*} rowId The inserted _id.
     * @param {string} name The target's name.
     * @returns {Promise<string|null>} The outcome text, or null while it is still pending.
     */
    async function watch(rowId, name) {
        const db = await deps.db();
        const treats = db.collection(COLLECTION);
        const deadline = now() + WATCH_MS;
        while (now() < deadline) {
            await sleep(WATCH_EVERY_MS);
            let row;
            try {
                row = await treats.findOne({ _id: rowId }, { projection: { _id: 0, state: 1, reason: 1 } });
            } catch (error) {
                log(`Could not read treat ${rowId}: ${error.message}`);
                continue;
            }
            const text = outcomeText(row, name);
            if (text) return text;
        }
        return null;
    }

    return { send, watch };
}

module.exports = {
    COLLECTION,
    GAP_MS,
    DAILY_MAX,
    WATCH_MS,
    WATCH_EVERY_MS,
    WINDOW,
    readWindow,
    windowRefusal,
    nameFilter,
    normalizeUuid,
    nextTreatAt,
    buildRow,
    outcomeText,
    createTreat
};
