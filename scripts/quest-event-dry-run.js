/*
 * Dry run of the quest event count. It reads one QuestProgress.json and prints what
 * schedulers/questEventReader.js would count. It writes nothing: no Mongo writes, no
 * ops, no files.
 *
 * Usage (from the repo root):
 *   node scripts/quest-event-dry-run.js --server 3f89e24a --start 2026-09-30T00:00:00Z \
 *       [--end <ISO>] [--final 809] [--min-quests 25] [--window-days 14] \
 *       [--uuid <uuid> ...] [--names]
 *   node scripts/quest-event-dry-run.js --file <local QuestProgress.json> ...
 *
 * --server downloads through a signed panel URL, the same path the scheduler uses.
 * --names reads usernames from bifrost.players (a read, never a write).
 */

const fs = require('fs');
const questProgress = require('../modules/questProgress');

const DAY_MS = 24 * 3600 * 1000;

function parseArgs(argv) {
    const args = { uuids: [] };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (flag === '--server') { args.server = value; i++; }
        else if (flag === '--file') { args.file = value; i++; }
        else if (flag === '--start') { args.start = value; i++; }
        else if (flag === '--end') { args.end = value; i++; }
        else if (flag === '--final') { args.final = Number(value); i++; }
        else if (flag === '--min-quests') { args.minQuests = Number(value); i++; }
        else if (flag === '--window-days') { args.windowDays = Number(value); i++; }
        else if (flag === '--uuid') { args.uuids.push(questProgress.normalizeUuid(value)); i++; }
        else if (flag === '--names') { args.names = true; }
        else throw new Error(`Unknown argument: ${flag}`);
    }
    if (!args.server === !args.file) throw new Error('Give exactly one of --server or --file');
    return args;
}

/**
 * Completions that share a quest and an exact timestamp with another uuid. BQ party
 * sharing would write one completion per member at one time, so this shows how often
 * that happens in the file.
 */
function sharedCompletions(quests) {
    let groups = 0;
    let completions = 0;
    for (const quest of quests) {
        const byTime = new Map();
        for (const { at } of quest.completions) byTime.set(at, (byTime.get(at) || 0) + 1);
        for (const n of byTime.values()) {
            if (n > 1) {
                groups++;
                completions += n;
            }
        }
    }
    return { groups, completions };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const reader = require('../schedulers/questEventReader');

    let text;
    let source;
    if (args.server) {
        const stat = await reader.statProgressFile(args.server, reader.PROGRESS_PATH);
        if (!stat) throw new Error(`${reader.PROGRESS_PATH} not found on ${args.server}`);
        text = await reader.downloadProgressFile(args.server, reader.PROGRESS_PATH);
        source = { serverId: args.server, size: stat.size, mtime: stat.mtime, downloadedBytes: Buffer.byteLength(text) };
    } else {
        text = fs.readFileSync(args.file, 'utf8');
        source = { file: args.file, size: Buffer.byteLength(text) };
    }

    const { quests, skipped } = questProgress.parseQuestProgress(text);
    const finalQuestId = Number.isInteger(args.final) ? args.final : 809;
    const finished = questProgress.finishers(quests, finalQuestId);
    const report = {
        source,
        quests: quests.length,
        skippedEntries: skipped,
        completionsAllTime: quests.reduce((sum, q) => sum + q.completions.length, 0),
        sharedTimestamps: sharedCompletions(quests),
        finalQuest: { id: finalQuestId, finishers: finished.map(f => ({ uuid: f.uuid, at: new Date(f.at).toISOString() })) }
    };

    if (args.start) {
        const event = {
            _id: 'dry-run',
            startAt: new Date(args.start),
            endAt: args.end ? new Date(args.end) : null,
            weekMs: 7 * DAY_MS,
            weekCount: 8,
            excluded: [],
            founder: { minQuests: args.minQuests || 25, windowMs: (args.windowDays || 14) * DAY_MS }
        };
        const counts = questProgress.countEvent(quests, event);
        const docs = [...counts.players.values()].map(p => ({ ...p, founderNo: null }));
        report.event = {
            startAt: new Date(counts.schedule.startAt).toISOString(),
            endAt: new Date(counts.schedule.endAt).toISOString(),
            completions: counts.quests,
            players: counts.players.size,
            weekCounts: counts.weekCounts,
            founderOrder: questProgress.founderCandidates(docs, event, counts.schedule)
                .map(p => ({ uuid: p.uuid, total: p.total, reachedAt: new Date(p.founderAt).toISOString() })),
            top: [...counts.players.values()].sort((a, b) => b.total - a.total).slice(0, 15)
                .map(p => ({ uuid: p.uuid, total: p.total, weeks: p.weeks, firstAt: new Date(p.firstAt).toISOString() }))
        };
        report.uuids = Object.fromEntries(args.uuids.map(uuid => {
            const p = counts.players.get(uuid);
            return [uuid, p ? { total: p.total, weeks: p.weeks } : { total: 0 }];
        }));
    }

    if (args.names) {
        const mongo = require('../modules/mongo');
        const uuids = new Set(finished.map(f => f.uuid));
        for (const p of (report.event ? report.event.top : [])) uuids.add(p.uuid);
        for (const uuid of args.uuids) uuids.add(uuid);
        const names = await mongo.getBifrostUsernames([...uuids]);
        report.names = Object.fromEntries(names);
        await (await mongo.getClient()).close();
    }

    console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0), error => {
    console.error(error.message);
    process.exit(1);
});
