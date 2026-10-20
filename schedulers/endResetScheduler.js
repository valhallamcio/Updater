/*
 * endResetScheduler.js
 *
 * Runs `end_reset` jobs from valhallamc.schedule_jobs. Each job has one action:
 *   plan     Dry run. `save-all flush` over the link, then the `end_reset_plan` link op writes
 *            plan.json on the server. VU reads it, stores it on the job and posts the summary
 *            and the mails to staff.
 *   apply    Writes request.json for a stored dry run and inserts one scheduled_reboot with
 *            instanceServerId. After the boot it reads result.json, verifies, then mails.
 *   verify   Runs the verify step again for a resetId.
 *   mail     Sends the mails of an applied reset. With mailDryRun it only posts them.
 *   restore  Writes restore.json (its own restoreId) for a resetId and inserts one scheduled_reboot.
 *
 * Job shapes: docs/end-reset.md. Contract: bifrost-lib docs/invariants/end-reset.md.
 * The only restart path is the scheduled_reboot job, so players get the usual countdown.
 */

const sessionLogger = require('../modules/sessionLogger');
const endReset = require('../modules/endReset');
const endResetVerify = require('../modules/endResetVerify');

const { JOB_TYPE, PATHS } = endReset;

// The channel the reboot schedulers post their notices to.
const STAFF_CHANNEL_ID = '1358558826118381678';
const PLAN_OP_WAIT_MS = 10 * 60000;
const PLAN_OP_EXPIRES_MS = 5 * 60000;
const SAVE_WAIT_MS = 3 * 60000;
const RESULT_GRACE_MS = 30 * 60000;
const EMBED_LIMIT = 4000;
const LOG_PATH = 'logs/latest.log';
const COLORS = { info: 0x3498db, go: 0xffa500, ok: 0x00ff00, bad: 0xff0000 };

/** Fills in the real services for every dep a caller did not pass. Tests pass all of them. */
function withDeps(deps = {}) {
    const d = { ...deps };
    if (!d.mongo) d.mongo = require('../modules/mongo');
    if (!d.yggdrasil) d.yggdrasil = require('../modules/yggdrasil');
    if (!d.pterodactyl) d.pterodactyl = require('../modules/pterodactyl');
    if (!d.http) d.http = require('axios');
    if (!d.notify) d.notify = notifyStaff;
    if (!d.now) d.now = () => Date.now();
    if (!d.newId) d.newId = () => endReset.ulid(d.now());
    return d;
}

function clip(text) {
    const s = String(text || '');
    return s.length > EMBED_LIMIT ? `${s.slice(0, EMBED_LIMIT - 20)}\n... (cut)` : s;
}

async function notifyStaff(msg) {
    try {
        const { EmbedBuilder } = require('discord.js');
        const { getClient } = require('../discord/bot');
        const client = await getClient();
        const channel = await client.channels.fetch(STAFF_CHANNEL_ID);
        const embed = new EmbedBuilder()
            .setColor(msg.color)
            .setTitle(msg.title)
            .setDescription(clip(msg.description))
            .setTimestamp();
        const files = (msg.files || []).map(f => ({ attachment: Buffer.from(f.text, 'utf8'), name: f.name }));
        await channel.send({ embeds: [embed], files });
    } catch (err) {
        sessionLogger.warn('EndResetScheduler', `Staff notice not sent: ${err.message}`);
    }
}

function unix(ms) {
    return Math.floor(ms / 1000);
}

/** One console command over the link. Resolves with the op doc; throws when no answer came. */
async function runCommand(d, serverId, command, waitMs) {
    return d.yggdrasil.runOp(serverId, {
        type: 'run_command',
        params: { command },
        expiresInMs: PLAN_OP_EXPIRES_MS,
    }, waitMs);
}

/** files/contents first; the download link when the panel refuses the size. */
async function readFileBytes(d, serverId, p) {
    try {
        return await d.pterodactyl.getFileContents(serverId, p);
    } catch (err) {
        return endResetVerify.panelIo(serverId, d.pterodactyl, d.http).readBinary(p);
    }
}

module.exports = {
    name: 'endResetScheduler',
    defaultConfig: {
        active: true,
        interval: 30, // seconds between checks
    },

    // Job ids in flight in this process, so one tick does not start a job twice.
    running: new Set(),

    STAFF_CHANNEL_ID,
    withDeps,

    start: async function (options) {
        sessionLogger.info('EndResetScheduler', `Started - checking ${JOB_TYPE} jobs every ${options.interval}s`);
        setInterval(() => this.tick().catch(err =>
            sessionLogger.error('EndResetScheduler', 'tick failed', err.message)), options.interval * 1000);
    },

    tick: async function (deps) {
        const d = withDeps(deps);
        const jobs = await d.mongo.getActiveScheduleJobs(JOB_TYPE);
        const runs = [];
        for (const doc of jobs) {
            const id = String(doc._id);
            if (this.running.has(id)) continue;
            this.running.add(id);
            runs.push(this.runJob(doc, d)
                .catch(err => sessionLogger.error('EndResetScheduler', `job ${id} failed`, err.message))
                .finally(() => this.running.delete(id)));
        }
        return Promise.all(runs);
    },

    /**
     * @param {object} doc The end_reset job doc.
     * @param {object} [deps] mongo, yggdrasil, pterodactyl, http, notify, now, newId.
     */
    runJob: async function (doc, deps) {
        const d = withDeps(deps);
        const parsed = endReset.parseJob(doc);
        if (!parsed.ok) return this.fail(d, doc, null, parsed.error);
        const job = parsed.job;

        const servers = await d.yggdrasil.getServers();
        const server = servers.find(s => s.serverId === job.instanceServerId);
        if (!server) return this.fail(d, doc, null, `No server has the panel id ${job.instanceServerId}.`);

        const ctx = {
            d, doc, job, server,
            label: `${server.name || server.tag} (${server.serverId})`,
            io: endResetVerify.panelIo(server.serverId, d.pterodactyl, d.http),
        };
        const run = {
            plan: () => this.runPlan(ctx),
            apply: () => this.runApply(ctx),
            verify: () => this.runVerify(ctx),
            mail: () => this.runMail(ctx),
            restore: () => this.runRestore(ctx),
        }[job.action];
        try {
            return await run();
        } catch (err) {
            return this.fail(d, doc, ctx.label, `The ${job.action} step stopped: ${err.message}`);
        }
    },

    fail: async function (d, doc, label, message) {
        sessionLogger.warn('EndResetScheduler', `Job ${doc._id} (${doc.action}) stopped: ${message}`);
        await d.mongo.updateScheduleJob(doc._id, { error: message, failedAt: new Date(d.now()) }).catch(() => {});
        await d.mongo.deactivateScheduleJob(doc._id).catch(() => {});
        await d.notify({
            color: COLORS.bad,
            title: `End reset ${doc.action || 'job'} stopped`,
            description: `${label ? `**${label}**\n` : ''}${message}`,
        });
        return { ok: false, error: message };
    },

    // ── plan ────────────────────────────────────────────────────────────────

    runPlan: async function ({ d, doc, server, label }) {
        // One-shot, like a scheduled reboot: a VU restart mid-op does not run it twice.
        await d.mongo.deactivateScheduleJob(doc._id);

        // The planner reads the files on disk, so claims and homes the game holds in memory go first.
        let save;
        try {
            save = await runCommand(d, server.serverId, 'save-all flush', SAVE_WAIT_MS);
        } catch (err) {
            return this.fail(d, doc, label, `save-all got no answer over the link: ${err.message}`);
        }
        if (!save || save.state !== 'completed') {
            return this.fail(d, doc, label, `save-all ended ${save ? save.state : 'with no doc'}. The dry run needs saved files.`);
        }

        let op;
        try {
            op = await d.yggdrasil.runOp(server.serverId, {
                type: endReset.PLAN_OP,
                params: {},
                expiresInMs: PLAN_OP_EXPIRES_MS,
                execTimeoutMs: PLAN_OP_WAIT_MS,
            }, PLAN_OP_WAIT_MS);
        } catch (err) {
            return this.fail(d, doc, label, `The ${endReset.PLAN_OP} op got no answer: ${err.message}`);
        }
        if (!op || op.state !== 'completed') {
            const why = op && op.result ? (op.result.error || JSON.stringify(op.result).slice(0, 300)) : '';
            return this.fail(d, doc, label, `The ${endReset.PLAN_OP} op ended ${op ? op.state : 'with no doc'}${why ? `: ${why}` : ''}.`);
        }
        const data = (op.result && (op.result.data || op.result)) || {};

        if (data.path && data.path !== PATHS.plan) {
            return this.fail(d, doc, label, `The op wrote ${data.path}. VU reads ${PATHS.plan} only.`);
        }
        const bytes = await readFileBytes(d, server.serverId, PATHS.plan);
        if (!bytes) return this.fail(d, doc, label, `The op finished, but ${PATHS.plan} is missing.`);
        const planSha256 = endReset.sha256(bytes);
        if (!data.planSha256) return this.fail(d, doc, label, 'The op result has no planSha256.');
        if (data.planSha256 !== planSha256) {
            return this.fail(d, doc, label, `${PATHS.plan} changed after the op: the op says planSha256 ${data.planSha256}, the file has ${planSha256}.`);
        }
        let plan;
        try {
            plan = endReset.parsePlan(bytes);
        } catch (err) {
            return this.fail(d, doc, label, err.message);
        }
        if (!endReset.ULID_RE.test(String(plan.planId))) return this.fail(d, doc, label, 'plan.json has no valid planId.');
        if (data.planId && data.planId !== plan.planId) {
            return this.fail(d, doc, label, `The op made plan ${data.planId}, but plan.json holds ${plan.planId}.`);
        }

        const summary = endReset.summarizePlan(plan, { serverLabel: label, planSha256 });
        const mails = endReset.buildMails(plan.affectedPlayers, {
            resetId: 'DRYRUN',
            serverId: server.serverId,
            serverLabel: server.name || server.tag,
            now: new Date(d.now()),
        });
        await d.mongo.updateScheduleJob(doc._id, {
            planId: plan.planId,
            planSha256,
            planText: bytes.toString('utf8'),
            summary,
            plannedAt: new Date(d.now()),
            mailPreview: mails.map(m => ({ player: m.player, name: m.name, text: m.text, error: m.error || null })),
        });
        sessionLogger.info('EndResetScheduler', `Dry run ${plan.planId} on ${label}:\n${summary}`);
        await d.notify({
            color: COLORS.info,
            title: 'End reset dry run',
            description: `${summary}\n\nThe attached file holds the ${mails.length} mails the reset would send.\n` +
                `To apply, insert: \`{type: '${JOB_TYPE}', action: 'apply', instanceServerId: '${server.serverId}', planId: '${plan.planId}'}\``,
            files: [{ name: `end-reset-mails-${plan.planId}.txt`, text: endReset.mailsAsText(mails) || 'No affected players.' }],
        });
        return { ok: true, planId: plan.planId, planSha256, summary, mails };
    },

    // ── apply and restore ───────────────────────────────────────────────────

    runApply: async function (ctx) {
        const { d, doc, job, label } = ctx;
        if (!job.phase) return this.applyStart(ctx);
        if (job.phase === 'awaiting_result') return this.awaitResult(ctx, 'reset');
        if (job.phase === 'requesting') {
            return this.fail(d, doc, label, `The job stopped while it wrote the request for ${job.resetId}. Check ${PATHS.request} and the scheduled reboots by hand.`);
        }
        return this.fail(d, doc, label, `Unknown phase ${job.phase}.`);
    },

    runRestore: async function (ctx) {
        const { d, doc, job, label } = ctx;
        if (!job.phase) return this.restoreStart(ctx);
        if (job.phase === 'awaiting_result') return this.awaitResult(ctx, 'restore');
        if (job.phase === 'requesting') {
            return this.fail(d, doc, label, `The job stopped while it wrote restore ${job.restoreId} for reset ${job.resetId}. Check ${PATHS.restore} and the scheduled reboots by hand.`);
        }
        return this.fail(d, doc, label, `Unknown phase ${job.phase}.`);
    },

    /** The stored dry run for a planId on this server, or null. */
    storedPlan: async function (d, serverId, planId) {
        const docs = await d.mongo.findScheduleJobs({ type: JOB_TYPE, action: 'plan', instanceServerId: serverId, planId }, 1);
        const stored = docs[0];
        return stored && stored.planSha256 && stored.planText ? stored : null;
    },

    /** Fix states of the running server from `bf fixes`, or null when the link gave no answer. */
    readFixStates: async function (d, serverId) {
        try {
            const op = await runCommand(d, serverId, 'bf fixes', SAVE_WAIT_MS);
            if (!op || op.state !== 'completed') return null;
            const states = endReset.parseFixStates(op.result && op.result.data && op.result.data.output);
            return states.size ? states : null;
        } catch (err) {
            sessionLogger.warn('EndResetScheduler', `bf fixes on ${serverId}: ${err.message}`);
            return null;
        }
    },

    /** Why a new request may not go out now, or null. */
    pendingWork: async function ({ d, server }) {
        const id = server.serverId;
        for (const p of [PATHS.request, PATHS.restore]) {
            if (await d.pterodactyl.getFileContents(id, p)) return `${p} already waits on the server. Remove it, or let the mod use it up at the next boot.`;
        }
        const reboots = await d.mongo.getActiveScheduleJobs('scheduled_reboot');
        const pending = reboots.find(j => j.instanceServerId === id || (!j.instanceServerId && j.serverTag === server.tag));
        if (pending) {
            return `A reboot is already scheduled for <t:${unix(pending.fireAt)}:f>. Cancel it with /reboot-cancel first.`;
        }
        return null;
    },

    applyStart: async function (ctx) {
        const { d, doc, job, server, label } = ctx;
        const id = server.serverId;

        const stored = await this.storedPlan(d, id, job.planId);
        if (!stored) return this.fail(d, doc, label, `No stored dry run for plan ${job.planId} on this server. Run a plan job first.`);
        const bytes = await readFileBytes(d, id, PATHS.plan);
        if (!bytes) return this.fail(d, doc, label, `${PATHS.plan} is missing on the server.`);
        if (endReset.sha256(bytes) !== stored.planSha256) {
            return this.fail(d, doc, label, `${PATHS.plan} on the server is not the plan staff accepted (${job.planId}). Run a new dry run.`);
        }
        const plan = endReset.parsePlan(bytes);

        const busy = await this.pendingWork(ctx);
        if (busy) return this.fail(d, doc, label, busy);

        let disk = null;
        try {
            disk = await d.pterodactyl.getDiskSpace(id);
        } catch (err) {
            sessionLogger.warn('EndResetScheduler', `Disk numbers for ${id}: ${err.message}`);
        }
        const fixStates = (plan.requiresFixes || []).length ? await this.readFixStates(d, id) : null;
        const problems = endReset.preflight(plan, { ignoreUnsupported: job.ignoreUnsupported, disk, fixStates });
        if (problems.length) return this.fail(d, doc, label, problems.join('\n'));

        const now = d.now();
        const fireAt = job.fireAt && job.fireAt > now ? job.fireAt : now + job.warnWindow * 60000;
        const { notBefore, notAfter } = endReset.requestWindow(fireAt, job.windowMinutes);
        const resetId = d.newId();
        const text = endReset.buildRequest({
            resetId,
            planId: plan.planId,
            planSha256: stored.planSha256,
            notBefore,
            notAfter,
            requestedBy: job.requestedBy,
            ignoreUnsupported: job.ignoreUnsupported,
        });
        const totals = endReset.planTotals(plan);
        return this.writeAndReboot(ctx, {
            kind: 'reset',
            path: PATHS.request,
            text,
            jobId: resetId,
            resetId,
            fireAt,
            notBefore,
            notAfter,
            reason: `End reset ${resetId}`,
            extra: `Plan \`${plan.planId}\`: kept ${totals.kept}, moved ${totals.moved}, wiped ${totals.wiped}, ${totals.players} players affected.`,
        });
    },

    restoreStart: async function (ctx) {
        const { d, doc, job, server, label } = ctx;
        const id = server.serverId;

        const manifestPath = PATHS.manifest(job.resetId);
        const manifestText = await d.pterodactyl.getFileContents(id, manifestPath);
        if (!manifestText) return this.fail(d, doc, label, `No manifest at ${manifestPath}.`);
        const manifest = endReset.parseManifest(manifestText);
        if (manifest.complete !== true) return this.fail(d, doc, label, 'The manifest is not complete. The mod refuses a restore from it.');

        const files = manifest.files || [];
        const created = files.filter(f => f.action === 'created').length;
        const putBack = `puts back ${files.length - created} files${created ? ` and deletes ${created} the reset created` : ''}`;
        if (!job.confirmLoss) {
            await d.mongo.updateScheduleJob(doc._id, { error: 'confirmLoss not set' }).catch(() => {});
            await d.mongo.deactivateScheduleJob(doc._id);
            const list = files.slice(0, 15).map(f => `- ${f.path}`).join('\n');
            await d.notify({
                color: COLORS.go,
                title: 'End restore needs a confirm',
                description: `**${label}** reset \`${job.resetId}\`: the restore ${putBack}.\n${list}${files.length > 15 ? `\n- and ${files.length - 15} more` : ''}\n\n` +
                    'Player progress made after the reset in these files is lost. To go on, insert the restore job again with `confirmLoss: true`.',
            });
            return { ok: false, needsConfirm: true };
        }

        const busy = await this.pendingWork(ctx);
        if (busy) return this.fail(d, doc, label, busy);

        const now = d.now();
        const fireAt = job.fireAt && job.fireAt > now ? job.fireAt : now + job.warnWindow * 60000;
        const { notBefore, notAfter } = endReset.requestWindow(fireAt, job.windowMinutes);
        const restoreId = d.newId();
        const text = endReset.buildRestore({ restoreId, resetId: job.resetId, notBefore, notAfter, requestedBy: job.requestedBy });
        return this.writeAndReboot(ctx, {
            kind: 'restore',
            path: PATHS.restore,
            text,
            jobId: restoreId,
            resetId: job.resetId,
            fireAt,
            notBefore,
            notAfter,
            reason: `End reset restore ${job.resetId}`,
            extra: `The restore ${putBack}. Player progress made after the reset in those files is lost.`,
        });
    },

    /** Writes the request file, then the one scheduled reboot that boots into it. */
    writeAndReboot: async function ({ d, doc, job, server, label }, w) {
        const id = server.serverId;
        await d.mongo.updateScheduleJob(doc._id, {
            phase: 'requesting', resetId: w.resetId, fireAt: w.fireAt, notBefore: w.notBefore, notAfter: w.notAfter,
            ...(w.kind === 'restore' ? { restoreId: w.jobId } : {}),
        });

        try {
            await d.pterodactyl.writeFile(id, w.path, w.text);
            const back = await d.pterodactyl.getFileContents(id, w.path);
            if (!back || back.toString('utf8') !== w.text) throw new Error('the file reads back different');
        } catch (err) {
            await this.removeFile(d, id, w.path);
            return this.fail(d, doc, label, `Could not write ${w.path}: ${err.message}`);
        }

        let reboot;
        try {
            reboot = await d.mongo.createScheduleJob({
                type: 'scheduled_reboot',
                serverTag: server.tag,
                instanceServerId: id,
                serverId: id,
                fireAt: w.fireAt,
                warnWindow: job.warnWindow,
                reason: w.reason,
                requestedBy: job.requestedBy,
                endResetJobId: String(doc._id),
            });
        } catch (err) {
            await this.removeFile(d, id, w.path);
            return this.fail(d, doc, label, `Could not schedule the reboot: ${err.message}. ${w.path} was removed.`);
        }

        await d.mongo.updateScheduleJob(doc._id, {
            phase: 'awaiting_result',
            requestWrittenAt: new Date(d.now()),
            rebootJobId: reboot && reboot.insertedId ? reboot.insertedId : null,
        });
        const title = w.kind === 'reset' ? 'End reset scheduled' : 'End restore scheduled';
        sessionLogger.info('EndResetScheduler', `${title}: ${label}, ${w.kind} ${w.jobId}, reboot at ${endReset.isoZ(w.fireAt)}`);
        await d.notify({
            color: COLORS.go,
            title,
            description: `**${label}** reboots <t:${unix(w.fireAt)}:R> (<t:${unix(w.fireAt)}:f>). Players get the usual ${job.warnWindow} min warning.\n` +
                `${w.kind === 'restore' ? `Restore \`${w.jobId}\` of reset` : 'Reset'} \`${w.resetId}\`. The request is good from ${endReset.isoZ(w.notBefore)} to ${endReset.isoZ(w.notAfter)}.\n${w.extra || ''}`,
        });
        return { ok: true, resetId: w.resetId, jobId: w.jobId, fireAt: w.fireAt, notBefore: w.notBefore, notAfter: w.notAfter };
    },

    removeFile: async function (d, serverId, p) {
        const slash = p.lastIndexOf('/');
        const ok = await Promise.resolve(d.pterodactyl.deleteFile(serverId, [p.slice(slash + 1)], `/${p.slice(0, slash)}`)).catch(() => false);
        if (!ok) sessionLogger.error('EndResetScheduler', `Could not remove ${p} on ${serverId}. Check that it is gone.`);
    },

    /** result.<id>.json of one job; result.json (the last job) when the per-job file is missing. */
    readResult: async function ({ d, server }, id) {
        const own = await d.pterodactyl.getFileContents(server.serverId, PATHS.resultOf(id));
        const text = own || await d.pterodactyl.getFileContents(server.serverId, PATHS.result);
        return text ? endReset.parseResult(text) : null;
    },

    /** After the reboot: waits for result.json of this request, then reports, verifies and mails. */
    awaitResult: async function (ctx, kind) {
        const { d, doc, job, label } = ctx;
        const now = d.now();
        if (job.fireAt && now < job.fireAt) return { ok: true, waiting: 'reboot' };

        const id = kind === 'restore' ? job.restoreId : job.resetId;
        let result = null;
        try {
            result = await this.readResult(ctx, id);
        } catch (err) {
            sessionLogger.warn('EndResetScheduler', `${PATHS.resultOf(id)} on ${label}: ${err.message}`);
        }
        const mine = result && result.kind === kind && (kind === 'restore' ? result.restoreId === id : result.resetId === id);
        if (!mine) {
            const deadline = (job.notAfter || job.fireAt || now) + RESULT_GRACE_MS;
            if (now > deadline) {
                const file = kind === 'reset' ? 'request' : 'restore';
                return this.fail(d, doc, label, `No ${kind} result for ${id} came by ${endReset.isoZ(deadline)}. ` +
                    `The server did not boot in the window, or the mod did not take the request (an id already in done.json gives ${file}.${id}.ignored.json and no result). Check ${PATHS.dir} and the boot log.`);
            }
            return { ok: true, waiting: 'result' };
        }

        // Inner gateways are built at ServerStartedEvent, after the outcome line. Wait for their step line.
        if (kind === 'reset' && result.status === 'applied' && (result.innerGateways || []).length) {
            const log = await ctx.io.readBinary(LOG_PATH).catch(() => null);
            const deadline = (job.notAfter || job.fireAt || now) + RESULT_GRACE_MS;
            if (!endResetVerify.innerGatewaysLine(log ? log.toString('utf8') : '', job.resetId) && now <= deadline) {
                return { ok: true, waiting: 'inner gateways' };
            }
        }

        await d.mongo.updateScheduleJob(doc._id, { phase: 'done', result, resultAt: new Date(d.now()) });
        await d.mongo.deactivateScheduleJob(doc._id);

        if (kind === 'restore') {
            const good = result.status === 'restored';
            const files = Array.isArray(result.files) ? result.files.length : result.files;
            await d.notify({
                color: good ? COLORS.ok : COLORS.bad,
                title: `End restore ${result.status}`,
                description: `**${label}** restore \`${id}\` of reset \`${job.resetId}\`: status ${result.status}` +
                    `${files != null ? `, ${files} files` : ''}${result.reason ? `, reason: ${result.reason}` : ''}.`,
            });
            return { ok: good, result };
        }
        if (result.status !== 'applied') {
            await d.notify({
                color: COLORS.bad,
                title: `End reset ${result.status}`,
                description: `**${label}** reset \`${job.resetId}\` was not applied: status ${result.status}${result.reason ? `, reason: ${result.reason}` : ''}. No mails go out.`,
            });
            return { ok: false, result };
        }

        let report;
        try {
            report = await this.verifyAndReport(ctx, result, job.planId);
        } catch (err) {
            await d.notify({
                color: COLORS.bad,
                title: 'End reset verify stopped',
                description: `**${label}** reset \`${job.resetId}\` was applied, but the verify step stopped: ${err.message}\nMails are held. Insert a verify job, then a mail job.`,
            });
            return { ok: false, result, error: err.message };
        }
        if (!report.ok) return { ok: false, result, report };
        if (!job.sendMails) return { ok: true, result, report };
        const mails = await this.sendMails(ctx, result, job.mailDryRun);
        return { ok: true, result, report, mails };
    },

    // ── verify and mail ─────────────────────────────────────────────────────

    /**
     * The plan of a reset: the stored dry run first, then plan.json on the server when its
     * sha256 matches the manifest.
     */
    loadPlan: async function ({ d, server }, result, manifest, planId) {
        let id = planId;
        if (!id) {
            const applies = await d.mongo.findScheduleJobs({ type: JOB_TYPE, action: 'apply', instanceServerId: server.serverId, resetId: result.resetId }, 1);
            id = applies[0] && applies[0].planId;
        }
        if (id) {
            const stored = await this.storedPlan(d, server.serverId, id);
            if (stored) return endReset.parsePlan(stored.planText);
        }
        const bytes = await readFileBytes(d, server.serverId, PATHS.plan);
        if (bytes && manifest && manifest.planSha256 === endReset.sha256(bytes)) return endReset.parsePlan(bytes);
        throw new Error(`No plan found for reset ${result.resetId}: no stored dry run, and ${PATHS.plan} does not match the manifest.`);
    },

    verifyAndReport: async function (ctx, result, planId) {
        const { d, doc, server, label, io } = ctx;
        const manifestPath = result.manifest || PATHS.manifest(result.resetId);
        const manifestText = await d.pterodactyl.getFileContents(server.serverId, manifestPath);
        const manifest = manifestText ? endReset.parseManifest(manifestText) : null;
        const plan = await this.loadPlan(ctx, result, manifest, planId);

        // The rebuilt inner gateways live in the running world until a save writes their chunks.
        const saveNote = [];
        if ((result.innerGateways || []).length) {
            const save = await runCommand(d, server.serverId, 'save-all flush', SAVE_WAIT_MS).catch(err => ({ state: err.message }));
            if (!save || save.state !== 'completed') saveNote.push(`save-all before the gateway check ended ${save ? save.state : 'with no doc'}.`);
        }
        const log = await io.readBinary(LOG_PATH);

        const report = await endResetVerify.verifyReset(io, { plan, result, manifest, logText: log ? log.toString('utf8') : '' });
        report.notes.push(...saveNote);
        await d.mongo.updateScheduleJob(doc._id, {
            verify: { ok: report.ok, checks: report.checks, notes: report.notes, at: new Date(d.now()) },
        });

        const t = result.totals || {};
        const warps = (result.warps || []).map(w => `- warp ${endReset.cleanName(w.name)}: ${w.action}${w.new ? ` to ${w.new.join(' ')}` : ''}`);
        await d.notify({
            color: report.ok ? COLORS.ok : COLORS.bad,
            title: `End reset verify ${report.ok ? 'passed' : 'FAILED'}`,
            description: `**${label}** reset \`${result.resetId}\`: kept ${t.kept ?? '?'}, moved ${t.moved ?? '?'}, wiped ${t.wiped ?? '?'}, ` +
                `${(result.affectedPlayers || []).length} players affected.\n${endResetVerify.verifyText(report)}` +
                `${warps.length ? `\nWarps (no owner, staff only):\n${warps.join('\n')}` : ''}` +
                `${report.ok ? '' : '\nMails are held. Insert a mail job when the reset is good, or a restore job.'}`,
        });
        return report;
    },

    /** One mail per affected player in result.json. A re-run skips players who have theirs. */
    sendMails: async function ({ d, doc, server, label }, result, dryRun) {
        const mails = endReset.buildMails(result.affectedPlayers, {
            resetId: result.resetId,
            serverId: server.serverId,
            serverLabel: server.name || server.tag,
            now: new Date(d.now()),
        });
        const file = { name: `end-reset-mails-${result.resetId}.txt`, text: endReset.mailsAsText(mails) || 'No affected players.' };

        if (dryRun) {
            sessionLogger.info('EndResetScheduler', `Mail dry run for ${result.resetId}:\n${file.text}`);
            await d.notify({
                color: COLORS.info,
                title: 'End reset mails (dry run)',
                description: `**${label}** reset \`${result.resetId}\`: ${mails.length} mails in the file. Nothing was sent.`,
                files: [file],
            });
            return { sent: 0, skipped: 0, failed: mails.filter(m => m.error).map(m => `${m.name || m.player}: ${m.error}`), mails };
        }

        let sent = 0;
        let skipped = 0;
        const failed = [];
        for (const m of mails) {
            if (!m.doc) { failed.push(`${m.name || m.player}: ${m.error}`); continue; }
            try {
                if (await d.mongo.findMailByMetaKey(m.doc.meta.key)) { skipped++; continue; }
                await d.mongo.insertMail(m.doc);
                sent++;
            } catch (err) {
                failed.push(`${m.name || m.player}: ${err.message}`);
            }
        }
        await d.mongo.updateScheduleJob(doc._id, { mails: { sent, skipped, failed, at: new Date(d.now()) } }).catch(() => {});
        await d.notify({
            color: failed.length ? COLORS.bad : COLORS.ok,
            title: 'End reset mails',
            description: `**${label}** reset \`${result.resetId}\`: ${sent} sent, ${skipped} sent before` +
                `${failed.length ? `, ${failed.length} failed:\n${failed.join('\n')}` : '.'}`,
            files: [file],
        });
        return { sent, skipped, failed, mails };
    },

    /** The result.json of this reset, or a reason why not. */
    appliedResult: async function (ctx) {
        const { job } = ctx;
        let result;
        try {
            result = await this.readResult(ctx, job.resetId);
        } catch (err) {
            return { error: err.message };
        }
        if (!result || result.resetId !== job.resetId || result.kind !== 'reset') {
            return { error: `No result of reset ${job.resetId}: neither ${PATHS.resultOf(job.resetId)} nor ${PATHS.result} holds it.` };
        }
        if (result.status !== 'applied') return { error: `Reset ${job.resetId} has status ${result.status}.` };
        return { result };
    },

    runVerify: async function (ctx) {
        const { d, doc, label } = ctx;
        await d.mongo.deactivateScheduleJob(doc._id);
        const { result, error } = await this.appliedResult(ctx);
        if (error) return this.fail(d, doc, label, error);
        try {
            const report = await this.verifyAndReport(ctx, result, null);
            return { ok: report.ok, report };
        } catch (err) {
            return this.fail(d, doc, label, `The verify step stopped: ${err.message}`);
        }
    },

    runMail: async function (ctx) {
        const { d, doc, job, label } = ctx;
        await d.mongo.deactivateScheduleJob(doc._id);
        const { result, error } = await this.appliedResult(ctx);
        if (error) return this.fail(d, doc, label, error);
        const mails = await this.sendMails(ctx, result, job.mailDryRun);
        return { ok: mails.failed.length === 0, mails };
    },
};
