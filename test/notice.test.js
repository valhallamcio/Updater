/*
 * Unit tests for /notice — the doc shapes written into bifrost.notices.
 * Run: npm test   (node --test test/)
 *
 * The proxy re-validates every doc and silently drops what doesn't fit, so these pin the
 * contract rather than the command's prose: the id charset, the title/body caps, `card`
 * (not `body`) for tips, `createdAt` on a broadcast, event `endsAt`, targets mapping,
 * and the refusal to author a MiniMessage click from Discord.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const util = require('../discord/commands/util/noticeDoc');
const command = require('../discord/commands/notice');
const mongo = require('../modules/mongo');

const NOW = new Date('2026-08-17T12:00:00Z');

let upserted; // mongo.upsertNotice calls
let enabledCalls;
let langCalls;

beforeEach(() => {
    upserted = [];
    enabledCalls = [];
    langCalls = [];
    mongo.upsertNotice = async (doc) => { upserted.push(doc); return { upsertedCount: 1 }; };
    mongo.setNoticeEnabled = async (id, enabled, by) => { enabledCalls.push({ id, enabled, by }); return { matchedCount: 1 }; };
    mongo.setNoticeBodyLang = async (id, lang, text, by) => { langCalls.push({ id, lang, text, by }); return { matchedCount: 1 }; };
});

function interaction(subcommand, options) {
    const replies = [];
    return {
        replies,
        user: { tag: 'staff#0001', username: 'staff', id: '4242' },
        options: {
            getSubcommand: () => subcommand,
            getString: (name) => (typeof options[name] === 'string' ? options[name] : null),
            getBoolean: (name) => (typeof options[name] === 'boolean' ? options[name] : null),
        },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); return payload; },
    };
}

/* ---------------------------------------------------------------- pure helpers */

test('duration parsing takes Nh/Nd and nothing else', () => {
    assert.deepStrictEqual(util.parseDuration('12h'), { ok: true, ms: 12 * 3600e3 });
    assert.deepStrictEqual(util.parseDuration('3d'), { ok: true, ms: 3 * 86400e3 });
    assert.strictEqual(util.parseDuration('3').ok, false);
    assert.strictEqual(util.parseDuration('0d').ok, false);
    assert.strictEqual(util.parseDuration('3 weeks').ok, false);
    assert.strictEqual(util.parseDuration(null).ok, false);
});

test('version -> protocol mapping covers the packs and refuses the unknown', () => {
    assert.strictEqual(util.protocolFor('1.7.10'), 5);
    assert.strictEqual(util.protocolFor('1.12.2'), 340);
    assert.strictEqual(util.protocolFor('1.20.1'), 763);
    assert.strictEqual(util.protocolFor('1.21.1'), 767);
    assert.strictEqual(util.protocolFor('1.99'), null);
});

test('default id is <prefix>.<slug>-<base36 ts> and matches the proxy id charset', () => {
    const id = util.defaultNoticeId('known_issue', 'Quest book RESET on join!', 1755432000000);
    assert.match(id, /^issue\.quest-book-reset-on-join-[a-z0-9]+$/);
    assert.match(id, util.NOTICE_ID_RE);
    // a body with only MiniMessage/punctuation still yields a usable id
    const fallback = util.defaultNoticeId('announcement', '<red>!!!</red>', 1755432000000);
    assert.match(fallback, /^announcement\.notice-[a-z0-9]+$/);
    assert.match(fallback, util.NOTICE_ID_RE);
});

test('pinned doc: body under body.en, buttons array, no expiry unless asked', () => {
    const built = util.buildNoticeDoc({ type: 'pinned', title: 'Server move', body: 'We move on Friday.', updatedBy: 'staff#0001', now: NOW });
    assert.ok(built.ok);
    assert.deepStrictEqual(built.doc.body, { en: 'We move on Friday.' });
    assert.strictEqual(built.doc.card, undefined);
    assert.strictEqual(built.doc.enabled, true);
    assert.deepStrictEqual(built.doc.buttons, []);
    assert.strictEqual(built.doc.targets, undefined);
    assert.strictEqual(built.doc.expiresAt, undefined);
    assert.deepStrictEqual(built.doc.createdAt, NOW);
    assert.deepStrictEqual(built.doc.updatedAt, NOW);
    assert.strictEqual(built.doc.updatedBy, 'staff#0001');
    assert.strictEqual(built.doc.note, 'created via /notice');
});

test('tip doc stores its text under card (the shape guide validates), never body', () => {
    const built = util.buildNoticeDoc({ type: 'tip', id: 'tip.channel_churn', body: '<gray>Try /ch global.</gray>', now: NOW });
    assert.ok(built.ok);
    assert.deepStrictEqual(built.doc.card, { en: '<gray>Try /ch global.</gray>' });
    assert.strictEqual(built.doc.body, undefined);
    assert.strictEqual(built.doc.id, 'tip.channel_churn');
});

test('event needs an end: expires -> endsAt, starts -> startsAt, missing expires is refused', () => {
    const missing = util.buildNoticeDoc({ type: 'event', title: 'Build contest', body: 'Come build.', now: NOW });
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /needs `expires`/);

    const built = util.buildNoticeDoc({ type: 'event', title: 'Build contest', body: 'Come build.', expires: '3d', starts: '12h', now: NOW });
    assert.ok(built.ok);
    assert.deepStrictEqual(built.doc.endsAt, new Date('2026-08-20T12:00:00Z'));
    assert.deepStrictEqual(built.doc.startsAt, new Date('2026-08-18T00:00:00Z'));
    assert.strictEqual(built.doc.expiresAt, undefined, 'an event ends via endsAt, not expiresAt');
});

test('non-event expiry lands on expiresAt', () => {
    const built = util.buildNoticeDoc({ type: 'known_issue', title: 'Nether lag', body: 'We are on it.', expires: '12h', now: NOW });
    assert.ok(built.ok);
    assert.deepStrictEqual(built.doc.expiresAt, new Date('2026-08-18T00:00:00Z'));
    assert.strictEqual(built.doc.endsAt, undefined);
});

test('targets: tags, new_only and the version window map to what the proxy matches on', () => {
    const built = util.buildNoticeDoc({
        type: 'announcement', body: 'Vote for us!', tags: ' ATM10 , pri ,, atm10 ',
        newOnly: true, minVersion: '1.12.2', maxVersion: '1.20.1', now: NOW
    });
    assert.ok(built.ok);
    assert.deepStrictEqual(built.doc.targets, {
        tags: ['atm10', 'pri'],
        newPlayersOnly: true,
        minProto: 340,
        maxProto: 763
    });
});

test('validation refusals: bad type, missing title, long body/title, bad id, unknown version', () => {
    assert.match(util.buildNoticeDoc({ type: 'rumour', body: 'x', now: NOW }).error, /Unknown type/);
    assert.match(util.buildNoticeDoc({ type: 'pinned', body: 'x', now: NOW }).error, /needs a title/);
    assert.match(util.buildNoticeDoc({ type: 'known_issue', body: 'x', now: NOW }).error, /needs a title/);
    assert.match(util.buildNoticeDoc({ type: 'announcement', body: '', now: NOW }).error, /empty/);
    assert.match(util.buildNoticeDoc({ type: 'announcement', body: 'x'.repeat(401), now: NOW }).error, /the cap is 400/);
    assert.match(util.buildNoticeDoc({ type: 'pinned', title: 'T'.repeat(49), body: 'x', now: NOW }).error, /the cap is 48/);
    assert.match(util.buildNoticeDoc({ type: 'announcement', id: 'Bad Id!', body: 'x', now: NOW }).error, /not a valid id/);
    assert.match(util.buildNoticeDoc({ type: 'announcement', body: 'x', minVersion: '1.6.4', now: NOW }).error, /Unknown min_version/);
});

test('a <click:> or <hover:> in the text is refused — no staff-injected clicks from Discord', () => {
    const click = util.buildNoticeDoc({ type: 'announcement', body: 'go <click:run_command:/op staff>here</click>', now: NOW });
    assert.strictEqual(click.ok, false);
    assert.match(click.error, /click/);
    const hover = util.buildNoticeDoc({ type: 'announcement', body: 'x <hover:show_text:"y">z</hover>', now: NOW });
    assert.strictEqual(hover.ok, false);
    const spaced = util.buildNoticeDoc({ type: 'announcement', body: 'x < click :run_command:/x>y', now: NOW });
    assert.strictEqual(spaced.ok, false, 'whitespace inside the tag must not slip past');
});

/* ------------------------------------------------------------------- command */

test('/notice create writes the built doc through upsertNotice, attributed to the caller', async () => {
    const it = interaction('create', { type: 'known_issue', title: 'Nether lag', body: 'We are on it.', tags: 'atm10', expires: '12h' });
    await command.execute(it);

    assert.strictEqual(upserted.length, 1);
    const doc = upserted[0];
    assert.strictEqual(doc.type, 'known_issue');
    assert.strictEqual(doc.title, 'Nether lag');
    assert.deepStrictEqual(doc.body, { en: 'We are on it.' });
    assert.deepStrictEqual(doc.targets, { tags: ['atm10'] });
    assert.strictEqual(doc.enabled, true);
    assert.strictEqual(doc.updatedBy, 'staff#0001');
    assert.ok(doc.expiresAt instanceof Date);
    assert.match(it.replies[0], /within ~1 s/);
});

test('/notice broadcast carries createdAt (the proxy drops a broadcast without one)', async () => {
    const it = interaction('broadcast', { body: 'Restarting in 5.', tags: 'pri' });
    await command.execute(it);

    assert.strictEqual(upserted.length, 1);
    assert.strictEqual(upserted[0].type, 'broadcast');
    assert.ok(upserted[0].createdAt instanceof Date, 'createdAt is required for broadcasts');
    assert.deepStrictEqual(upserted[0].body, { en: 'Restarting in 5.' });
    assert.deepStrictEqual(upserted[0].targets, { tags: ['pri'] });
});

test('/notice create refuses a bad doc before it reaches Mongo', async () => {
    const it = interaction('create', { type: 'event', title: 'Contest', body: 'Come build.' });
    await command.execute(it);
    assert.strictEqual(upserted.length, 0, 'nothing is written when validation fails');
    assert.match(it.replies[0], /needs `expires`/);
});

test('/notice expire and enable flip enabled without deleting', async () => {
    await command.execute(interaction('expire', { id: 'pinned.move' }));
    await command.execute(interaction('enable', { id: 'pinned.move' }));
    assert.deepStrictEqual(enabledCalls, [
        { id: 'pinned.move', enabled: false, by: 'staff#0001' },
        { id: 'pinned.move', enabled: true, by: 'staff#0001' },
    ]);
});

test('/notice translate takes a language code and refuses junk or a click tag', async () => {
    await command.execute(interaction('translate', { id: 'pinned.move', lang: 'ES', text: 'Nos mudamos el viernes.' }));
    assert.deepStrictEqual(langCalls, [{ id: 'pinned.move', lang: 'es', text: 'Nos mudamos el viernes.', by: 'staff#0001' }]);

    langCalls.length = 0;
    const bad = interaction('translate', { id: 'pinned.move', lang: 'spanish', text: 'x' });
    await command.execute(bad);
    assert.strictEqual(langCalls.length, 0);
    assert.match(bad.replies[0], /not a language code/);

    const clicky = interaction('translate', { id: 'pinned.move', lang: 'es', text: '<click:run_command:/op me>x</click>' });
    await command.execute(clicky);
    assert.strictEqual(langCalls.length, 0);
    assert.match(clicky.replies[0], /click/);
});
