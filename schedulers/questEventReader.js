/*
 * File: questEventReader.js
 * Project: valhalla-updater
 * -----
 * Counts BetterQuesting completions for the quest events in bifrost.quest_events
 * (DJ2 Season 2 first). The proxy's quest-events plugin shows what this writes.
 *
 * Every `interval` minutes, for each started event with a `serverId`:
 *   1. It reads QuestProgress.json through a signed panel download. The panel caps
 *      `files/contents`, and the legacy file is 19 MB. An unchanged mtime, size and
 *      count key skips the download and every progress write.
 *   2. It writes one quest_event_progress doc per uuid, then `totals` on the event.
 *      With `milestones`, a doc keeps when the player reached each one (`milestoneAt`).
 *      With `finisher`, it keeps when the player completed `finalQuestId` (`finishedAt`).
 *   3. It gives founder numbers (atomic `$inc` on `founderSeq`, once per player).
 *   4. It gives milestone numbers (`$inc` on `milestoneSeq.<key>`, once per player per
 *      milestone) and finisher numbers (`$inc` on `finisherSeq`) the same way. The first
 *      `finisher.firstN` finishers also get the `speedrunner` reward.
 *   5. It closes each finished week once, and marks the weekly reward for every
 *      player who did enough that week, when the community met the target.
 *   6. It queues every pending reward as a `give_item` op that waits up to 14 days
 *      for the player (`waiting_player`), with an idempotency key per reward.
 *
 * Every `finisherInterval` minutes it reads the file on the event server and on every
 * `legacyServerIds` server, and upserts each finisher of `finalQuestId` into
 * bifrost.pack_completions with the earliest time. It also reads back queued reward
 * ops and records `delivered` or `failed`.
 *
 * Rewards go out only with `config.yggdrasilOps.useOpsApi` on, the same lever as
 * playerEventScheduler. With it off, rewards stay `pending` and go out later.
 */

const axios = require('axios');
const mongo = require('../modules/mongo');
const pterodactyl = require('../modules/pterodactyl');
const yggdrasil = require('../modules/yggdrasil');
const sessionLogger = require('../modules/sessionLogger');
const questProgress = require('../modules/questProgress');
const questRewards = require('../modules/questRewards');

const PROGRESS_PATH = '/world/betterquesting/QuestProgress.json';
// A reward lands while the player is offline, so the op waits for their next login.
const GIVE_EXPIRES_MS = 14 * 24 * 3600 * 1000;
const DOWNLOAD_TIMEOUT_MS = 180000;
// How many queued reward ops one pass reads back.
const REFRESH_LIMIT = 50;
const SETTLED_OP_STATES = ['completed', 'failed', 'expired', 'cancelled'];

// Passes currently running. A slow 19 MB download must not overlap the next tick.
const inFlight = new Set();

/** The reward keys an event can have: `founder`, one per week, one per milestone, then the finisher pair. */
function rewardKeys(event, sched) {
    const keys = ['founder'];
    for (let i = 0; i < sched.weekCount; i++) keys.push(`week${i}`);
    for (const milestone of questProgress.milestoneSpecs(event)) keys.push(milestone.key);
    if (event.finisher) keys.push('finisher', 'speedrunner');
    return keys;
}

/** The spec for one reward key, and its place on the event doc for the log. */
function rewardSpec(event, key) {
    if (key === 'founder') return { spec: (event.founder || {}).reward, field: 'founder.reward' };
    if (key === 'finisher') return { spec: (event.finisher || {}).reward, field: 'finisher.reward' };
    if (key === 'speedrunner') return { spec: (event.finisher || {}).firstReward, field: 'finisher.firstReward' };
    if (questProgress.isWeekKey(key)) return { spec: event.weeklyReward, field: 'weeklyReward' };
    const milestone = questProgress.milestoneSpecs(event).find(m => m.key === key);
    return { spec: milestone && milestone.reward, field: `milestone ${key} reward` };
}

/**
 * Every input that changes the count. A change here forces a recount of an unchanged file.
 * The milestone and finisher inputs join only when the event has them, so an event
 * without them keeps its key.
 */
function countKey(event, sched) {
    const inputs = {
        startAt: sched.startAt,
        endAt: sched.endAt,
        weekMs: sched.weekMs,
        minQuests: (event.founder && event.founder.minQuests) || null,
        excluded: (event.excluded || []).map(questProgress.normalizeUuid).sort()
    };
    const milestones = questProgress.milestoneSpecs(event);
    if (milestones.length) inputs.milestones = milestones.map(m => [m.key, m.quests]);
    const finalQuestId = questProgress.finisherQuestId(event);
    if (finalQuestId !== null) inputs.finalQuestId = finalQuestId;
    return JSON.stringify(inputs);
}

function sameTotals(a, b) {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
}

module.exports = {
    name: 'questEventReader',
    defaultConfig: {
        "active": true,
        "interval": 5, // minutes between count passes
        "finisherInterval": 60, // minutes between finisher passes
        "weekCloseDelayMinutes": 15 // wait after a week ends, so the server saves the file first
    },

    /** The ops lever, read the same way as playerEventScheduler. Absent section = off. */
    opsConfig: function () {
        try {
            return require("../config/config.json").yggdrasilOps ?? { useOpsApi: false };
        } catch (err) {
            return { useOpsApi: false };
        }
    },

    /**
     * Starts both passes.
     * @param {object} options The scheduler config.
     */
    start: async function (options) {
        sessionLogger.info('QuestEventReader', `Quest event reader started - counts every ${options.interval} min, finishers every ${options.finisherInterval} min`);
        const count = () => this.guarded('count', () => this.countPass(options));
        const hourly = () => this.guarded('finishers', () => this.finisherPass(options));
        setInterval(count, options.interval * 60 * 1000);
        setInterval(hourly, options.finisherInterval * 60 * 1000);
        setTimeout(() => { count(); hourly(); }, 60 * 1000);
    },

    /** Runs a pass unless the same pass is still running. Errors are logged, never thrown. */
    guarded: async function (key, run) {
        if (inFlight.has(key)) return;
        inFlight.add(key);
        try {
            await run();
        } catch (error) {
            sessionLogger.error('QuestEventReader', `The ${key} pass failed:`, error.message);
        } finally {
            inFlight.delete(key);
        }
    },

    /**
     * The 5-minute pass over every started event with a `serverId`.
     * @param {object} options The scheduler config.
     * @param {number} [now] Epoch ms, for tests.
     */
    countPass: async function (options, now = Date.now()) {
        const events = await mongo.listQuestEvents();
        for (const event of events) {
            if (!event.serverId) continue;
            const sched = questProgress.schedule(event);
            if (!sched || now < sched.startAt) continue;
            try {
                await this.runEvent(event, sched, options, now);
            } catch (error) {
                sessionLogger.error('QuestEventReader', `Event ${event._id} failed:`, error.message);
            }
        }
    },

    /** One event's count pass. After the end, only the reward queue still runs. */
    runEvent: async function (event, sched, options, now) {
        if (!questProgress.eventFinished(sched, event.closedWeeks, now)) {
            const counts = await this.refreshCounts(event, sched, now);
            // No week closes and no number goes out on a pass that could not read the file.
            if (counts) {
                const progress = await mongo.getQuestEventProgress(event._id);
                await this.assignFounders(event, sched, progress, now);
                await this.assignMilestones(event, sched, progress, now);
                await this.assignFinishers(event, sched, progress, now);
                await this.closeWeeks(event, sched, progress, counts, options, now);
            }
        }
        if (this.opsConfig().useOpsApi) {
            await this.queuePendingRewards(event, sched, now);
        }
    },

    /**
     * Reads the file when it changed, writes the progress docs that changed, then `totals`.
     * @returns {Promise<{quests: number, players: number, weekCounts: number[]}|null>} The
     *     current counts, or null when the file could not be read.
     */
    refreshCounts: async function (event, sched, now) {
        const path = event.progressPath || PROGRESS_PATH;
        const stat = await this.statProgressFile(event.serverId, path);
        if (!stat) {
            sessionLogger.warn('QuestEventReader', `${path} not found on ${event.serverId} (event ${event._id})`);
            return null;
        }

        const key = countKey(event, sched);
        const source = event.source || {};
        const unchanged = source.mtime === stat.mtime && source.size === stat.size && source.key === key;
        const fields = {};
        let counts;
        if (unchanged) {
            const totals = event.totals || {};
            counts = { quests: totals.quests || 0, players: totals.players || 0, weekCounts: event.weekCounts || [] };
        } else {
            const text = await this.downloadProgressFile(event.serverId, path);
            const { quests, skipped } = questProgress.parseQuestProgress(text);
            if (skipped) sessionLogger.warn('QuestEventReader', `${skipped} quest entries on ${event.serverId} have no questID:3`);
            const badMilestones = (Array.isArray(event.milestones) ? event.milestones.length : 0) - questProgress.milestoneSpecs(event).length;
            if (badMilestones) sessionLogger.warn('QuestEventReader', `Event ${event._id}: ${badMilestones} milestones have a bad or taken key, or a bad quests count, and are skipped`);
            if (event.finisher && questProgress.finisherQuestId(event) === null) {
                sessionLogger.warn('QuestEventReader', `Event ${event._id} has a finisher but no finalQuestId, so nobody finishes`);
            }
            const result = questProgress.countEvent(quests, event);
            const existing = await mongo.getQuestEventProgress(event._id);
            const { changed, cleared } = questProgress.diffProgress(existing, result.players);
            if (changed.length || cleared.length) {
                await mongo.writeQuestEventProgress(event._id, changed, cleared, new Date(now));
            }
            counts = { quests: result.quests, players: result.players.size, weekCounts: result.weekCounts };
            fields.source = { mtime: stat.mtime, size: stat.size, key, readAt: new Date(now) };
            fields.weekCounts = counts.weekCounts;
            sessionLogger.info('QuestEventReader', `Event ${event._id}: ${counts.quests} completions by ${counts.players} players (${changed.length} changed, ${cleared.length} cleared)`);
        }

        const totals = questProgress.buildTotals(counts, sched, event.weeklyTargets, now);
        if (!unchanged || !sameTotals(event.totals, totals)) {
            fields.totals = totals;
            fields.updatedAt = new Date(now);
        }
        if (Object.keys(fields).length) await mongo.updateQuestEvent(event._id, fields);
        return counts;
    },

    /**
     * Gives the next founder number to each player who earned one, in the order they
     * reached `minQuests`. The number comes from an atomic `$inc`, and the progress write
     * matches only while the doc has no number. A lost race wastes a number and never
     * gives one player two.
     */
    assignFounders: async function (event, sched, progress, now) {
        for (const doc of questProgress.founderCandidates(progress, event, sched)) {
            const founderNo = await mongo.nextFounderNo(event._id);
            if (!Number.isInteger(founderNo)) {
                sessionLogger.warn('QuestEventReader', `Event ${event._id}: no founder number came back, stopping`);
                return;
            }
            const reward = { state: 'pending', n: founderNo, earnedAt: new Date(questProgress.toMs(doc.founderAt)), at: new Date(now) };
            const result = await mongo.setQuestEventFounderNo(event._id, doc.uuid, founderNo, reward);
            if (!result || result.matchedCount === 0) {
                sessionLogger.warn('QuestEventReader', `Event ${event._id}: founder #${founderNo} is unused, ${doc.uuid} already has a number`);
                continue;
            }
            doc.founderNo = founderNo;
            sessionLogger.info('QuestEventReader', `Event ${event._id}: founder #${founderNo} goes to ${doc.uuid}`);
        }
    },

    /**
     * Gives milestone numbers the founder way, with one sequence per milestone
     * (`milestoneSeq.<key>`), in the order players reached `quests`. There is no window.
     * The pending reward goes under the milestone key.
     */
    assignMilestones: async function (event, sched, progress, now) {
        for (const milestone of questProgress.milestoneSpecs(event)) {
            const { key } = milestone;
            for (const doc of questProgress.milestoneCandidates(progress, event, sched, milestone)) {
                const milestoneNo = await mongo.nextMilestoneNo(event._id, key);
                if (!Number.isInteger(milestoneNo)) {
                    sessionLogger.warn('QuestEventReader', `Event ${event._id}: no ${key} number came back, stopping`);
                    return;
                }
                const reward = { state: 'pending', n: milestoneNo, earnedAt: new Date(questProgress.toMs(doc.milestoneAt[key])), at: new Date(now) };
                const result = await mongo.setQuestEventMilestoneNo(event._id, doc.uuid, key, milestoneNo, reward);
                if (!result || result.matchedCount === 0) {
                    sessionLogger.warn('QuestEventReader', `Event ${event._id}: ${key} #${milestoneNo} is unused, ${doc.uuid} already has a number`);
                    continue;
                }
                doc.milestoneNo = { ...(doc.milestoneNo || {}), [key]: milestoneNo };
                sessionLogger.info('QuestEventReader', `Event ${event._id}: ${key} #${milestoneNo} goes to ${doc.uuid}`);
            }
        }
    },

    /**
     * Gives finisher numbers the founder way (`finisherSeq`), in the order players
     * completed `finalQuestId`. A number up to `finisher.firstN` also marks the
     * `speedrunner` reward, in the same write as the number.
     */
    assignFinishers: async function (event, sched, progress, now) {
        for (const doc of questProgress.finisherCandidates(progress, event, sched)) {
            const finisherNo = await mongo.nextFinisherNo(event._id);
            if (!Number.isInteger(finisherNo)) {
                sessionLogger.warn('QuestEventReader', `Event ${event._id}: no finisher number came back, stopping`);
                return;
            }
            const reward = { state: 'pending', n: finisherNo, earnedAt: new Date(questProgress.toMs(doc.finishedAt)), at: new Date(now) };
            const rewards = { finisher: reward };
            if (questProgress.earnsSpeedrunner(event, finisherNo)) rewards.speedrunner = { ...reward };
            const result = await mongo.setQuestEventFinisherNo(event._id, doc.uuid, finisherNo, rewards);
            if (!result || result.matchedCount === 0) {
                sessionLogger.warn('QuestEventReader', `Event ${event._id}: finisher #${finisherNo} is unused, ${doc.uuid} already has a number`);
                continue;
            }
            doc.finisherNo = finisherNo;
            sessionLogger.info('QuestEventReader', `Event ${event._id}: finisher #${finisherNo} goes to ${doc.uuid}${rewards.speedrunner ? ' (speedrunner)' : ''}`);
        }
    },

    /**
     * Closes each week that ended `weekCloseDelayMinutes` ago. When the week met its
     * target, every player with `weeklyMinContribution` that week gets a pending reward
     * first. The close comes after, so a crash in between marks the rewards again (a no-op)
     * and then closes.
     */
    closeWeeks: async function (event, sched, progress, counts, options, now) {
        const delayMs = (Number(options.weekCloseDelayMinutes) || 0) * 60 * 1000;
        for (const index of questProgress.closableWeeks(sched, event.closedWeeks, now, delayMs)) {
            const count = Number(counts.weekCounts[index]) || 0;
            const target = questProgress.weekTarget(event.weeklyTargets, index);
            const met = target !== null && count >= target;
            const recipients = met ? questProgress.weeklyRecipients(progress, event, index) : [];
            for (const doc of recipients) {
                await mongo.addQuestEventReward(event._id, doc.uuid, `week${index}`, { state: 'pending', week: index, at: new Date(now) });
            }
            await mongo.closeQuestEventWeek(event._id, {
                index, count, target, met, recipients: recipients.length, closedAt: new Date(now)
            });
            sessionLogger.info('QuestEventReader', `Event ${event._id}: week ${index + 1} closed at ${count}/${target}${met ? `, ${recipients.length} rewards` : ', target missed'}`);
        }
    },

    /**
     * Queues every `pending` reward as a `give_item` op on the event server. The op waits
     * for the player for 14 days. The idempotency key makes a second queue of one reward
     * return the first op.
     */
    queuePendingRewards: async function (event, sched, now) {
        const keys = rewardKeys(event, sched);
        const docs = await mongo.findQuestEventRewards(event._id, keys, 'pending');
        if (docs.length === 0) return;
        const names = await mongo.getBifrostUsernames(docs.map(d => d.uuid));

        for (const doc of docs) {
            for (const key of keys) {
                const reward = (doc.rewards || {})[key];
                if (!reward || reward.state !== 'pending') continue;
                const { spec, field } = rewardSpec(event, key);
                if (!spec) {
                    sessionLogger.warn('QuestEventReader', `Event ${event._id} has no ${field}, ${key} for ${doc.uuid} stays pending`);
                    continue;
                }
                await this.queueReward(event, doc.uuid, names.get(doc.uuid), key, reward, spec, now);
            }
        }
    },

    /** Queues one reward and records the op on the progress doc. */
    queueReward: async function (event, uuid, name, key, reward, spec, now) {
        const idempotencyKey = `qe:${event._id}:${key}:${uuid}`;
        const vars = questProgress.isWeekKey(key)
            ? { week: Number(reward.week) + 1 }
            : { n: reward.n, earnedAt: questProgress.toMs(reward.earnedAt) };

        let params;
        try {
            params = { ...questRewards.rewardParams(spec, vars), overflow: 'drop' };
        } catch (error) {
            sessionLogger.warn('QuestEventReader', `Event ${event._id}: bad ${key} reward spec (${error.message})`);
            return;
        }

        let created;
        try {
            ({ op: created } = await yggdrasil.createOp(event.serverId, {
                type: 'give_item',
                params,
                target: name ? { uuid, name } : { uuid },
                flags: { offlineMode: 'queue' },
                expiresInMs: GIVE_EXPIRES_MS,
                idempotencyKey
            }));
        } catch (error) {
            const status = error.response && error.response.status;
            const message = (error.response && error.response.data && error.response.data.error && error.response.data.error.message) || error.message;
            // Yggdrasil refused the op itself. A retry sends the same body, so it would fail the same way.
            if (status >= 400 && status < 500 && status !== 429) {
                await mongo.setQuestEventReward(event._id, uuid, key, { ...reward, state: 'failed', error: String(message), idempotencyKey, failedAt: new Date(now) });
                sessionLogger.warn('QuestEventReader', `${key} for ${uuid} refused (${status}: ${message})`);
            } else {
                sessionLogger.warn('QuestEventReader', `${key} for ${uuid} could not be queued (${message}), retrying next pass`);
            }
            return;
        }

        await mongo.setQuestEventReward(event._id, uuid, key, {
            ...reward, state: 'queued', opId: created._id, idempotencyKey, queuedAt: new Date(now)
        });
        sessionLogger.info('QuestEventReader', `Event ${event._id}: ${key} for ${name || uuid} queued as op ${created._id} (${created.state})`);
    },

    /**
     * Reads back queued reward ops and records the outcome. `completed` is `delivered`.
     * `failed`, `expired` and `cancelled` are `failed`, with the op state kept.
     */
    refreshQueuedRewards: async function (event, sched, now) {
        const keys = rewardKeys(event, sched);
        const docs = await mongo.findQuestEventRewards(event._id, keys, 'queued');
        let reads = 0;
        for (const doc of docs) {
            for (const key of keys) {
                const reward = (doc.rewards || {})[key];
                if (!reward || reward.state !== 'queued' || !reward.opId) continue;
                if (reads++ >= REFRESH_LIMIT) return;
                let op;
                try {
                    op = await yggdrasil.getOp(reward.opId);
                } catch (error) {
                    continue;
                }
                if (!op || !SETTLED_OP_STATES.includes(op.state)) continue;
                const settled = op.state === 'completed'
                    ? { ...reward, state: 'delivered', opState: op.state, given: op.result && op.result.data ? op.result.data.given : undefined, settledAt: new Date(now) }
                    : { ...reward, state: 'failed', opState: op.state, error: String((op.result && op.result.error) || op.state), settledAt: new Date(now) };
                await mongo.setQuestEventReward(event._id, doc.uuid, key, settled);
            }
        }
    },

    /**
     * The hourly pass: finishers on every server of every event, then queued reward ops.
     * Finishers need no `startAt`: they count any time, on legacy servers too.
     * @param {object} options The scheduler config.
     * @param {number} [now] Epoch ms, for tests.
     */
    finisherPass: async function (options, now = Date.now()) {
        const events = await mongo.listQuestEvents();
        for (const event of events) {
            const finalQuestId = Number(event.finalQuestId);
            if (event.tag && Number.isInteger(finalQuestId)) {
                const servers = [...new Set([...(event.legacyServerIds || []), event.serverId].filter(Boolean))];
                for (const serverId of servers) {
                    try {
                        await this.readFinishers(event, serverId, finalQuestId, now);
                    } catch (error) {
                        sessionLogger.warn('QuestEventReader', `Finishers on ${serverId} (event ${event._id}) failed:`, error.message);
                    }
                }
            }
            const sched = questProgress.schedule(event);
            if (sched && event.serverId && this.opsConfig().useOpsApi) {
                try {
                    await this.refreshQueuedRewards(event, sched, now);
                } catch (error) {
                    sessionLogger.warn('QuestEventReader', `Reward read-back for ${event._id} failed:`, error.message);
                }
            }
        }
    },

    /** One server's finishers. An unchanged file is skipped. */
    readFinishers: async function (event, serverId, finalQuestId, now) {
        const path = event.progressPath || PROGRESS_PATH;
        const stat = await this.statProgressFile(serverId, path);
        if (!stat) {
            sessionLogger.warn('QuestEventReader', `${path} not found on ${serverId} (event ${event._id} finishers)`);
            return;
        }
        const seen = (event.finisherSources || {})[serverId] || {};
        if (seen.mtime === stat.mtime && seen.size === stat.size && seen.questId === finalQuestId) return;

        const { quests } = questProgress.parseQuestProgress(await this.downloadProgressFile(serverId, path));
        const list = questProgress.finishers(quests, finalQuestId);
        if (list.length) await mongo.upsertPackCompletions(event.tag, serverId, finalQuestId, list);
        await mongo.updateQuestEvent(event._id, {
            [`finisherSources.${serverId}`]: { mtime: stat.mtime, size: stat.size, questId: finalQuestId, finishers: list.length, readAt: new Date(now) }
        });
        sessionLogger.info('QuestEventReader', `${event.tag}: ${list.length} finishers of quest ${finalQuestId} on ${serverId}`);
    },

    /**
     * The file's size and mtime from the panel listing.
     * @returns {Promise<{size: number, mtime: string}|null>} Null when the panel does not list it.
     */
    statProgressFile: async function (serverId, path) {
        const slash = path.lastIndexOf('/');
        const directory = slash > 0 ? path.slice(0, slash) : '/';
        const name = path.slice(slash + 1);
        const entries = await pterodactyl.listFiles(serverId, directory);
        const entry = entries.find(e => e.name === name && e.is_file !== false);
        return entry ? { size: Number(entry.size), mtime: String(entry.modified_at) } : null;
    },

    /**
     * Downloads the file through a signed panel URL.
     * @returns {Promise<string>} The file text.
     */
    downloadProgressFile: async function (serverId, path) {
        const url = await pterodactyl.getDownloadLink(serverId, path);
        if (!url) throw new Error(`The panel gave no download link for ${path} on ${serverId}`);
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: DOWNLOAD_TIMEOUT_MS,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        return Buffer.from(response.data).toString('utf8');
    }
};

module.exports.PROGRESS_PATH = PROGRESS_PATH;
module.exports.GIVE_EXPIRES_MS = GIVE_EXPIRES_MS;
module.exports.rewardKeys = rewardKeys;
module.exports.countKey = countKey;
