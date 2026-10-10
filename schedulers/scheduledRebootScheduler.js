/*
 * scheduledRebootScheduler.js
 *
 * Fires staff-scheduled, single-server reboots created via the /reboot command.
 * Jobs live in the `schedule_jobs` collection (type: 'scheduled_reboot') with:
 *   { type, serverTag, serverId, fireAt (epoch ms), warnWindow (minutes), reason, requestedBy }
 *
 * The poll loop starts a job's reboot when `now >= fireAt - warnWindow`, so the
 * version-aware alert countdown (rebootScheduler.executeRebootWarningsEnhanced) spans the
 * window and the server is stopped at ~fireAt. This unifies "reboot soon" (e.g. /reboot PRI 5
 * fires immediately) and "reboot later" (idles until the last warnWindow minutes).
 *
 * Jobs are one-shot: deactivated the moment they fire, so a VU restart can't double-reboot.
 *
 * A tag job (no instanceServerId) whose instances share a synced player sync group reboots
 * them one at a time, like the daily batch (rebootScheduler.planSyncGroupStagger).
 */

const mongo = require('../modules/mongo');
const yggdrasil = require('../modules/yggdrasil');
const timeManager = require('../modules/timeManager');
const rebootScheduler = require('./rebootScheduler');
const sessionLogger = require('../modules/sessionLogger');

const STAFF_CHANNEL_ID = '1358558826118381678';

module.exports = {
    name: 'scheduledRebootScheduler',
    defaultConfig: {
        active: true,
        interval: 20, // seconds between checks
    },

    // In-flight job ids (this process) so one poll tick can't start the same job twice.
    firing: new Set(),

    start: async function (options) {
        sessionLogger.info('ScheduledRebootScheduler',
            `Started - checking scheduled reboots every ${options.interval}s`);
        setInterval(() => this.tick().catch(err =>
            sessionLogger.error('ScheduledRebootScheduler', 'tick failed', err.message)), options.interval * 1000);
    },

    tick: async function () {
        const jobs = await mongo.getActiveScheduleJobs('scheduled_reboot');
        if (!jobs.length) return;
        const now = Date.now();

        for (const job of jobs) {
            const id = job._id.toString();
            if (this.firing.has(id)) continue;

            const warnMs = (job.warnWindow || 15) * 60000;
            if (now >= job.fireAt - warnMs) {
                this.firing.add(id);
                // Fire-and-forget; runJob deactivates the job and cleans up its own state.
                this.runJob(job).catch(err =>
                    sessionLogger.error('ScheduledRebootScheduler', `job ${id} failed`, err.message)
                ).finally(() => this.firing.delete(id));
            }
        }
    },

    /**
     * @param {object} job The scheduled_reboot doc.
     * @param {object} [deps] Injectable for tests: mongo, yggdrasil, rebootScheduler.
     */
    runJob: async function (job, deps = {}) {
        const db = deps.mongo || mongo;
        const ygg = deps.yggdrasil || yggdrasil;
        const rs = deps.rebootScheduler || rebootScheduler;

        // One-shot: deactivate before doing anything so a crash/restart can't re-run it.
        await db.deactivateScheduleJob(job._id).catch(() => {});

        const servers = await ygg.getServers();
        // instanceServerId set => one specific instance; otherwise reboot EVERY instance of the tag
        // (instanced servers share a tag but have distinct serverIds). Resolved at fire time so
        // instance count changes are picked up.
        const instances = job.instanceServerId
            ? servers.filter(s => s.serverId === job.instanceServerId)
            : servers.filter(s => s.tag === job.serverTag);

        if (!instances.length) {
            sessionLogger.error('ScheduledRebootScheduler',
                `Scheduled reboot for "${job.serverTag}" skipped: no matching server(s) at fire time`);
            await this.notifyStaff(0xff0000, 'Scheduled Reboot Failed',
                `\`${job.serverTag}\` had no matching server(s) at fire time.`);
            return;
        }

        const label = instances.length > 1
            ? `${job.serverTag} (${instances.length} instances)`
            : (instances[0].name || job.serverTag);

        // A tag whose instances share a synced group reboots them one at a time, with the same
        // gate and gap as the daily batch. Every other tag reboots its instances together.
        const { queue, followers } = instances.length > 1
            ? await rs.planSyncGroupStagger(instances, `Scheduled reboot ${job.serverTag}`)
            : { queue: instances, followers: new Map() };
        const staggerText = [...followers].map(([firstId, rest]) => {
            const first = instances.find(s => s.serverId === firstId);
            return `\nSync group: ${first ? first.name : firstId} reboots first. ${rest.map(s => s.name).join(', ')} follow one at a time, ${rs.syncStaggerMs() / 60000} min after the one before is back up.`;
        }).join('');

        sessionLogger.info('ScheduledRebootScheduler',
            `Firing scheduled reboot: ${label} (warn ${job.warnWindow}min, by ${job.requestedBy || 'unknown'})`);
        await this.notifyStaff(0xffa500, 'Scheduled Reboot Started',
            `**${label}** rebooting now (warning window: ${job.warnWindow} min)` +
            `${job.reason ? `\nReason: ${job.reason}` : ''}${staggerText}`);

        // scheduled:true => don't treat a server the daily batch already rebooted today as a
        // "duplicate" (completedServers lingers until the GMT+3 day rollover). See rebootScheduler.isServerActive.
        // requestedBy/reason ride along so the countdown doc in valhallamc.reboot_events says
        // who asked (a "Player vote (4/6)" job is the vote-restart source, staff otherwise).
        const rebootOpts = {
            warnWindowMinutes: job.warnWindow,
            scheduled: true,
            requestedBy: job.requestedBy,
            reason: job.reason,
        };
        const nodeOf = new Map(instances.map(s => [s.serverId, s.node || 'scheduled']));

        // Each instance runs its own warning countdown + stop/start. The queue reboots together;
        // the instances that follow a synced first one wait for it.
        const chains = queue.map(async (s) => {
            let r;
            try {
                r = await rs.executeFullServerReboot(s, nodeOf.get(s.serverId), rebootOpts);
            } catch (e) {
                r = { success: false, reason: e.message };
            }
            const rest = followers.get(s.serverId);
            if (!rest) return [{ s, r }];
            const more = await rs.rebootSyncFollowers(s, r, rest, nodeOf, { scheduled: true, rebootOpts });
            return [{ s, r }, ...more];
        });
        const results = (await Promise.all(chains)).flat();
        // Let each server be scheduled again later (clears completed/failed bookkeeping) — but ONLY
        // when this job actually owned the reboot. 'duplicate'/'state_conflict' means another reboot
        // (e.g. the daily batch, which now holds the lock from its uptime checks through start) owns
        // the activeReboots entry; wiping it here would delete THAT lock and allow a concurrent reboot.
        for (const { s, r } of results) {
            if (r && (r.reason === 'duplicate' || r.reason === 'state_conflict')) continue;
            rs.resetSingleServerState(s.serverId);
        }

        // Record outcome alongside the batch reboots.
        try {
            const today = timeManager.getTodayDateString();
            const hist = (await db.getRebootHistory(today)) || { date: today };
            hist.scheduledReboots = hist.scheduledReboots || [];
            for (const { s, r } of results) {
                hist.scheduledReboots.push({
                    tag: s.tag,
                    instance: s.name || null,
                    requestedBy: job.requestedBy || null,
                    reason: job.reason || null,
                    success: !!(r && r.success),
                    reason_detail: r && r.reason ? r.reason : null,
                    firedAt: new Date().toISOString(),
                });
            }
            await db.updateRebootHistory(today, hist);
        } catch (err) {
            sessionLogger.warn('ScheduledRebootScheduler', `Failed to record history: ${err.message}`);
        }

        const ok = results.filter(x => x.r && x.r.success).length;
        const failed = results.filter(x => !(x.r && x.r.success));
        if (failed.length === 0) {
            await this.notifyStaff(0x00ff00, 'Scheduled Reboot Complete',
                `**${label}** rebooted successfully (${ok}/${results.length}).`);
        } else {
            const detail = failed.map(x => `${x.s.name || x.s.tag}: ${x.r ? x.r.reason : 'unknown'}`).join('\n');
            await this.notifyStaff(ok > 0 ? 0xffa500 : 0xff0000, 'Scheduled Reboot Issues',
                `**${label}**: ${ok}/${results.length} ok.\nProblems:\n${detail}`);
        }
    },

    notifyStaff: async function (color, title, description) {
        try {
            const { EmbedBuilder } = require('discord.js');
            const { getClient } = require('../discord/bot');
            const client = await getClient();
            const channel = await client.channels.fetch(STAFF_CHANNEL_ID);
            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(title)
                .setDescription(description)
                .setTimestamp();
            await channel.send({ embeds: [embed] });
        } catch (err) {
            sessionLogger.debug('ScheduledRebootScheduler', `Staff notify skipped: ${err.message}`);
        }
    },
};
