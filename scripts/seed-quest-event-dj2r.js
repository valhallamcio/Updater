/*
 * Seeds the DJ2 Season 2 quest event (bifrost.quest_events `dj2r-s2`).
 *
 * The insert runs only when no doc with that _id exists, so a second run changes
 * nothing. The doc starts with `serverId: null` and no dates: schedulers/questEventReader.js
 * counts nothing until staff set `serverId`, `startAt` and (optionally) `endAt`.
 * Finishers on the legacy server (dj2r, 3f89e24a) are read from the first hourly pass.
 *
 * Usage (from the repo root):
 *   node scripts/seed-quest-event-dj2r.js --print   # show the doc, touch nothing
 *   node scripts/seed-quest-event-dj2r.js           # insert it if it is missing
 */

const DAY_MS = 24 * 3600 * 1000;

function seedDoc(now = new Date()) {
    return {
        _id: 'dj2r-s2',
        title: 'DJ2 Season 2',
        tag: 'dj2r',
        serverId: null,
        legacyServerIds: ['3f89e24a'],
        startAt: null,
        endAt: null,
        weekMs: 7 * DAY_MS,
        // Used only while endAt is null: endAt = startAt + weekCount * weekMs.
        weekCount: 8,
        weeklyTargets: [300],
        weeklyMinContribution: 10,
        founder: {
            windowMs: 14 * DAY_MS,
            minQuests: 25,
            reward: {
                id: 'simple_trophies:trophy',
                meta: 0,
                count: 1,
                name: 'DJ2 Season 2 Founder #{n}',
                lore: ['One of the first players of DJ2 Season 2.'],
                trophy: {
                    variant: 'classic',
                    color: [255, 190, 0],
                    displayItem: { id: 'minecraft:nether_star', meta: 0 }
                }
            }
        },
        weeklyReward: {
            id: 'minecraft:skull',
            meta: 3,
            count: 1,
            skullOwner: 'AlpDerps',
            name: 'DJ2 Season 2 Week {week}',
            lore: ['The community met the week {week} quest goal.']
        },
        finalQuestId: 809,
        excluded: [],
        founderSeq: 0,
        totals: { quests: 0, players: 0, week: { index: 0, count: 0, target: 300 } },
        createdAt: now,
        updatedAt: now
    };
}

async function main() {
    const doc = seedDoc();
    if (process.argv.includes('--print')) {
        console.log(JSON.stringify(doc, null, 2));
        return;
    }

    const mongo = require('../modules/mongo');
    const db = await mongo.getBifrostDb();
    try {
        const result = await db.collection('quest_events').updateOne(
            { _id: doc._id },
            { $setOnInsert: doc },
            { upsert: true }
        );
        console.log(result.upsertedCount
            ? `Inserted quest event ${doc._id}`
            : `Quest event ${doc._id} already exists, nothing changed`);
    } finally {
        await (await mongo.getClient()).close();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { seedDoc };
