/*
 * Unit tests for the cake drop — the day it stopped giving items.
 * Run: npm test   (node --test test/)
 *
 * The contract, because the proxy owns the balance now:
 *
 *  - not one `give` is ever sent to a backend again (that is the whole point:
 *    no cake on the floor, nothing lost to a full inventory),
 *  - every online player gets exactly one `creditCake` with the drop amount and
 *    `kind: 'drop'`, on the instance they are actually standing on,
 *  - the exclude list is honoured before any write,
 *  - an account the proxy has never seen is skipped, and the rest still get paid,
 *  - the tellraw carries the amount and the player's name,
 *  - the Discord path passes who ran it through as `by`.
 *
 * Every module is faked at its own surface, the way test/linkRequests.test.js
 * does it.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const cakeDrop = require('../schedulers/cakeDrop');
const yggdrasil = require('../modules/yggdrasil');
const mongo = require('../modules/mongo');
const pterodactyl = require('../modules/pterodactyl');
const functions = require('../modules/functions');

const SERVERS = [
    { tag: 'arc', name: 'Arcadia', serverId: 'ptero-arc' },
    { tag: 'il2', name: 'Infinity Legacy II', serverId: 'ptero-il2-pub' },
    { tag: 'il2', name: 'Infinity Legacy II SUP', serverId: 'ptero-il2-sup' }
];

let credits;   // creditCake calls
let sent;      // pterodactyl.sendCommand calls
let unknown;   // usernames creditCake answers null for

beforeEach(() => {
    credits = [];
    sent = [];
    unknown = new Set();

    functions.sleep = async () => {};
    yggdrasil.getServers = async () => SERVERS.map(s => ({ ...s }));
    yggdrasil.getPlayersDetailed = async () => ({
        arc: [{ username: 'Alp', server: 'Arcadia', instance: 'Arcadia', ping: 30 }],
        il2: [
            { username: 'Bee', server: 'Infinity Legacy II', instance: 'Infinity Legacy II SUP', ping: 40 },
            { username: 'Cee', server: 'Infinity Legacy II', instance: 'Infinity Legacy II', ping: 50 }
        ]
    });
    mongo.creditCake = async (username, amount, meta) => {
        credits.push({ username, amount, meta });
        return unknown.has(username) ? null : { uuid: `uuid-${username}`, username };
    };
    pterodactyl.sendCommand = async (serverId, command) => sent.push({ serverId, command });

    // The exclude list is read off the config file at call time.
    const config = require('../config/config.json');
    config.scheduler = config.scheduler || {};
    config.scheduler.cakeDrop = { ...(config.scheduler.cakeDrop || {}), exclude: [] };
});

/** The live exclude list the scheduler reads. */
function exclude(names) {
    require('../config/config.json').scheduler.cakeDrop.exclude = names;
}

test('cakeDrop: not one give command is ever sent to a backend', async () => {
    await cakeDrop.creditAll(3, 'cakeDrop');
    const gives = sent.filter(s => s.command.includes('give'));
    assert.deepStrictEqual(gives, [], 'the drop credits a balance; items on the floor are the bug it fixed');
});

test('cakeDrop: every online player is credited once, with the amount and kind drop', async () => {
    const result = await cakeDrop.creditAll(3, 'cakeDrop');

    assert.deepStrictEqual(credits.map(c => c.username), ['Alp', 'Bee', 'Cee']);
    assert.ok(credits.every(c => c.amount === 3), 'the same amount for everybody in one drop');
    assert.ok(credits.every(c => c.meta.kind === 'drop'), JSON.stringify(credits.map(c => c.meta)));
    assert.ok(credits.every(c => c.meta.by === 'cakeDrop'));
    assert.deepStrictEqual(result, { players: 3, cakes: 9 });
});

test('cakeDrop: the line lands on the instance the player is standing on', async () => {
    await cakeDrop.creditAll(2, 'cakeDrop');
    assert.deepStrictEqual(sent.map(s => s.serverId), ['ptero-arc', 'ptero-il2-sup', 'ptero-il2-pub'],
        'two instances share the il2 tag and the player is on exactly one of them');
});

test('cakeDrop: the tellraw carries the amount and the player name', async () => {
    await cakeDrop.creditAll(5, 'cakeDrop');
    const line = sent[0].command;
    assert.ok(line.includes('Alp'), line);
    assert.ok(line.includes('+5 cake banked'), line);
    assert.ok(!line.includes('[AMOUNT]') && !line.includes('[RECIEVERS]'), `an unsubstituted placeholder: ${line}`);
    assert.ok(line.includes('/cake'), 'the player has to be told how to take it out');
});

test('cakeDrop: the exclude list is honoured before anything is written', async () => {
    exclude(['Bee']);
    await cakeDrop.creditAll(1, 'cakeDrop');
    assert.deepStrictEqual(credits.map(c => c.username), ['Alp', 'Cee']);
    assert.strictEqual(sent.length, 2, 'and they are not told about a drop they did not get');
});

test('cakeDrop: an account the proxy has never seen is skipped, and the rest are still paid', async () => {
    unknown.add('Bee');
    const result = await cakeDrop.creditAll(4, 'cakeDrop');
    assert.deepStrictEqual(credits.map(c => c.username), ['Alp', 'Bee', 'Cee'], 'all three are tried');
    assert.deepStrictEqual(sent.map(s => s.serverId), ['ptero-arc', 'ptero-il2-pub'],
        'the one with nowhere to put it is never told');
    assert.deepStrictEqual(result, { players: 2, cakes: 8 });
});

test('cakeDrop: a server the registry does not know is skipped without throwing', async () => {
    yggdrasil.getPlayersDetailed = async () => ({ nope: [{ username: 'Dee', instance: 'Nowhere' }] });
    const result = await cakeDrop.creditAll(1, 'cakeDrop');
    assert.deepStrictEqual(credits, []);
    assert.deepStrictEqual(result, { players: 0, cakes: 0 });
});

test('cakeDrop: the Discord path passes who ran it through and reports the total', async () => {
    const reply = await cakeDrop.dropCakeManual(2, 'alp#0001');
    assert.ok(credits.every(c => c.meta.by === 'alp#0001'), JSON.stringify(credits.map(c => c.meta.by)));
    assert.ok(reply.includes('6'), reply);
    assert.ok(reply.includes('3'), reply);
    assert.ok(!reply.toLowerCase().includes('dropped'), `the drop banks cake now: ${reply}`);
});

test('cakeDrop: the roll decides whether anything happens at all', async () => {
    const random = Math.random;
    try {
        Math.random = () => 0.99;
        await cakeDrop.dropCake({ min: 1, max: 1, chance: 3 });
        assert.deepStrictEqual(credits, [], 'a losing roll credits nobody');

        Math.random = () => 0;
        await cakeDrop.dropCake({ min: 2, max: 2, chance: 3 });
        assert.deepStrictEqual(credits.map(c => c.amount), [2, 2, 2]);
    } finally {
        Math.random = random;
    }
});

test('the Discord command calls dropCakeManual destructured, so it must not need `this`', async () => {
    const { dropCakeManual } = require('../schedulers/cakeDrop');
    const reply = await dropCakeManual(2, 'alp#0001');
    assert.strictEqual(credits.length, 3);
    assert.ok(reply.includes('**6**'), reply);
    assert.ok(reply.includes('**3**'), reply);
});

test('a messages.json from before the bank still tells the player the amount', async () => {
    // config/ is not in git: prod keeps the old template with no [AMOUNT].
    const messages = require('../config/messages.json');
    const before = messages.alertCakeDrop;
    messages.alertCakeDrop = 'tellraw [RECIEVERS] {"text":"Cake drop!","color":"green"}';
    try {
        await cakeDrop.creditAll(3, 'cakeDrop');
    } finally {
        messages.alertCakeDrop = before;
    }
    const line = sent.find(s => s.command.includes('Alp'));
    assert.ok(line, 'Alp was told');
    assert.ok(line.command.includes('+3 cake banked'), line.command);
    assert.ok(!line.command.includes('[AMOUNT]'), line.command);
});
