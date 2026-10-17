/*
 * Unit tests for /treat, Halloween item E13 (modules/halloweenTreat.js).
 * Run: npm test   (node --test test/)
 *
 * The proxy reads the row and drops what does not fit (Bifrost
 * src/plugins/halloween/items/e13.ts): a snowflake string, a lower-case dashed uuid, a
 * Date `at`, state pending. These pin that shape and every refusal before the insert.
 * The db is a fake that runs the module's filters, so no test reaches Mongo.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const treat = require('../modules/halloweenTreat');
const command = require('../discord/commands/treat');

const NOW = Date.parse('2026-10-28T12:00:00Z');
const MINUTE = 60 * 1000;
const ME = '111111111111111111';
const FRIEND_UUID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const LINK_CHANNEL = '1552762887276335294';
// The proxy's own checks on a row.
const SNOWFLAKE_RE = /^\d{15,21}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let clock;
let db;

function fakeDb(seed) {
    const data = { players: seed.players || [], halloween_discord_treats: seed.treats || [] };
    const finds = [];
    let nextId = 1;
    const matches = (doc, filter) => Object.entries(filter).every(([key, cond]) => {
        const value = doc[key];
        if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
            if ('$regex' in cond) return typeof value === 'string' && new RegExp(cond.$regex, cond.$options).test(value);
            if ('$gte' in cond) return value instanceof Date && value.getTime() >= cond.$gte.getTime();
            throw new Error(`fake db: no operator for ${key}`);
        }
        return value === cond;
    });
    return {
        data,
        finds,
        collection(name) {
            const rows = data[name] || (data[name] = []);
            return {
                find(filter) {
                    finds.push({ name, filter });
                    let out = rows.filter(d => matches(d, filter));
                    const cursor = {
                        limit(n) { out = out.slice(0, n); return cursor; },
                        toArray: async () => out.map(d => ({ ...d }))
                    };
                    return cursor;
                },
                findOne: async (filter) => {
                    const doc = rows.find(d => matches(d, filter));
                    return doc ? { ...doc } : null;
                },
                insertOne: async (doc) => {
                    const _id = `row${nextId++}`;
                    rows.push({ ...doc, _id });
                    return { insertedId: _id };
                }
            };
        }
    };
}

function service(extra) {
    return treat.createTreat({
        db: async () => db,
        linkChannelId: () => LINK_CHANNEL,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        ...extra
    });
}

beforeEach(() => {
    clock = NOW;
    db = fakeDb({
        players: [
            { uuid: '11111111-2222-4333-8444-555555555555', username: 'Alp', discord_id: ME },
            { uuid: '99999999-2222-4333-8444-555555555555', username: 'AlpAlt', discord_id: ME },
            { uuid: FRIEND_UUID, username: 'xX_Friend_Xx', discord_id: '222222222222222222' },
            { uuid: '33333333-2222-4333-8444-555555555555', username: 'a_b' },
            { uuid: '44444444444444444444444444444444', username: 'axb' }
        ]
    });
    command._internals.setService(null);
});

const rows = () => db.data.halloween_discord_treats;
const seedRows = (...ats) => {
    for (const at of ats) rows().push({ discordId: ME, targetUuid: FRIEND_UUID.toLowerCase(), targetName: 'xX_Friend_Xx', at: new Date(at), state: 'done' });
};

/* ---------------------------------------------------------------- refusals */

test('an unlinked clicker is sent to #link and writes no row', async () => {
    const out = await service().send('333333333333333333', 'xX_Friend_Xx');
    assert.strictEqual(out.reason, 'not_linked');
    assert.ok(out.text.includes(`<#${LINK_CHANNEL}>`));
    assert.strictEqual(rows().length, 0);
});

test('an unknown name is refused', async () => {
    const out = await service().send(ME, 'Nobody');
    assert.strictEqual(out.reason, 'unknown');
    assert.ok(out.text.includes('`Nobody`'));
    assert.strictEqual(rows().length, 0);
});

test('the clicker cannot treat their own account or an alt on the same Discord', async () => {
    for (const name of ['Alp', 'alp', 'ALPALT']) {
        const out = await service().send(ME, name);
        assert.strictEqual(out.reason, 'self', name);
        assert.match(out.text, /You cannot treat yourself/);
    }
    assert.strictEqual(rows().length, 0);
});

test('one treat per 10 minutes, and the refusal names the next time', async () => {
    seedRows(NOW - 4 * MINUTE);
    const out = await service().send(ME, 'xX_Friend_Xx');
    assert.strictEqual(out.reason, 'rate');
    assert.strictEqual(out.next, NOW + 6 * MINUTE);
    assert.ok(out.text.includes(`<t:${(NOW + 6 * MINUTE) / 1000}:R>`));
    assert.strictEqual(rows().length, 1);

    clock = NOW + 6 * MINUTE;
    assert.strictEqual((await service().send(ME, 'xX_Friend_Xx')).reason, 'sent');
});

test('the 10 minute gap holds across UTC midnight', async () => {
    clock = Date.parse('2026-10-29T00:02:00Z');
    seedRows(Date.parse('2026-10-28T23:55:00Z'));
    const out = await service().send(ME, 'xX_Friend_Xx');
    assert.strictEqual(out.reason, 'rate');
    assert.strictEqual(out.next, Date.parse('2026-10-29T00:05:00Z'));
});

test('five treats per UTC day; yesterday does not count', async () => {
    seedRows(...[1, 2, 3, 4, 5].map(h => NOW - h * 60 * MINUTE));
    const out = await service().send(ME, 'xX_Friend_Xx');
    assert.strictEqual(out.reason, 'rate');
    assert.strictEqual(out.next, Date.parse('2026-10-29T00:00:00Z'));
    assert.match(out.text, /5 treats today/);

    rows().length = 0;
    seedRows(...[1, 2, 3, 4, 5].map(h => Date.parse('2026-10-27T12:00:00Z') + h * 20 * MINUTE));
    assert.strictEqual((await service().send(ME, 'xX_Friend_Xx')).reason, 'sent');
});

test('the rate limit reads only this Discord\'s rows from today or the last 10 minutes', async () => {
    await service().send(ME, 'xX_Friend_Xx');
    const find = db.finds.find(f => f.name === treat.COLLECTION);
    assert.strictEqual(find.filter.discordId, ME);
    assert.strictEqual(find.filter.at.$gte.getTime(), Date.parse('2026-10-28T00:00:00Z'));
});

test('the window: before Oct 24 and from Nov 3 the command refuses without a db read', async () => {
    db = null;
    clock = Date.parse('2026-10-23T23:59:59Z');
    assert.deepStrictEqual(await service().send(ME, 'xX_Friend_Xx'), { reason: 'window', text: 'Treats open on Oct 24.' });
    clock = Date.parse('2026-11-03T00:00:00Z');
    assert.deepStrictEqual(await service().send(ME, 'xX_Friend_Xx'), { reason: 'window', text: 'The event is over.' });
});

test('the window opens at Oct 24 00:00 UTC and lasts until Nov 3', async () => {
    clock = Date.parse('2026-10-24T00:00:00Z');
    assert.strictEqual((await service().send(ME, 'xX_Friend_Xx')).reason, 'sent');
    rows().length = 0;
    clock = Date.parse('2026-11-02T23:59:59Z');
    assert.strictEqual((await service().send(ME, 'xX_Friend_Xx')).reason, 'sent');
});

test('the config may move the window; a bad value keeps the default', async () => {
    assert.deepStrictEqual(treat.readWindow(null), treat.WINDOW);
    assert.deepStrictEqual(treat.readWindow({ opensAt: 'soon', closesAt: 5 }), treat.WINDOW);
    assert.deepStrictEqual(
        treat.readWindow({ opensAt: '2026-10-20T00:00:00Z' }),
        { opensAt: Date.parse('2026-10-20T00:00:00Z'), closesAt: treat.WINDOW.closesAt }
    );
    clock = Date.parse('2026-10-21T00:00:00Z');
    const early = service({ window: { opensAt: '2026-10-20T00:00:00Z' } });
    assert.strictEqual((await early.send(ME, 'xX_Friend_Xx')).reason, 'sent');
    const late = service({ window: { opensAt: '2026-10-25T00:00:00Z' } });
    assert.strictEqual((await late.send(ME, 'xX_Friend_Xx')).text, 'Treats open on Oct 25.');
});

test('a second send while the first runs is refused and writes nothing', async () => {
    const svc = service();
    const [first, second] = await Promise.all([svc.send(ME, 'xX_Friend_Xx'), svc.send(ME, 'xX_Friend_Xx')]);
    assert.strictEqual(first.reason, 'sent');
    assert.strictEqual(second.reason, 'busy');
    assert.strictEqual(rows().length, 1);
});

/* ---------------------------------------------------------------- the row */

test('the row has the shape the proxy checks', async () => {
    const out = await service().send(ME, 'xx_friend_xx');
    assert.strictEqual(out.reason, 'sent');
    assert.strictEqual(out.text, 'Your treat is on its way. It lands when **xX\\_Friend\\_Xx** is online in the next 12 hours.');
    assert.strictEqual(rows().length, 1);
    const { _id, ...row } = rows()[0];
    assert.strictEqual(_id, out.id);
    assert.deepStrictEqual(Object.keys(row).sort(), ['at', 'discordId', 'state', 'targetName', 'targetUuid']);
    assert.strictEqual(typeof row.discordId, 'string');
    assert.match(row.discordId, SNOWFLAKE_RE);
    assert.strictEqual(row.targetUuid, FRIEND_UUID.toLowerCase());
    assert.match(row.targetUuid, UUID_RE);
    assert.strictEqual(row.targetName, 'xX_Friend_Xx');
    assert.ok(row.at instanceof Date);
    assert.strictEqual(row.at.getTime(), NOW);
    assert.strictEqual(row.state, 'pending');
});

test('an undashed stored uuid is written dashed and lower case', async () => {
    await service().send(ME, 'AXB');
    assert.strictEqual(rows()[0].targetUuid, '44444444-4444-4444-4444-444444444444');
    assert.strictEqual(treat.normalizeUuid('not-a-uuid'), null);
});

/* ---------------------------------------------------------------- name lookup */

test('names match whole and in any case; regex characters in the input are literal', async () => {
    assert.strictEqual((await service().send(ME, 'A_B')).reason, 'sent');
    assert.strictEqual(rows()[0].targetName, 'a_b');
    rows().length = 0;

    for (const name of ['a.b', '.*', 'a_', '^a_b', '(a+)+$', '[ab]_b', 'a_b|axb']) {
        const out = await service().send(ME, name);
        assert.strictEqual(out.reason, 'unknown', name);
    }
    assert.strictEqual(rows().length, 0);

    const filter = treat.nameFilter('a.b(c)');
    assert.deepStrictEqual(filter, { username: { $regex: '^a\\.b\\(c\\)$', $options: 'i' } });
});

test('an exact-case match wins over another case', async () => {
    db.data.players.push({ uuid: '55555555-2222-4333-8444-555555555555', username: 'A_B' });
    await service().send(ME, 'A_B');
    assert.strictEqual(rows()[0].targetUuid, '55555555-2222-4333-8444-555555555555');
});

/* ---------------------------------------------------------------- outcome */

test('every proxy reason has its own short text', () => {
    const name = 'xX_Friend_Xx';
    const text = reason => treat.outcomeText({ state: 'failed', reason }, name);
    assert.strictEqual(text('not_friends'), 'Your treat did not arrive: you are not friends with **xX\\_Friend\\_Xx** in game.');
    assert.strictEqual(text('no_cake'), 'Your treat did not arrive: you have no cake in your bank.');
    assert.match(text('expired'), /did not come online within 12 hours/);
    assert.match(text('closed'), /the event is over/);
    assert.match(text('not_linked'), /no longer linked/);
    assert.match(text('self'), /you cannot treat yourself/);
    assert.match(text('gift_refused'), /refused the gift/);
    assert.match(text('error'), /something went wrong/);
    assert.match(text('bad_row'), /something went wrong/);
    assert.match(text('toString'), /something went wrong/);
    assert.match(text(undefined), /something went wrong/);
    assert.match(treat.outcomeText({ state: 'done' }, name), /Your treat landed/);
    assert.strictEqual(treat.outcomeText({ state: 'pending' }, name), null);
    assert.strictEqual(treat.outcomeText({ state: 'delivering' }, name), null);
    assert.strictEqual(treat.outcomeText(null, name), null);
});

test('watch stops at the first finished read', async () => {
    const svc = service();
    const out = await svc.send(ME, 'xX_Friend_Xx');
    let reads = 0;
    const real = db.collection;
    db.collection = (name) => {
        const coll = real.call(db, name);
        const findOne = coll.findOne;
        coll.findOne = async (filter) => {
            if (++reads === 3) Object.assign(rows()[0], { state: 'failed', reason: 'no_cake' });
            return findOne(filter);
        };
        return coll;
    };
    assert.match(await svc.watch(out.id, out.targetName), /no cake in your bank/);
    assert.strictEqual(reads, 3);
    assert.strictEqual(clock, NOW + 3 * treat.WATCH_EVERY_MS);
});

test('watch gives up after a minute on a pending row', async () => {
    const svc = service();
    const out = await svc.send(ME, 'xX_Friend_Xx');
    assert.strictEqual(await svc.watch(out.id, out.targetName), null);
    assert.strictEqual(clock, NOW + treat.WATCH_MS);
});

/* ---------------------------------------------------------------- the command */

function interaction(player, userId) {
    const calls = [];
    return {
        calls,
        user: { id: userId, username: 'clicker' },
        options: { getString: (name) => (name === 'player' ? player : null) },
        deferReply: async (opts) => { calls.push({ defer: opts }); },
        editReply: async (payload) => { calls.push({ edit: payload }); }
    };
}

test('/treat answers ephemeral, then edits in the outcome', async () => {
    const svc = service();
    const realWatch = svc.watch;
    svc.watch = async (id, name) => {
        rows()[0].state = 'done';
        return realWatch(id, name);
    };
    command._internals.setService(svc);
    const i = interaction('xX_Friend_Xx', ME);
    await command.execute(i);
    assert.deepStrictEqual(i.calls[0], { defer: { ephemeral: true } });
    assert.match(i.calls[1].edit.content, /Your treat is on its way/);
    assert.deepStrictEqual(i.calls[1].edit.allowedMentions, { parse: [] });
    assert.match(i.calls[2].edit.content, /Your treat landed/);
    assert.strictEqual(i.calls.length, 3);
});

test('/treat for an unlinked clicker carries the Link account button', async () => {
    command._internals.setService(service());
    const i = interaction('xX_Friend_Xx', '333333333333333333');
    await command.execute(i);
    const edit = i.calls[1].edit;
    assert.ok(edit.content.includes(`<#${LINK_CHANNEL}>`));
    assert.strictEqual(edit.components.length, 1);
    assert.strictEqual(edit.components[0].components[0].data.custom_id, 'link:open');
    assert.strictEqual(i.calls.length, 2);
});

test('the slash command is /treat with one required player option', () => {
    const json = command.data.toJSON();
    assert.strictEqual(json.name, 'treat');
    assert.strictEqual(json.options.length, 1);
    assert.strictEqual(json.options[0].name, 'player');
    assert.strictEqual(json.options[0].required, true);
});
