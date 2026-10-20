/*
 * Unit tests for schedulers/endResetScheduler.js. Mongo, Yggdrasil, the panel, HTTP and the
 * staff channel are fakes passed in as deps; the panel fake serves test/fixtures/end-reset
 * and keeps writes in memory. Nothing here reaches a live service. Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const scheduler = require('../schedulers/endResetScheduler');
const endReset = require('../modules/endReset');

const FIXTURE = path.join(__dirname, 'fixtures/end-reset');
const JOB_DIR = 'config/biforesting/end-reset/';
const PLAN_ID = '01JBX5P9N2C4D6F8G0H1J3K5MB';
const RESET_ID = '01JBX6Z2M4K8Q0R1S3T5V7W9YA';
const PLAN_BYTES = fs.readFileSync(path.join(FIXTURE, 'plan.json'));
const PLAN_SHA = endReset.sha256(PLAN_BYTES);
const RESULT = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'result.json'), 'utf8'));
const SERVERS = [
    { tag: 'evol', name: 'Evolution', serverId: 'e7575fc9' },
    { tag: 'evol', name: 'Evolution #3', serverId: 'e2f5e517' },
];
const FIRE_AT = Date.parse('2026-10-21T04:00:00Z');

/** Server-root path to fixture file: the job dir and the log map onto the fixture root. */
function fixturePath(p) {
    if (p === 'logs/latest.log') return path.join(FIXTURE, 'boot-log.txt');
    return path.join(FIXTURE, p.startsWith(JOB_DIR) ? p.slice(JOB_DIR.length) : p);
}

function rig({ overlay = {}, jobs = [], reboots = [], mailKeys = [], op, disk, now = Date.parse('2026-10-21T03:40:00Z'), createFails = false } = {}) {
    const files = new Map(Object.entries(overlay));
    const state = { now, writes: [], deletes: [], ops: [], notices: [], updates: [], deactivated: [], created: [], mails: [], reads: [] };
    const local = p => {
        if (files.has(p)) return files.get(p);
        const full = fixturePath(p);
        return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full) : null;
    };
    const byId = id => jobs.find(j => j._id === id);
    state.files = files;
    state.deps = {
        now: () => state.now,
        newId: () => RESET_ID,
        notify: async msg => { state.notices.push(msg); },
        http: { get: async url => ({ data: local(url.slice('fixture:'.length)) }) },
        yggdrasil: {
            getServers: async () => SERVERS,
            runOp: async (server, o, timeout) => {
                state.ops.push({ server, op: o, timeout });
                return op || { _id: 'op-1', state: 'completed', result: { data: { planId: PLAN_ID, sha256: PLAN_SHA } } };
            },
        },
        pterodactyl: {
            getFileContents: async (id, p) => { state.reads.push(p); return local(p); },
            writeFile: async (id, p, text) => { state.writes.push({ id, path: p, text }); files.set(p, Buffer.from(text)); },
            deleteFile: async (id, list, root) => {
                state.deletes.push({ id, list, root });
                for (const n of list) files.set(`${root.replace(/^\//, '')}/${n}`, null);
                return true;
            },
            getDownloadLink: async (id, p) => (local(p) ? `fixture:${p}` : undefined),
            listFiles: async (id, dir) => {
                const full = fixturePath(dir);
                if (!fs.existsSync(full)) return [];
                return fs.readdirSync(full).map(name => {
                    const st = fs.statSync(path.join(full, name));
                    return { name, size: st.size, is_file: st.isFile(), modified_at: st.mtime.toISOString() };
                });
            },
            getDiskSpace: async () => disk || { limitBytes: 100 * 1024 ** 3, usedBytes: 10 * 1024 ** 3 },
        },
        mongo: {
            getActiveScheduleJobs: async type => (type === 'scheduled_reboot' ? reboots : jobs.filter(j => j.type === type && j.active !== false)),
            findScheduleJobs: async filter => jobs.filter(j => Object.entries(filter).every(([k, v]) => j[k] === v)),
            updateScheduleJob: async (id, set) => { state.updates.push({ id, set }); if (byId(id)) Object.assign(byId(id), set); },
            deactivateScheduleJob: async id => { state.deactivated.push(id); if (byId(id)) byId(id).active = false; },
            createScheduleJob: async data => {
                if (createFails) throw new Error('mongo is down');
                state.created.push(data);
                return { insertedId: 'reboot-1' };
            },
            findMailByMetaKey: async key => (mailKeys.includes(key) || state.mails.some(m => m.meta.key === key) ? { _id: 'm' } : null),
            insertMail: async doc => { state.mails.push(doc); return { insertedId: 'm' }; },
        },
    };
    return state;
}

const storedPlan = (extra = {}) => ({
    _id: 'plan-1', type: 'end_reset', action: 'plan', instanceServerId: 'e2f5e517', active: false,
    planId: PLAN_ID, planSha256: PLAN_SHA, planText: PLAN_BYTES.toString('utf8'), ...extra,
});
const applyJob = (extra = {}) => ({
    _id: 'apply-1', type: 'end_reset', action: 'apply', instanceServerId: 'e2f5e517', serverTag: 'evol',
    planId: PLAN_ID, fireAt: FIRE_AT, requestedBy: 'alp', active: true, ...extra,
});
const titles = state => state.notices.map(n => n.title);
const hide = { [`${JOB_DIR}result.json`]: null };

// ── plan ────────────────────────────────────────────────────────────────────

test('plan: runs the link op on the instance, stores the plan and posts the summary with the mails', async () => {
    const job = { _id: 'plan-1', type: 'end_reset', action: 'plan', instanceServerId: 'e2f5e517', active: true };
    const state = rig({ jobs: [job] });
    const out = await scheduler.runJob(job, state.deps);

    assert.strictEqual(out.ok, true);
    assert.strictEqual(state.ops.length, 1);
    assert.strictEqual(state.ops[0].server, 'e2f5e517');
    assert.strictEqual(state.ops[0].op.type, 'end_reset_plan');
    assert.deepStrictEqual(state.deactivated, ['plan-1']);
    assert.strictEqual(job.planId, PLAN_ID);
    assert.strictEqual(job.planSha256, PLAN_SHA);
    assert.strictEqual(job.planText, PLAN_BYTES.toString('utf8'));
    assert.strictEqual(job.mailPreview.length, 4);
    assert.deepStrictEqual(state.writes, []);
    assert.deepStrictEqual(state.created, []);

    assert.deepStrictEqual(titles(state), ['End reset dry run']);
    const notice = state.notices[0];
    assert.match(notice.description, /Chunks: kept 2, moved 2, wiped 1534/);
    assert.match(notice.description, /Affected players \(4\): StretchyBacon/);
    assert.match(notice.description, /planId: '01JBX5P9N2C4D6F8G0H1J3K5MB'/);
    assert.strictEqual(notice.files.length, 1);
    assert.match(notice.files[0].text, /To StretchyBacon/);
    assert.match(notice.files[0].text, /You logged out in a moved claim/);
});

test('plan: a sha256 that differs from the op stops the dry run', async () => {
    const job = { _id: 'plan-1', type: 'end_reset', action: 'plan', instanceServerId: 'e2f5e517', active: true };
    const state = rig({ jobs: [job], op: { state: 'completed', result: { data: { planId: PLAN_ID, sha256: 'b'.repeat(64) } } } });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /changed after the op/);
    assert.strictEqual(job.planSha256, undefined);
    assert.deepStrictEqual(titles(state), ['End reset plan stopped']);
});

test('plan: a failed op stops the dry run', async () => {
    const job = { _id: 'plan-1', type: 'end_reset', action: 'plan', instanceServerId: 'e2f5e517', active: true };
    const state = rig({ jobs: [job], op: { state: 'failed', result: { error: 'unknown op type end_reset_plan' } } });
    const out = await scheduler.runJob(job, state.deps);
    assert.match(out.error, /ended failed: unknown op type/);
});

test('a job with a bare tag is refused before any panel call', async () => {
    const job = { _id: 'bad-1', type: 'end_reset', action: 'plan', instanceServerId: 'evol', active: true };
    const state = rig({ jobs: [job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /instanceServerId/);
    assert.deepStrictEqual(state.deactivated, ['bad-1']);
    assert.deepStrictEqual(state.reads, []);
    assert.deepStrictEqual(state.ops, []);
});

// ── apply ───────────────────────────────────────────────────────────────────

test('apply: writes request.json once, then one scheduled_reboot with instanceServerId', async () => {
    const job = applyJob();
    const state = rig({ jobs: [storedPlan(), job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, true, out.error);

    assert.strictEqual(state.writes.length, 1);
    assert.strictEqual(state.writes[0].id, 'e2f5e517');
    assert.strictEqual(state.writes[0].path, 'config/biforesting/end-reset/request.json');
    assert.deepStrictEqual(JSON.parse(state.writes[0].text), {
        schema: 1,
        resetId: RESET_ID,
        planId: PLAN_ID,
        planSha256: PLAN_SHA,
        notBefore: '2026-10-21T03:55:00Z',
        notAfter: '2026-10-21T05:00:00Z',
        requestedBy: 'alp',
        ignoreUnsupported: false,
    });

    assert.strictEqual(state.created.length, 1);
    const reboot = state.created[0];
    assert.strictEqual(reboot.type, 'scheduled_reboot');
    assert.strictEqual(reboot.instanceServerId, 'e2f5e517');
    assert.strictEqual(reboot.serverId, 'e2f5e517');
    assert.strictEqual(reboot.serverTag, 'evol');
    assert.strictEqual(reboot.fireAt, FIRE_AT);
    assert.strictEqual(reboot.warnWindow, 15);
    assert.strictEqual(reboot.reason, `End reset ${RESET_ID}`);

    assert.deepStrictEqual(state.updates.map(u => u.set.phase).filter(Boolean), ['requesting', 'awaiting_result']);
    assert.strictEqual(job.active, true);
    assert.strictEqual(job.resetId, RESET_ID);
    assert.deepStrictEqual(titles(state), ['End reset scheduled']);
    assert.match(state.notices[0].description, /<t:1792555200:R>/);
});

test('apply: a fireAt in the past becomes now plus the warning window', async () => {
    const job = applyJob({ fireAt: Date.parse('2026-10-20T00:00:00Z'), warnWindow: 10 });
    const state = rig({ jobs: [storedPlan(), job] });
    await scheduler.runJob(job, state.deps);
    assert.strictEqual(state.created[0].fireAt, state.now + 10 * 60000);
    assert.strictEqual(state.created[0].warnWindow, 10);
});

test('apply: the whole run, from request to verify to mails', async () => {
    const job = applyJob();
    const state = rig({ jobs: [storedPlan(), job], overlay: hide });
    assert.strictEqual((await scheduler.runJob(job, state.deps)).ok, true);

    // Before the reboot the job does not look for a result.
    state.reads.length = 0;
    assert.deepStrictEqual(await scheduler.runJob(job, state.deps), { ok: true, waiting: 'reboot' });
    assert.deepStrictEqual(state.reads, []);

    // After the reboot, no result yet.
    state.now = Date.parse('2026-10-21T04:03:00Z');
    assert.deepStrictEqual(await scheduler.runJob(job, state.deps), { ok: true, waiting: 'result' });

    // The mod wrote result.json.
    state.files.delete(`${JOB_DIR}result.json`);
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, true, JSON.stringify(out.report && out.report.checks));
    assert.strictEqual(out.report.ok, true);
    assert.strictEqual(job.active, false);
    assert.strictEqual(job.phase, 'done');
    assert.strictEqual(state.mails.length, 4);
    assert.deepStrictEqual(state.mails.map(m => m.toName), ['StretchyBacon', 'CoolBreeze02050', 'Nullifiedlife67', 'Kestrel_9']);
    assert.ok(state.mails.every(m => m.meta.resetId === RESET_ID && m.body.length <= 500));
    assert.deepStrictEqual(titles(state), ['End reset scheduled', 'End reset verify passed', 'End reset mails']);
    assert.match(state.notices[1].description, /PASS kept chunks/);
    assert.match(state.notices[1].description, /warp end: remove/);
    assert.match(state.notices[2].description, /4 sent, 0 sent before\./);
});

test('apply: a failed verify holds the mails', async () => {
    const job = applyJob({ phase: 'awaiting_result', resetId: RESET_ID, notBefore: FIRE_AT - 300000, notAfter: FIRE_AT + 3600000 });
    const log = fs.readFileSync(path.join(FIXTURE, 'boot-log.txt'), 'utf8') +
        '[21Oct2026 05:10:00.000] [Server thread/INFO] [minecraft/EnderDragonFight]: Found that the dragon has been killed in this world already.\n';
    const state = rig({ jobs: [storedPlan(), job], overlay: { 'logs/latest.log': Buffer.from(log) }, now: FIRE_AT + 600000 });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.report.ok, false);
    assert.deepStrictEqual(state.mails, []);
    assert.deepStrictEqual(titles(state), ['End reset verify FAILED']);
    assert.match(state.notices[0].description, /FAIL log/);
    assert.match(state.notices[0].description, /Mails are held/);
});

test('apply: an aborted reset reports the reason and sends no mails', async () => {
    const job = applyJob({ phase: 'awaiting_result', resetId: RESET_ID, notBefore: FIRE_AT - 300000, notAfter: FIRE_AT + 3600000 });
    const aborted = { ...RESULT, status: 'aborted', reason: 'claims differ from the plan' };
    const state = rig({ jobs: [storedPlan(), job], overlay: { [`${JOB_DIR}result.json`]: Buffer.from(JSON.stringify(aborted)) }, now: FIRE_AT + 600000 });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(titles(state), ['End reset aborted']);
    assert.match(state.notices[0].description, /claims differ from the plan/);
    assert.deepStrictEqual(state.mails, []);
    assert.strictEqual(job.active, false);
});

test('apply: no result long after the window stops the job', async () => {
    const job = applyJob({ phase: 'awaiting_result', resetId: RESET_ID, notBefore: FIRE_AT - 300000, notAfter: FIRE_AT + 3600000 });
    const state = rig({ jobs: [storedPlan(), job], overlay: hide, now: FIRE_AT + 3600000 + 30 * 60000 + 1 });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /No reset result for 01JBX6Z2M4K8Q0R1S3T5V7W9YA/);
    assert.strictEqual(job.active, false);
});

test('apply: an interrupted request is not written again', async () => {
    const job = applyJob({ phase: 'requesting', resetId: RESET_ID });
    const state = rig({ jobs: [storedPlan(), job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.match(out.error, /stopped while it wrote the request/);
    assert.deepStrictEqual(state.writes, []);
    assert.deepStrictEqual(state.created, []);
});

test('apply refusals write nothing and schedule nothing', async () => {
    const unsupported = Buffer.from(JSON.stringify({ ...JSON.parse(PLAN_BYTES), unsupported: [{ mod: 'somehomes', reason: 'no rule' }] }));
    const cases = [
        { name: 'no dry run', jobs: [applyJob()], error: /No stored dry run for plan/ },
        { name: 'plan changed', jobs: [storedPlan({ planSha256: 'c'.repeat(64) }), applyJob()], error: /not the plan staff accepted/ },
        { name: 'request waits', jobs: [storedPlan(), applyJob()], overlay: { [`${JOB_DIR}request.json`]: Buffer.from('{}') }, error: /request\.json already waits/ },
        { name: 'restore waits', jobs: [storedPlan(), applyJob()], overlay: { [`${JOB_DIR}restore.json`]: Buffer.from('{}') }, error: /restore\.json already waits/ },
        { name: 'reboot pending', jobs: [storedPlan(), applyJob()], reboots: [{ type: 'scheduled_reboot', instanceServerId: 'e2f5e517', fireAt: FIRE_AT }], error: /already scheduled/ },
        { name: 'tag reboot pending', jobs: [storedPlan(), applyJob()], reboots: [{ type: 'scheduled_reboot', serverTag: 'evol', instanceServerId: null, fireAt: FIRE_AT }], error: /already scheduled/ },
        {
            name: 'unsupported mods', error: /unsupported mods: somehomes/,
            jobs: [storedPlan({ planSha256: endReset.sha256(unsupported), planText: unsupported.toString() }), applyJob()],
            overlay: { [`${JOB_DIR}plan.json`]: unsupported },
        },
        { name: 'small disk', jobs: [storedPlan(), applyJob()], disk: { limitBytes: 2 * 1024 ** 3, usedBytes: 1.5 * 1024 ** 3 }, error: /less than twice/ },
    ];
    for (const c of cases) {
        const job = c.jobs[c.jobs.length - 1];
        const state = rig(c);
        const out = await scheduler.runJob(job, state.deps);
        assert.strictEqual(out.ok, false, c.name);
        assert.match(out.error, c.error, c.name);
        assert.deepStrictEqual(state.writes, [], c.name);
        assert.deepStrictEqual(state.created, [], c.name);
        assert.strictEqual(job.active, false, c.name);
    }
});

test('apply: unsupported mods pass with ignoreUnsupported', async () => {
    const unsupported = Buffer.from(JSON.stringify({ ...JSON.parse(PLAN_BYTES), unsupported: [{ mod: 'somehomes', reason: 'no rule' }] }));
    const job = applyJob({ ignoreUnsupported: true });
    const state = rig({ jobs: [storedPlan({ planSha256: endReset.sha256(unsupported), planText: unsupported.toString() }), job], overlay: { [`${JOB_DIR}plan.json`]: unsupported } });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(JSON.parse(state.writes[0].text).ignoreUnsupported, true);
});

test('apply: when the reboot insert fails, request.json is removed again', async () => {
    const job = applyJob();
    const state = rig({ jobs: [storedPlan(), job], createFails: true });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /Could not schedule the reboot: mongo is down/);
    assert.deepStrictEqual(state.deletes, [{ id: 'e2f5e517', list: ['request.json'], root: '/config/biforesting/end-reset' }]);
    assert.strictEqual(job.active, false);
});

// ── verify, mail, restore ───────────────────────────────────────────────────

test('verify: runs again on the stored plan of the apply job', async () => {
    const apply = applyJob({ active: false, phase: 'done', resetId: RESET_ID });
    const job = { _id: 'verify-1', type: 'end_reset', action: 'verify', instanceServerId: 'e2f5e517', resetId: RESET_ID, active: true };
    const state = rig({ jobs: [storedPlan(), apply, job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(titles(state), ['End reset verify passed']);
    assert.deepStrictEqual(state.mails, []);
});

test('verify: without a stored plan it uses plan.json when the manifest sha matches', async () => {
    const job = { _id: 'verify-1', type: 'end_reset', action: 'verify', instanceServerId: 'e2f5e517', resetId: RESET_ID, active: true };
    const state = rig({ jobs: [job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, true);
});

test('verify: a result of another reset is refused', async () => {
    const job = { _id: 'verify-1', type: 'end_reset', action: 'verify', instanceServerId: 'e2f5e517', resetId: '01JBX7AAAAAAAAAAAAAAAAAAAA', active: true };
    const state = rig({ jobs: [job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.match(out.error, /not the result of reset 01JBX7AAAAAAAAAAAAAAAAAAAA/);
});

test('mail: mailDryRun posts the mails and sends none', async () => {
    const job = { _id: 'mail-1', type: 'end_reset', action: 'mail', instanceServerId: 'e2f5e517', resetId: RESET_ID, mailDryRun: true, active: true };
    const state = rig({ jobs: [job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(state.mails, []);
    assert.deepStrictEqual(titles(state), ['End reset mails (dry run)']);
    assert.match(state.notices[0].files[0].text, /To CoolBreeze02050/);
    assert.match(state.notices[0].files[0].text, /Home "farm" at -30 64 40 was removed/);
});

test('mail: a re-run skips players who have their mail', async () => {
    const job = { _id: 'mail-1', type: 'end_reset', action: 'mail', instanceServerId: 'e2f5e517', resetId: RESET_ID, active: true };
    const key = endReset.mailKey(RESET_ID, 'a1b2c3d4-0000-4000-8000-000000000001');
    const state = rig({ jobs: [job], mailKeys: [key] });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.mails.sent, 3);
    assert.strictEqual(out.mails.skipped, 1);
    assert.ok(!state.mails.some(m => m.meta.key === key));
});

test('restore: without confirmLoss it warns and writes nothing', async () => {
    const job = { _id: 'restore-1', type: 'end_reset', action: 'restore', instanceServerId: 'e2f5e517', resetId: RESET_ID, active: true };
    const state = rig({ jobs: [job] });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.needsConfirm, true);
    assert.deepStrictEqual(state.writes, []);
    assert.deepStrictEqual(state.created, []);
    assert.deepStrictEqual(titles(state), ['End restore needs a confirm']);
    assert.match(state.notices[0].description, /puts back 5 files/);
    assert.match(state.notices[0].description, /progress made after the reset in these files is lost/);
});

test('restore: with confirmLoss it writes restore.json, reboots, and reports the result', async () => {
    const job = { _id: 'restore-1', type: 'end_reset', action: 'restore', instanceServerId: 'e2f5e517', resetId: RESET_ID, confirmLoss: true, fireAt: FIRE_AT, requestedBy: 'alp', active: true };
    const state = rig({ jobs: [job], overlay: hide });
    const out = await scheduler.runJob(job, state.deps);
    assert.strictEqual(out.ok, true, out.error);
    assert.strictEqual(state.writes.length, 1);
    assert.strictEqual(state.writes[0].path, 'config/biforesting/end-reset/restore.json');
    assert.deepStrictEqual(JSON.parse(state.writes[0].text), {
        schema: 1, resetId: RESET_ID, notBefore: '2026-10-21T03:55:00Z', notAfter: '2026-10-21T05:00:00Z', requestedBy: 'alp',
    });
    assert.strictEqual(state.created[0].instanceServerId, 'e2f5e517');
    assert.strictEqual(state.created[0].reason, `End reset restore ${RESET_ID}`);

    state.now = FIRE_AT + 300000;
    state.files.set(`${JOB_DIR}result.json`, Buffer.from(JSON.stringify({ ...RESULT, kind: 'restore', status: 'restored' })));
    const done = await scheduler.runJob(job, state.deps);
    assert.strictEqual(done.ok, true);
    assert.deepStrictEqual(titles(state), ['End restore scheduled', 'End restore restored']);
    assert.deepStrictEqual(state.mails, []);
});

test('tick runs each active end_reset job once', async () => {
    const plan = { _id: 'plan-1', type: 'end_reset', action: 'plan', instanceServerId: 'e2f5e517', active: true };
    const state = rig({ jobs: [plan, { _id: 'old', type: 'end_reset', action: 'plan', instanceServerId: 'e2f5e517', active: false }] });
    await scheduler.tick(state.deps);
    assert.strictEqual(state.ops.length, 1);
    assert.strictEqual(scheduler.running.size, 0);
});
