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

    runJob: async function (job) {
        // One-shot: deactivate before doing anything so a crash/restart can't re-run it.
        await mongo.deactivateScheduleJob(job._id).catch(() => {});

        const servers = await yggdrasil.getServers();
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
        sessionLogger.info('ScheduledRebootScheduler',
            `Firing scheduled reboot: ${label} (warn ${job.warnWindow}min, by ${job.requestedBy || 'unknown'})`);
        await this.notifyStaff(0xffa500, 'Scheduled Reboot Started',
            `**${label}** rebooting now (warning window: ${job.warnWindow} min)` +
            `${job.reason ? `\nReason: ${job.reason}` : ''}`);

        // Reboot every instance concurrently; each runs its own warning countdown + stop/start.
        const results = await Promise.all(instances.map(s =>
            // scheduled:true => don't treat a server the daily batch already rebooted today as a
            // "duplicate" (completedServers lingers until the GMT+3 day rollover). See rebootScheduler.isServerActive.
            rebootScheduler.executeFullServerReboot(s, s.node || 'scheduled', { warnWindowMinutes: job.warnWindow, scheduled: true })
                .then(r => ({ s, r }))
                .catch(e => ({ s, r: { success: false, reason: e.message } }))
        ));
        // Let each server be scheduled again later (clears completed/failed bookkeeping).
        for (const { s } of results) rebootScheduler.resetSingleServerState(s.serverId);

        // Record outcome alongside the batch reboots.
        try {
            const today = timeManager.getTodayDateString();
            const hist = (await mongo.getRebootHistory(today)) || { date: today };
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
            await mongo.updateRebootHistory(today, hist);
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
