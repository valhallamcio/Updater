/*
 * Builds the `chapters` of a quest event from the BetterQuesting quest lines, and sets
 * them on the bifrost.quest_events doc. schedulers/questEventReader.js counts each week's
 * completions per chapter, and the weekly trophy shows the top chapter's icon.
 *
 * A chapter's index is the quest line's place in the quest book (`order:3`), so a lower
 * index is an earlier chapter. A file without a full set of orders uses the file order.
 * A quest in several lines counts for the lowest index only (the reader applies that rule).
 * The name comes from the lang file. A name with no lang entry stays as BQ wrote it.
 *
 * Usage (from the repo root):
 *   node scripts/seed-quest-event-chapters.js <eventId> <QuestDatabase.json> <en_us.lang>           # print, touch nothing
 *   node scripts/seed-quest-event-chapters.js <eventId> <QuestDatabase.json> <en_us.lang> --write   # set event.chapters
 */

const fs = require('fs');

/** The values of an NBT-JSON list or compound, in either of its two forms. */
function entries(node) {
    if (Array.isArray(node)) return node;
    if (node && typeof node === 'object') return Object.values(node);
    return [];
}

/** The `key=value` lines of a Minecraft .lang file. Comments and blank lines are skipped. */
function parseLang(text) {
    const lang = new Map();
    for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq > 0) lang.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return lang;
}

/**
 * The chapters of a QuestDatabase.json, in the shape the event doc keeps.
 * @param {string|object} database The file text, or the parsed JSON.
 * @param {Map<string, string>} [lang] Lang keys to text, from `parseLang`.
 * @returns {{index: number, name: string, icon: {id: string, meta: number}|null, quests: number[]}[]} By index.
 */
function parseChapters(database, lang = new Map()) {
    const root = typeof database === 'string' ? JSON.parse(database) : database;
    if (!root || typeof root !== 'object' || !('questLines:9' in root)) {
        throw new Error('No questLines:9 key. This is not a BetterQuesting 1.12.2 QuestDatabase.json');
    }
    const lines = entries(root['questLines:9']);
    const orders = lines.map(line => line && line['order:3']);
    const byOrder = orders.every(order => Number.isInteger(order) && order >= 0) && new Set(orders).size === orders.length;

    const chapters = lines.map((line, position) => {
        const props = ((line || {})['properties:10'] || {})['betterquesting:10'] || {};
        const nameKey = String(props['name:8'] || '');
        const icon = props['icon:10'] || {};
        const quests = entries((line || {})['quests:9']).map(quest => Number(quest && quest['id:3'])).filter(Number.isInteger);
        return {
            index: byOrder ? orders[position] : position,
            name: lang.has(nameKey) ? lang.get(nameKey) : nameKey,
            icon: typeof icon['id:8'] === 'string' && icon['id:8'] ? { id: icon['id:8'], meta: Number(icon['Damage:2']) || 0 } : null,
            quests: [...new Set(quests)]
        };
    });
    return chapters.sort((a, b) => a.index - b.index);
}

/** One line per chapter, then the totals. */
function summary(chapters) {
    const seen = new Map();
    for (const chapter of chapters) {
        for (const questId of chapter.quests) seen.set(questId, (seen.get(questId) || 0) + 1);
    }
    const shared = [...seen.values()].filter(n => n > 1).length;
    const rows = chapters.map(c => `${String(c.index).padStart(3)}  ${c.name}  [${c.icon ? `${c.icon.id}:${c.icon.meta}` : 'no icon'}]  ${c.quests.length} quests`);
    rows.push(`${chapters.length} chapters, ${seen.size} quests, ${shared} in more than one chapter`);
    return rows.join('\n');
}

async function main() {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const [eventId, databasePath, langPath] = args.filter(arg => arg !== '--write');
    if (!eventId || !databasePath || !langPath) {
        throw new Error('Usage: node scripts/seed-quest-event-chapters.js <eventId> <QuestDatabase.json> <en_us.lang> [--write]');
    }

    const chapters = parseChapters(fs.readFileSync(databasePath, 'utf8'), parseLang(fs.readFileSync(langPath, 'utf8')));
    console.log(summary(chapters));
    if (!write) {
        console.log(`Dry run: quest event ${eventId} is unchanged. Add --write to set its chapters.`);
        return;
    }

    const mongo = require('../modules/mongo');
    const db = await mongo.getBifrostDb();
    try {
        const result = await db.collection('quest_events').updateOne(
            { _id: eventId },
            { $set: { chapters, updatedAt: new Date() } }
        );
        console.log(result.matchedCount
            ? `Set ${chapters.length} chapters on quest event ${eventId}`
            : `No quest event ${eventId}, nothing changed`);
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

module.exports = { parseLang, parseChapters };
