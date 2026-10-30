/*
 * Dry run of the quiet slot plan (modules/quietSlots). It prints the stop slot each server would
 * get today, and why, or why it keeps the fixed batch. It writes nothing: no Mongo, no panel.
 *
 * Usage (from the repo root):
 *   node scripts/quiet-slots.js [--prom http://127.0.0.1:9090 | --prom-file <query_range JSON>]
 *       [--servers <servers JSON>] [--window 09:00-11:00] [--min-days 7] [--gap 45] [--days 14]
 *
 * Defaults come from config.json scheduler.rebootScheduler.quietSlots. --prom-file takes the body
 * of a Prometheus /api/v1/query_range answer for the configured query. Without --servers the
 * server list comes from the Yggdrasil API. A servers file is a JSON array of {serverId, tag, name}.
 * The daily batch's tag exclusions apply in both cases.
 */

const fs = require('fs');
const quietSlots = require('../modules/quietSlots');
const sessionLogger = require('../modules/sessionLogger');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (flag === '--prom') { args.prom = value; i++; }
        else if (flag === '--prom-file') { args.promFile = value; i++; }
        else if (flag === '--servers') { args.servers = value; i++; }
        else if (flag === '--window') { args.window = value; i++; }
        else if (flag === '--min-days') { args.minDays = Number(value); i++; }
        else if (flag === '--gap') { args.gap = Number(value); i++; }
        else if (flag === '--days') { args.days = Number(value); i++; }
        else throw new Error(`Unknown argument: ${flag}`);
    }
    return args;
}

function configured() {
    try {
        const cfg = require('../config/config.json');
        return (cfg.scheduler && cfg.scheduler.rebootScheduler && cfg.scheduler.rebootScheduler.quietSlots) || {};
    } catch (_) {
        return {};
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const raw = { ...configured() };
    if (args.prom) raw.prometheusUrl = args.prom;
    if (args.window) raw.window = args.window;
    if (Number.isFinite(args.minDays)) raw.minDays = args.minDays;
    if (Number.isFinite(args.gap)) raw.siblingGapMinutes = args.gap;
    if (Number.isFinite(args.days)) raw.lookbackDays = args.days;
    const cfg = quietSlots.config(raw);

    // shouldRebootServer and the Yggdrasil client log through sessionLogger; keep stdout to the plan.
    sessionLogger.info = () => {};
    sessionLogger.debug = () => {};
    const rebootScheduler = require('../schedulers/rebootScheduler');

    let servers;
    if (args.servers) {
        servers = JSON.parse(fs.readFileSync(args.servers, 'utf8'));
    } else {
        servers = await require('../modules/yggdrasil').getServers();
    }
    servers = servers.filter(s => s && s.serverId && rebootScheduler.shouldRebootServer(s));

    let history = null;
    let error = null;
    try {
        if (args.promFile) {
            const body = JSON.parse(fs.readFileSync(args.promFile, 'utf8'));
            if (!body || body.status !== 'success') throw new Error('the file is not a successful query_range answer');
            history = body.data.result;
        } else {
            history = await quietSlots.fetchHistory(cfg);
        }
    } catch (e) {
        error = e.message;
    }
    console.log(quietSlots.format(quietSlots.plan(servers, history, cfg, error), cfg));
}

main().then(() => process.exit(0), error => {
    console.error(error.message);
    process.exit(1);
});
