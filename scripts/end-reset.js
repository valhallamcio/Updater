/*
 * Offline End reset tool. It reads a local copy of a server root and prints what the
 * end_reset job would post. It writes nothing: no Mongo, no panel, no files.
 *
 * Usage (from the repo root):
 *   node scripts/end-reset.js dry-run --dir test/fixtures/end-reset [--server-name "Evolution #3"]
 *       The plan summary and the mails from the plan's affected-player list.
 *   node scripts/end-reset.js verify --dir test/fixtures/end-reset [--log <boot log>]
 *       The verify checks on the world files, result.json and the manifest under --dir.
 *   node scripts/end-reset.js mails --dir test/fixtures/end-reset [--server-name <name>]
 *       The mails from result.json, as the mail step would send them.
 *
 * plan.json and result.json come from config/biforesting/end-reset/ under --dir, else from
 * --dir itself. The log comes from --log, else logs/latest.log, else boot-log.txt.
 */

const fs = require('fs');
const path = require('path');
const endReset = require('../modules/endReset');
const endResetVerify = require('../modules/endResetVerify');

function parseArgs(argv) {
    const args = { command: argv[0] };
    for (let i = 1; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (flag === '--dir') { args.dir = value; i++; }
        else if (flag === '--log') { args.log = value; i++; }
        else if (flag === '--server-name') { args.serverName = value; i++; }
        else throw new Error(`Unknown argument: ${flag}`);
    }
    if (!['dry-run', 'verify', 'mails'].includes(args.command)) throw new Error('Give a command: dry-run, verify or mails.');
    if (!args.dir) throw new Error('Give --dir.');
    return args;
}

function jobFile(dir, name) {
    for (const p of [path.join(dir, endReset.PATHS.dir, name), path.join(dir, name)]) {
        if (fs.existsSync(p)) return fs.readFileSync(p);
    }
    throw new Error(`No ${name} under ${dir}.`);
}

function logText(dir, log) {
    for (const p of [log, path.join(dir, 'logs/latest.log'), path.join(dir, 'boot-log.txt')]) {
        if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    return '';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.command === 'dry-run') {
        const bytes = jobFile(args.dir, 'plan.json');
        const plan = endReset.parsePlan(bytes);
        const serverLabel = args.serverName || plan.serverId;
        console.log('== Plan summary ==');
        console.log(endReset.summarizePlan(plan, { serverLabel, planSha256: endReset.sha256(bytes) }));
        const mails = endReset.buildMails(plan.affectedPlayers, { resetId: 'DRYRUN', serverId: plan.serverId, serverLabel: args.serverName });
        console.log(`\n== Mails (${mails.length}) ==`);
        console.log(endReset.mailsAsText(mails) || 'No affected players.');
        return 0;
    }

    const result = endReset.parseResult(jobFile(args.dir, 'result.json'));

    if (args.command === 'mails') {
        const mails = endReset.buildMails(result.affectedPlayers, { resetId: result.resetId, serverLabel: args.serverName });
        console.log(`== Mails for ${result.resetId} (${mails.length}) ==`);
        console.log(endReset.mailsAsText(mails) || 'No affected players.');
        return 0;
    }

    const plan = endReset.parsePlan(jobFile(args.dir, 'plan.json'));
    const io = endResetVerify.localIo(args.dir);
    const manifestText = await io.readText(result.manifest || endReset.PATHS.manifest(result.resetId));
    const manifest = manifestText ? endReset.parseManifest(manifestText) : null;
    const report = await endResetVerify.verifyReset(io, { plan, result, manifest, logText: logText(args.dir, args.log) });
    console.log(`== Verify ${result.resetId}: ${report.ok ? 'PASS' : 'FAIL'} ==`);
    console.log(endResetVerify.verifyText(report));
    return report.ok ? 0 : 1;
}

main().then(code => process.exit(code), err => {
    console.error(err.message);
    process.exit(2);
});
