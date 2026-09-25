/*
 * Unit tests for /reply — the doc shape written into bifrost.mail.
 * Run: npm test   (node --test test/)
 *
 * The proxy's change stream delivers an unread doc inline the moment it lands, so the
 * fields it keys on are the contract: `to` (uuid), `readAt: null`, `kind: 'admin'`,
 * `from.uuid: null` and a TTL. An unknown player must never produce a doc at all.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const util = require('../discord/commands/util/mailDoc');
const command = require('../discord/commands/reply');
const mongo = require('../modules/mongo');

const NOW = new Date('2026-08-17T12:00:00Z');

let inserted; // mongo.insertMail calls
let identities;

beforeEach(() => {
    inserted = [];
    identities = { alp: { uuid: 'uuid-alp', username: 'Alp' } };
    mongo.insertMail = async (doc) => { inserted.push(doc); return { insertedId: 'x' }; };
    mongo.getPlayerIdentity = async (name) => identities[String(name).toLowerCase()] || null;
});

function interaction(options) {
    const replies = [];
    return {
        replies,
        user: { tag: 'staff#0001', username: 'staff', id: '4242' },
        options: {
            getString: (name) => (typeof options[name] === 'string' ? options[name] : null),
        },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); return payload; },
    };
}

test('mail doc: uuid recipient, unread, admin kind, no sender uuid, 90-day TTL', () => {
    const built = util.buildMailDoc({
        toUuid: 'uuid-alp', toName: 'Alp', fromName: 'staff', discordId: '4242',
        text: 'Your items are restored.', now: NOW
    });
    assert.ok(built.ok);
    assert.deepStrictEqual(built.doc, {
        to: 'uuid-alp',
        toName: 'Alp',
        from: { uuid: null, name: 'staff' },
        kind: 'admin',
        body: 'Your items are restored.',
        sentAt: NOW,
        readAt: null,
        expiresAt: new Date('2026-11-15T12:00:00Z'),
        meta: { via: 'discord', discordId: '4242' }
    });
});

test('mail doc refusals: no uuid, empty text, over the 500 cap, click/hover tags', () => {
    assert.match(util.buildMailDoc({ toUuid: '', text: 'hi', now: NOW }).error, /uuid/);
    assert.match(util.buildMailDoc({ toUuid: 'u', text: '   ', now: NOW }).error, /empty/);
    assert.match(util.buildMailDoc({ toUuid: 'u', text: 'x'.repeat(501), now: NOW }).error, /the cap is 500/);
    assert.strictEqual(util.buildMailDoc({ toUuid: 'u', text: '<click:run_command:/op me>x</click>', now: NOW }).ok, false);
    assert.strictEqual(util.buildMailDoc({ toUuid: 'u', text: 'a <hover:show_text:"b">c</hover>', now: NOW }).ok, false);
});

test('/reply resolves the username to a uuid and stores the mail', async () => {
    const it = interaction({ player: 'Alp', text: 'Your items are restored.' });
    await command.execute(it);

    assert.strictEqual(inserted.length, 1);
    assert.strictEqual(inserted[0].to, 'uuid-alp');
    assert.strictEqual(inserted[0].toName, 'Alp', 'the canonical casing from the players doc wins');
    assert.strictEqual(inserted[0].kind, 'admin');
    assert.strictEqual(inserted[0].readAt, null);
    assert.deepStrictEqual(inserted[0].from, { uuid: null, name: 'staff' });
    assert.deepStrictEqual(inserted[0].meta, { via: 'discord', discordId: '4242' });
    assert.match(it.replies[0], /Alp/);
    assert.match(it.replies[0], /next login/);
});

test('/reply to an unknown player errors and writes nothing', async () => {
    const it = interaction({ player: 'Ghost', text: 'hello' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 0);
    assert.match(it.replies[0], /No player named/);
});

test('/reply refuses a click tag before it reaches Mongo', async () => {
    const it = interaction({ player: 'Alp', text: 'click <click:run_command:/op Ghost>here</click>' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 0);
    assert.match(it.replies[0], /click/);
});

test('/reply refuses a player doc with no uuid (a stale row is not a recipient)', async () => {
    identities.alp = { username: 'Alp' };
    const it = interaction({ player: 'Alp', text: 'hello' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 0);
    assert.match(it.replies[0], /No player named/);
});

// ---------------------------------------------------------------------------
// /reply ... report:<id> closes the player's report the way the proxy's
// `/reports close <id> <note>` does (Bifrost src/plugins/support/index.ts closeReport):
// filter `{_id, status: 'open'}`, `$set {status: 'closed', closedBy, closedAt, note}`.
// ---------------------------------------------------------------------------

const { ObjectId } = require('mongodb');
const reportClose = require('../discord/commands/util/reportClose');

const DAY = 86400e3;
const OWN_ID = '66f3a0b1c2d3e4f5a62c4a87';

const getPath = (doc, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), doc);
const same = (a, b) => {
    if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return a === b;
};
const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => same(getPath(doc, key), want));

let reports;    // the fake bifrost.reports
let reads;      // every find on it
let writes;     // mail inserts and report updates, in the order they were issued
let dbCalls;    // getBifrostDb calls

function reportDoc(id, over = {}) {
    return {
        _id: new ObjectId(id),
        kind: 'bug',
        reporter: { uuid: 'uuid-alp', username: 'Alp' },
        text: 'the quest book is empty on chapter four and the rewards are gone',
        server: { tag: 'arc', id: 'arc1', name: 'Arcadia' },
        proto: 767,
        at: new Date(NOW.getTime() - DAY),
        status: 'open',
        ...over
    };
}

function fakeReports() {
    return {
        find(filter, options = {}) {
            const read = { filter, options, sort: null, limit: null };
            reads.push(read);
            const cursor = {
                sort(spec) { read.sort = spec; return cursor; },
                limit(n) { read.limit = n; return cursor; },
                async toArray() {
                    let out = reports.filter(doc => matches(doc, filter));
                    for (const [key, dir] of Object.entries(read.sort || {})) {
                        out = [...out].sort((a, b) => (getPath(a, key) - getPath(b, key)) * dir);
                    }
                    if (typeof read.limit === 'number') out = out.slice(0, read.limit);
                    const keys = Object.keys(options.projection || {});
                    return keys.length ? out.map(doc => Object.fromEntries(keys.map(k => [k, doc[k]]))) : out;
                }
            };
            return cursor;
        },
        async updateOne(filter, update) {
            writes.push({ op: 'report', filter, update });
            const hit = reports.find(doc => matches(doc, filter));
            if (!hit) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(hit, update.$set);
            return { matchedCount: 1, modifiedCount: 1 };
        }
    };
}

beforeEach(() => {
    reports = [
        reportDoc(OWN_ID),
        reportDoc('66f3a0b1c2d3e4f5a6b7c001', { status: 'closed', closedBy: 'Mod', closedAt: NOW, note: 'fixed' }),
        reportDoc('66f3a0b1c2d3e4f5a6d00d11', { reporter: { uuid: 'uuid-bob', username: 'Bob' }, text: 'somebody else wrote this' })
    ];
    reads = [];
    writes = [];
    dbCalls = 0;
    mongo.insertMail = async (doc) => { writes.push({ op: 'mail', doc }); inserted.push(doc); return { insertedId: 'x' }; };
    mongo.getBifrostDb = async () => {
        dbCalls++;
        return { collection: (name) => { assert.strictEqual(name, 'reports'); return fakeReports(); } };
    };
});

function reportWrites() {
    return writes.filter(w => w.op === 'report');
}

test('report option: registered as optional, with autocomplete', () => {
    const report = command.data.toJSON().options.find(o => o.name === 'report');
    assert.ok(report, '/reply has a report option');
    assert.strictEqual(report.required, false);
    assert.strictEqual(report.autocomplete, true);
});

test('report id parsing: #tail, tail and the full ObjectId; a blank is no option at all', () => {
    assert.deepStrictEqual(reportClose.parseReportId('#2c4a87'), { ok: true, id: '2c4a87' });
    assert.deepStrictEqual(reportClose.parseReportId(' 2C4A87 '), { ok: true, id: '2c4a87' });
    assert.deepStrictEqual(reportClose.parseReportId(OWN_ID), { ok: true, id: OWN_ID });
    assert.strictEqual(reportClose.parseReportId(null), null);
    assert.strictEqual(reportClose.parseReportId(undefined), null);
    assert.strictEqual(reportClose.parseReportId('   '), null);
    for (const junk of ['abc', 'report:2c4a87', 'zzzzzz', `${OWN_ID}0`, '#']) {
        assert.deepStrictEqual(reportClose.parseReportId(junk), { ok: false }, junk);
    }
});

test('report id matching follows the proxy: the whole id, or a tail of four or more', () => {
    assert.strictEqual(reportClose.shortId(new ObjectId(OWN_ID)), '2c4a87');
    assert.ok(reportClose.idMatches(new ObjectId(OWN_ID), '#2c4a87'));
    assert.ok(reportClose.idMatches(new ObjectId(OWN_ID), '4a87'));
    assert.ok(reportClose.idMatches(new ObjectId(OWN_ID), OWN_ID.toUpperCase()));
    assert.ok(!reportClose.idMatches(new ObjectId(OWN_ID), 'a87'), 'three characters are too few');
    assert.ok(!reportClose.idMatches(new ObjectId(OWN_ID), ''));
});

test('report close shape: the fields /reports close writes, the note cut at 200 as the proxy cuts it', () => {
    assert.deepStrictEqual(reportClose.buildReportClose({ staffName: 'staff', text: 'Your items are restored.', now: NOW }), {
        status: 'closed',
        closedBy: 'staff',
        closedAt: NOW,
        note: 'Your items are restored.'
    });
    const long = reportClose.buildReportClose({ staffName: 'staff', text: `line one\nline two ${'x'.repeat(300)}`, now: NOW });
    assert.strictEqual(long.note.length, 200);
    assert.ok(long.note.startsWith('line one line two x'));
    assert.ok(long.note.endsWith('...'));
    assert.deepStrictEqual(reportClose.buildReportClose({ staffName: '', text: ' ', now: NOW }),
        { status: 'closed', closedBy: 'Staff', closedAt: NOW }, 'no text, no note, as in game');
});

test('/reply report:#tail sends the mail, then closes that report with the text as the note', async () => {
    const it = interaction({ player: 'Alp', text: 'Your items are restored.', report: '#2c4a87' });
    await command.execute(it);

    assert.deepStrictEqual(writes.map(w => w.op), ['mail', 'report'], 'the mail goes out first');
    const mail = inserted[0];
    assert.strictEqual(mail.body, 'Your items are restored.', 'the mail itself is unchanged');
    const [write] = reportWrites();
    assert.deepStrictEqual(write.filter, { _id: new ObjectId(OWN_ID), 'reporter.uuid': 'uuid-alp', status: 'open' });
    assert.ok(write.filter._id instanceof ObjectId, 'the _id is matched as an ObjectId');
    assert.deepStrictEqual(write.update, {
        $set: { status: 'closed', closedBy: 'staff', closedAt: mail.sentAt, note: 'Your items are restored.' }
    });
    assert.strictEqual(reports[0].status, 'closed');

    const own = reads.find(r => r.filter['reporter.uuid'] === 'uuid-alp');
    assert.deepStrictEqual(own.sort, { at: -1 });
    assert.strictEqual(own.limit, 500);
    assert.match(it.replies[0], /^✅ Sent — \*\*Alp\*\*/);
    assert.match(it.replies[0], /\n✅ Report #2c4a87 is closed\./);
});

test('/reply report: the bare tail and the full ObjectId close it too', async () => {
    for (const report of ['2c4a87', OWN_ID]) {
        reports[0].status = 'open';
        writes = [];
        const it = interaction({ player: 'alp', text: 'Fixed.', report });
        await command.execute(it);
        assert.strictEqual(reportWrites().length, 1, report);
        assert.strictEqual(reports[0].note, 'Fixed.');
        assert.match(it.replies[0], /Report #2c4a87 is closed/);
    }
});

test('/reply report: another player\'s report is left alone, and the mail still goes out', async () => {
    const it = interaction({ player: 'Alp', text: 'hello', report: 'd00d11' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 1, 'the mail is sent');
    assert.strictEqual(reportWrites().length, 0, 'no report is touched');
    assert.strictEqual(reports[2].status, 'open');
    assert.match(it.replies[0], /^✅ Sent/);
    assert.match(it.replies[0], /Report not updated: #d00d11 belongs to \*\*Bob\*\*/);
});

test('/reply report: an id that fits nothing, two reports, or no id at all sends the mail and touches no report', async () => {
    const cases = [
        ['ffffff', /Report not updated: \*\*Alp\*\* has no report #ffffff\./],
        ['not-an-id', /Report not updated: that is not a report id\./]
    ];
    for (const [report, why] of cases) {
        inserted = [];
        writes = [];
        const it = interaction({ player: 'Alp', text: 'hello', report });
        await command.execute(it);
        assert.strictEqual(inserted.length, 1, `${report}: the mail is sent`);
        assert.strictEqual(reportWrites().length, 0, `${report}: no report is touched`);
        assert.match(it.replies[0], why);
    }

    reports.push(reportDoc('66f3a0b1c2d3e4f5a6114a87'));
    inserted = [];
    writes = [];
    const it = interaction({ player: 'Alp', text: 'hello', report: '4a87' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 1);
    assert.strictEqual(reportWrites().length, 0);
    assert.match(it.replies[0], /#4a87 fits more than one report from \*\*Alp\*\*/);
});

test('/reply report: a closed report stays as it was, and a lost race reads as closed too', async () => {
    const it = interaction({ player: 'Alp', text: 'hello', report: 'b7c001' });
    await command.execute(it);
    assert.strictEqual(reportWrites().length, 0, 'a report read as closed gets no write');
    assert.strictEqual(reports[1].note, 'fixed', 'the first answer stays');
    assert.match(it.replies[0], /Report not updated: #b7c001 is already closed\./);

    // Closed in game between the read and the write: the open filter matches nothing.
    const realGet = mongo.getBifrostDb;
    mongo.getBifrostDb = async () => {
        const db = await realGet();
        return {
            collection: (name) => {
                const coll = db.collection(name);
                const updateOne = coll.updateOne;
                coll.updateOne = async (filter, update) => { reports[0].status = 'closed'; return updateOne(filter, update); };
                return coll;
            }
        };
    };
    const raced = interaction({ player: 'Alp', text: 'hello', report: '2c4a87' });
    await command.execute(raced);
    assert.strictEqual(reports[0].note, undefined, 'the in-game close wins');
    assert.match(raced.replies[0], /Report not updated: #2c4a87 is already closed\./);
});

test('/reply report: Mongo failing on the report is a line in the reply, and the mail is still sent', async () => {
    mongo.getBifrostDb = async () => { throw new Error('connection reset'); };
    const it = interaction({ player: 'Alp', text: 'hello', report: '2c4a87' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 1);
    assert.match(it.replies[0], /^✅ Sent/);
    assert.match(it.replies[0], /Report not updated: the database did not answer/);
});

test('/reply without report: the same reply as before, and bifrost.reports is never read', async () => {
    const it = interaction({ player: 'Alp', text: 'Your items are restored.' });
    await command.execute(it);
    assert.strictEqual(inserted.length, 1);
    assert.deepStrictEqual(it.replies, ['✅ Sent — **Alp** sees it in game (now if online, else at next login).']);
    assert.strictEqual(dbCalls, 0, 'no report read, no report write');
});

function autocompleteInteraction(focused, options) {
    const responses = [];
    return {
        responses,
        options: {
            getFocused: () => focused,
            getString: (name) => (typeof options[name] === 'string' ? options[name] : null)
        },
        respond: async (choices) => { responses.push(choices); }
    };
}

test('report autocomplete: that player\'s open reports as short id and first words, the full id as the value', async () => {
    reports.push(reportDoc('66f3a0b1c2d3e4f5a6e00e01', { text: 'lag at spawn', at: NOW }));
    const it = autocompleteInteraction({ name: 'report', value: '' }, { player: 'Alp' });
    await command.autocomplete(it);
    assert.deepStrictEqual(it.responses, [[
        { name: '#e00e01 lag at spawn', value: '66f3a0b1c2d3e4f5a6e00e01' },
        { name: '#2c4a87 the quest book is empty on chapter four and the rewards are...', value: OWN_ID }
    ]], 'newest first, open only, nobody else\'s');
    assert.deepStrictEqual(reads.at(-1).filter, { 'reporter.uuid': 'uuid-alp', status: 'open' });

    const typed = autocompleteInteraction({ name: 'report', value: '#2c4' }, { player: 'Alp' });
    await command.autocomplete(typed);
    assert.deepStrictEqual(typed.responses[0].map(c => c.value), [OWN_ID]);

    const noPlayer = autocompleteInteraction({ name: 'report', value: '' }, {});
    await command.autocomplete(noPlayer);
    assert.deepStrictEqual(noPlayer.responses, [[]]);

    const ghost = autocompleteInteraction({ name: 'report', value: '' }, { player: 'Ghost' });
    await command.autocomplete(ghost);
    assert.deepStrictEqual(ghost.responses, [[]]);
});
