/*
 * File: questProgress.js
 * Project: valhalla-updater
 * -----
 * Pure logic for the quest events (schedulers/questEventReader.js). It reads a
 * BetterQuesting 1.12.2 `QuestProgress.json` and counts completions for one event.
 * Nothing here touches Mongo, the panel or the clock: the caller passes `now`.
 *
 * The BQ file is NBT written as JSON, so every key carries its tag type:
 *   { "questProgress:9": { "0:10": { "questID:3": 809,
 *       "completed:9": { "0:10": { "uuid:8": "<dashed uuid>", "timestamp:4": <ms> } } } } }
 * A list can also come as a JSON array. Both forms are read.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_WEEK_COUNT = 8;
// Reward keys the reader sets itself. A milestone key must not take one of them.
const RESERVED_KEYS = new Set(['founder', 'finisher', 'speedrunner', 'veteran']);
const WEEK_KEY = /^week\d+$/;
// A milestone key goes into Mongo paths (`rewards.<key>`), so no dots and no `$`.
const MILESTONE_KEY = /^[A-Za-z]\w*$/;

/** The values of an NBT-JSON list or compound, in either of its two forms. */
function entries(node) {
    if (Array.isArray(node)) return node;
    if (node && typeof node === 'object') return Object.values(node);
    return [];
}

/** A uuid as BQ and Mongo keep it: lowercase, dashed, trimmed. */
function normalizeUuid(uuid) {
    return String(uuid || '').trim().toLowerCase();
}

/** Epoch ms from a Date, a number or an ISO string. Null when there is none. */
function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Reads the quests and their completions out of a QuestProgress.json.
 * A uuid that shows up twice in one quest counts once, at its earliest timestamp.
 * @param {string|object} data The file text, or the parsed JSON.
 * @returns {{quests: {questId: number, completions: {uuid: string, at: number}[]}[], skipped: number}}
 *     `skipped` counts quest entries with no numeric `questID:3`.
 */
function parseQuestProgress(data) {
    const root = typeof data === 'string' ? JSON.parse(data) : data;
    if (!root || typeof root !== 'object' || !('questProgress:9' in root)) {
        throw new Error('No questProgress:9 key. This is not a BetterQuesting 1.12.2 QuestProgress.json');
    }
    const quests = [];
    let skipped = 0;
    for (const quest of entries(root['questProgress:9'])) {
        const questId = Number(quest && quest['questID:3']);
        if (!Number.isInteger(questId)) {
            skipped++;
            continue;
        }
        const byUuid = new Map();
        for (const done of entries(quest['completed:9'])) {
            const uuid = normalizeUuid(done && done['uuid:8']);
            const at = Number(done && done['timestamp:4']);
            if (!uuid || !Number.isFinite(at)) continue;
            const seen = byUuid.get(uuid);
            if (seen === undefined || at < seen) byUuid.set(uuid, at);
        }
        quests.push({ questId, completions: [...byUuid].map(([uuid, at]) => ({ uuid, at })) });
    }
    return { quests, skipped };
}

/**
 * The event's time frame in ms. A set `endAt` decides the number of weeks.
 * Without one, `weekCount` (8 when unset) decides `endAt`.
 * @returns {{startAt: number, endAt: number, weekMs: number, weekCount: number}|null} Null before a start is set.
 */
function schedule(event) {
    const startAt = toMs(event.startAt);
    if (startAt === null) return null;
    const weekMs = Number(event.weekMs) > 0 ? Number(event.weekMs) : WEEK_MS;
    let endAt = toMs(event.endAt);
    let weekCount;
    if (endAt !== null && endAt > startAt) {
        weekCount = Math.ceil((endAt - startAt) / weekMs);
    } else {
        weekCount = Number.isInteger(event.weekCount) && event.weekCount > 0 ? event.weekCount : DEFAULT_WEEK_COUNT;
        endAt = startAt + weekCount * weekMs;
    }
    return { startAt, endAt, weekMs, weekCount };
}

/** The target for week `index`. Past the end of the list, the last value repeats. Null with no targets. */
function weekTarget(targets, index) {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    return Number(targets[Math.min(index, targets.length - 1)]);
}

/** The week `now` falls in, held inside the event's weeks. */
function weekIndexAt(sched, now) {
    const index = Math.floor((now - sched.startAt) / sched.weekMs);
    return Math.min(Math.max(index, 0), sched.weekCount - 1);
}

/** When week `index` ends. The last week ends at `endAt`, also when that cuts it short. */
function weekEnd(sched, index) {
    return Math.min(sched.startAt + (index + 1) * sched.weekMs, sched.endAt);
}

/** True for the weekly reward keys, `week0` and up. */
function isWeekKey(key) {
    return WEEK_KEY.test(String(key));
}

/**
 * The event's usable `milestones`: a key like `m50` that is free, and a positive
 * integer `quests`. A bad entry or a second use of one key is left out.
 * @returns {{key: string, quests: number, reward: object}[]} In the order of the event doc.
 */
function milestoneSpecs(event) {
    if (!Array.isArray(event.milestones)) return [];
    const specs = [];
    const seen = new Set();
    for (const milestone of event.milestones) {
        const key = milestone && milestone.key;
        const quests = Number(milestone && milestone.quests);
        if (typeof key !== 'string' || !MILESTONE_KEY.test(key) || RESERVED_KEYS.has(key) || isWeekKey(key)) continue;
        if (seen.has(key) || !Number.isInteger(quests) || quests <= 0) continue;
        seen.add(key);
        specs.push({ key, quests, reward: milestone.reward });
    }
    return specs;
}

/** The final quest the Season 2 finisher needs, or null when the event has no `finisher`. */
function finisherQuestId(event) {
    if (!event.finisher || typeof event.finisher !== 'object') return null;
    const id = Number(event.finalQuestId);
    return event.finalQuestId !== null && event.finalQuestId !== '' && Number.isInteger(id) ? id : null;
}

/**
 * The event's usable `chapters`: an integer `index` of 0 or more that is free, and a
 * `quests` list. A bad entry or a second use of one index is left out.
 * @returns {{index: number, name: string, icon: {id: string, meta: number}|null, quests: number[]}[]} By index, lowest first.
 */
function chapterSpecs(event) {
    if (!Array.isArray(event.chapters)) return [];
    const specs = [];
    const seen = new Set();
    for (const chapter of event.chapters) {
        const index = chapter && chapter.index;
        if (!Number.isInteger(index) || index < 0 || seen.has(index) || !Array.isArray(chapter.quests)) continue;
        seen.add(index);
        const icon = chapter.icon && typeof chapter.icon.id === 'string' && chapter.icon.id
            ? { id: chapter.icon.id, meta: Number(chapter.icon.meta) || 0 }
            : null;
        specs.push({
            index,
            name: typeof chapter.name === 'string' ? chapter.name : '',
            icon,
            quests: chapter.quests.map(Number).filter(Number.isInteger)
        });
    }
    return specs.sort((a, b) => a.index - b.index);
}

/** Quest id to chapter index. A quest in several chapters belongs to the lowest index. */
function chapterByQuest(chapters) {
    const byQuest = new Map();
    for (const chapter of chapters) {
        for (const questId of chapter.quests) {
            if (!byQuest.has(questId)) byQuest.set(questId, chapter.index);
        }
    }
    return byQuest;
}

/**
 * The chapter with the most completions in week `index`. A tie goes to the lower index.
 * @param {object[]} weekChapters Per week, completions by chapter index, from `countEvent`.
 * @returns {{index: number, name: string, icon: object|null}|null} Null when nobody completed a chapter quest that week.
 */
function topChapter(event, weekChapters, index) {
    const counts = (Array.isArray(weekChapters) && weekChapters[index]) || {};
    const chapters = new Map(chapterSpecs(event).map(chapter => [chapter.index, chapter]));
    let best = null;
    let bestCount = 0;
    for (const [key, value] of Object.entries(counts)) {
        const chapter = chapters.get(Number(key));
        const count = Number(value) || 0;
        if (!chapter || count <= 0) continue;
        if (count > bestCount || (count === bestCount && chapter.index < best.index)) {
            best = chapter;
            bestCount = count;
        }
    }
    return best ? { index: best.index, name: best.name, icon: best.icon } : null;
}

/** True when finisher number `n` also earns the speedrunner reward: `n <= finisher.firstN`. */
function earnsSpeedrunner(event, n) {
    const firstN = Number((event.finisher || {}).firstN);
    return Number.isInteger(firstN) && firstN > 0 && Number.isInteger(n) && n > 0 && n <= firstN;
}

/**
 * Counts the completions that belong to the event: `startAt <= at < endAt`, uuid not
 * excluded. Each player's count is per uuid, as BQ recorded it. A quest in `ignoredQuests`
 * (a repeatable trade quest, for example) counts for nothing.
 * @returns {{players: Map<string, {uuid: string, total: number, weeks: object, firstAt: number, founderAt: number|null,
 *     milestoneAt?: object, finishedAt?: number|null}>, weekCounts: number[], weekChapters: object[], quests: number,
 *     schedule: object}}
 *     `founderAt` is the time of the player's `founder.minQuests`-th completion, or null before they reach it.
 *     `milestoneAt` maps each reached milestone key to the time of the completion that reached it.
 *     `finishedAt` is the time of the counted `finalQuestId` completion, or null.
 *     A row has `milestoneAt` only when the event has milestones, and `finishedAt` only with a `finisher`.
 *     `weekChapters` has one object per week: completions by chapter index, over the same
 *     completions as `weekCounts`. A quest in no chapter adds to no chapter.
 */
function countEvent(quests, event) {
    const sched = schedule(event);
    if (!sched) throw new Error(`Event ${event._id} has no startAt`);
    const excluded = new Set((event.excluded || []).map(normalizeUuid));
    const minQuests = event.founder && Number(event.founder.minQuests) > 0 ? Number(event.founder.minQuests) : null;
    const milestones = milestoneSpecs(event);
    const finalQuestId = finisherQuestId(event);
    const chapterOf = chapterByQuest(chapterSpecs(event));
    const ignored = new Set((Array.isArray(event.ignoredQuests) ? event.ignoredQuests : []).map(Number));

    const times = new Map();
    const finished = new Map();
    const weekChapters = Array.from({ length: sched.weekCount }, () => ({}));
    for (const quest of quests) {
        if (ignored.has(quest.questId)) continue;
        const final = finalQuestId !== null && quest.questId === finalQuestId;
        const chapter = chapterOf.get(quest.questId);
        for (const { uuid, at } of quest.completions) {
            if (at < sched.startAt || at >= sched.endAt || excluded.has(uuid)) continue;
            if (!times.has(uuid)) times.set(uuid, []);
            times.get(uuid).push(at);
            if (final && (!finished.has(uuid) || at < finished.get(uuid))) finished.set(uuid, at);
            if (chapter !== undefined) {
                const week = weekChapters[Math.floor((at - sched.startAt) / sched.weekMs)];
                week[chapter] = (week[chapter] || 0) + 1;
            }
        }
    }

    const players = new Map();
    const weekCounts = new Array(sched.weekCount).fill(0);
    let total = 0;
    for (const [uuid, list] of times) {
        list.sort((a, b) => a - b);
        const weeks = {};
        for (const at of list) {
            const index = Math.floor((at - sched.startAt) / sched.weekMs);
            weeks[index] = (weeks[index] || 0) + 1;
            weekCounts[index]++;
        }
        total += list.length;
        const row = {
            uuid,
            total: list.length,
            weeks,
            firstAt: list[0],
            founderAt: minQuests !== null && list.length >= minQuests ? list[minQuests - 1] : null
        };
        if (milestones.length) {
            row.milestoneAt = Object.fromEntries(milestones
                .filter(m => list.length >= m.quests)
                .map(m => [m.key, list[m.quests - 1]]));
        }
        if (finalQuestId !== null) row.finishedAt = finished.has(uuid) ? finished.get(uuid) : null;
        players.set(uuid, row);
    }
    return { players, weekCounts, weekChapters, quests: total, schedule: sched };
}

/**
 * Every uuid with a completion of `finalQuestId`, at its earliest time. No time window
 * and no exclusion: a finisher is a finisher.
 * @returns {{uuid: string, at: number}[]} Oldest first.
 */
function finishers(quests, finalQuestId) {
    const earliest = new Map();
    for (const quest of quests) {
        if (quest.questId !== Number(finalQuestId)) continue;
        for (const { uuid, at } of quest.completions) {
            const seen = earliest.get(uuid);
            if (seen === undefined || at < seen) earliest.set(uuid, at);
        }
    }
    return [...earliest].map(([uuid, at]) => ({ uuid, at })).sort((a, b) => a.at - b.at);
}

/**
 * The event's `totals` as the proxy shows them. The week part moves with `now`, so it
 * is built on every pass, also when the file did not change.
 * @param {{quests: number, players: number, weekCounts: number[]}} counts The last count.
 */
function buildTotals(counts, sched, weeklyTargets, now) {
    const index = weekIndexAt(sched, now);
    return {
        quests: counts.quests,
        players: counts.players,
        week: {
            index,
            count: (counts.weekCounts && counts.weekCounts[index]) || 0,
            target: weekTarget(weeklyTargets, index)
        }
    };
}

/**
 * The weeks that ended at least `delayMs` ago and are not closed yet. The delay gives
 * the server time to save the file after the boundary.
 * @param {{index: number}[]} closedWeeks The event's closed weeks.
 * @returns {number[]} Week indexes, oldest first.
 */
function closableWeeks(sched, closedWeeks, now, delayMs = 0) {
    const closed = new Set((closedWeeks || []).map(w => w.index));
    const open = [];
    for (let i = 0; i < sched.weekCount; i++) {
        if (!closed.has(i) && now >= weekEnd(sched, i) + delayMs) open.push(i);
    }
    return open;
}

/** True once the event ended and every week is closed. Nothing changes after that. */
function eventFinished(sched, closedWeeks, now) {
    return now >= sched.endAt && closableWeeks(sched, closedWeeks, Infinity).length === 0;
}

/**
 * The progress docs that earn a founder number: no number yet, and `minQuests` reached
 * inside `startAt + founder.windowMs`.
 * @returns {object[]} The docs, in the order they reached `minQuests`.
 */
function founderCandidates(progressDocs, event, sched) {
    const founder = event.founder || {};
    const windowMs = Number(founder.windowMs);
    if (!(windowMs > 0) || !(Number(founder.minQuests) > 0)) return [];
    const excluded = new Set((event.excluded || []).map(normalizeUuid));
    const windowEnd = sched.startAt + windowMs;
    return progressDocs
        .filter(doc => (doc.founderNo === null || doc.founderNo === undefined)
            && toMs(doc.founderAt) !== null && toMs(doc.founderAt) < windowEnd
            && Number(doc.total) >= Number(founder.minQuests)
            && !excluded.has(normalizeUuid(doc.uuid)))
        .sort((a, b) => toMs(a.founderAt) - toMs(b.founderAt) || String(a.uuid).localeCompare(String(b.uuid)));
}

/**
 * The progress docs that earn a number for one milestone: no number for that key yet,
 * and `quests` reached inside the event. No founder-style window.
 * @param {{key: string, quests: number}} milestone One entry of `milestoneSpecs`.
 * @returns {object[]} The docs, in the order they reached `quests`.
 */
function milestoneCandidates(progressDocs, event, sched, milestone) {
    const excluded = new Set((event.excluded || []).map(normalizeUuid));
    const reachedAt = doc => toMs((doc.milestoneAt || {})[milestone.key]);
    const numbered = doc => doc.milestoneNo && doc.milestoneNo[milestone.key] !== null && doc.milestoneNo[milestone.key] !== undefined;
    return progressDocs
        .filter(doc => !numbered(doc)
            && reachedAt(doc) !== null && reachedAt(doc) >= sched.startAt && reachedAt(doc) < sched.endAt
            && Number(doc.total) >= milestone.quests
            && !excluded.has(normalizeUuid(doc.uuid)))
        .sort((a, b) => reachedAt(a) - reachedAt(b) || String(a.uuid).localeCompare(String(b.uuid)));
}

/**
 * The progress docs that earn a finisher number: no number yet, and a `finishedAt`
 * inside the event. Empty when the event has no `finisher`.
 * @returns {object[]} The docs, in the order they completed `finalQuestId`.
 */
function finisherCandidates(progressDocs, event, sched) {
    if (finisherQuestId(event) === null) return [];
    const excluded = new Set((event.excluded || []).map(normalizeUuid));
    return progressDocs
        .filter(doc => (doc.finisherNo === null || doc.finisherNo === undefined)
            && toMs(doc.finishedAt) !== null && toMs(doc.finishedAt) >= sched.startAt && toMs(doc.finishedAt) < sched.endAt
            && Number(doc.total) > 0
            && !excluded.has(normalizeUuid(doc.uuid)))
        .sort((a, b) => toMs(a.finishedAt) - toMs(b.finishedAt) || String(a.uuid).localeCompare(String(b.uuid)));
}

/** The progress docs that earn week `index`'s reward: enough completions that week, not excluded. */
function weeklyRecipients(progressDocs, event, index) {
    const min = Number(event.weeklyMinContribution) || 0;
    const excluded = new Set((event.excluded || []).map(normalizeUuid));
    return progressDocs.filter(doc => !excluded.has(normalizeUuid(doc.uuid))
        && Number((doc.weeks || {})[index] || 0) >= Math.max(min, 1));
}

/**
 * The progress docs that earn the `veteran` reward: at least `veteran.minQuests` in every
 * week of the event, not excluded. `minQuests` defaults to the weekly minimum. Empty when
 * the event has no `veteran`.
 */
function veteranRecipients(progressDocs, event, sched) {
    const veteran = event.veteran;
    if (!veteran || typeof veteran !== 'object') return [];
    const min = Number(veteran.minQuests) > 0
        ? Number(veteran.minQuests)
        : Math.max(Number(event.weeklyMinContribution) || 0, 1);
    const excluded = new Set((event.excluded || []).map(normalizeUuid));
    return progressDocs.filter(doc => {
        if (excluded.has(normalizeUuid(doc.uuid))) return false;
        for (let i = 0; i < sched.weekCount; i++) {
            if (Number((doc.weeks || {})[i] || 0) < min) return false;
        }
        return true;
    });
}

/**
 * Compares a fresh count with the stored progress docs.
 * @returns {{changed: object[], cleared: string[]}} Rows to write, and uuids that no longer
 *     count (now excluded, or the window moved) whose stored numbers must go to zero.
 */
function diffProgress(existingDocs, players) {
    const byUuid = new Map(existingDocs.map(doc => [normalizeUuid(doc.uuid), doc]));
    const changed = [];
    for (const player of players.values()) {
        const doc = byUuid.get(player.uuid);
        const same = doc
            && Number(doc.total) === player.total
            && toMs(doc.firstAt) === player.firstAt
            && toMs(doc.founderAt) === player.founderAt
            && sameWeeks(doc.weeks, player.weeks)
            && (player.milestoneAt === undefined || sameTimes(doc.milestoneAt, player.milestoneAt))
            && (player.finishedAt === undefined || toMs(doc.finishedAt) === player.finishedAt);
        if (!same) changed.push(player);
    }
    const cleared = existingDocs
        .filter(doc => !players.has(normalizeUuid(doc.uuid)) && Number(doc.total) !== 0)
        .map(doc => normalizeUuid(doc.uuid));
    return { changed, cleared };
}

function sameWeeks(a = {}, b = {}) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const key of keys) {
        if (Number((a || {})[key] || 0) !== Number((b || {})[key] || 0)) return false;
    }
    return true;
}

function sameTimes(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const key of keys) {
        if (toMs((a || {})[key]) !== toMs((b || {})[key])) return false;
    }
    return true;
}

module.exports = {
    WEEK_MS,
    DEFAULT_WEEK_COUNT,
    normalizeUuid,
    toMs,
    parseQuestProgress,
    schedule,
    weekTarget,
    weekIndexAt,
    weekEnd,
    isWeekKey,
    milestoneSpecs,
    chapterSpecs,
    topChapter,
    finisherQuestId,
    earnsSpeedrunner,
    countEvent,
    finishers,
    buildTotals,
    closableWeeks,
    eventFinished,
    founderCandidates,
    milestoneCandidates,
    finisherCandidates,
    weeklyRecipients,
    veteranRecipients,
    diffProgress
};
