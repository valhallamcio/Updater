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
        const server = servers.find(s => s.tag === job.serverTag)
            || servers.find(s => s.serverId === job.serverId);

        if (!server) {
            sessionLogger.error('ScheduledRebootScheduler',
                `Scheduled reboot for "${job.serverTag}" skipped: server not found`);
            await this.notifyStaff(0xff0000, 'Scheduled Reboot Failed',
                `Server \`${job.serverTag}\` was not found at fire time.`);
            return;
        }

        sessionLogger.info('ScheduledRebootScheduler',
            `Firing scheduled reboot: ${server.tag} (warn ${job.warnWindow}min, by ${job.requestedBy || 'unknown'})`);
        await this.notifyStaff(0xffa500, 'Scheduled Reboot Started',
            `**${server.name || server.tag}** rebooting now (warning window: ${job.warnWindow} min)` +
            `${job.reason ? `\nReason: ${job.reason}` : ''}`);

        const result = await rebootScheduler.executeFullServerReboot(
            server,
            server.node || 'scheduled',
            { warnWindowMinutes: job.warnWindow },
        );

        // Let the same server be scheduled again later (clears completed/failed bookkeeping).
        rebootScheduler.resetSingleServerState(server.serverId);

        // Record outcome alongside the batch reboots.
        try {
            const today = timeManager.getTodayDateString();
            const hist = (await mongo.getRebootHistory(today)) || { date: today };
            hist.scheduledReboots = hist.scheduledReboots || [];
            hist.scheduledReboots.push({
                tag: server.tag,
                requestedBy: job.requestedBy || null,
                reason: job.reason || null,
                success: !!(result && result.success),
                reason_detail: result && result.reason ? result.reason : null,
                firedAt: new Date().toISOString(),
            });
            await mongo.updateRebootHistory(today, hist);
        } catch (err) {
            sessionLogger.warn('ScheduledRebootScheduler', `Failed to record history: ${err.message}`);
        }

        if (result && result.success) {
            await this.notifyStaff(0x00ff00, 'Scheduled Reboot Complete',
                `**${server.name || server.tag}** rebooted successfully.`);
        } else if (result && result.reason === 'cancelled') {
            await this.notifyStaff(0x9c59b6, 'Scheduled Reboot Cancelled',
                `**${server.name || server.tag}** reboot was cancelled.`);
        } else {
            await this.notifyStaff(0xff0000, 'Scheduled Reboot Failed',
                `**${server.name || server.tag}** failed to reboot: ${result ? result.reason : 'unknown'}`);
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
