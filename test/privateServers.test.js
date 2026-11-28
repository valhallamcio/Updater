/*
 * Private servers: Bifrost's accessGate { kind: 'allowlist' } (Yggdrasil sends
 * isPrivate on keyed reads). /servers, the live embed and /online name no
 * private server and none of its players. With no private server every output
 * is the one from before.
 * Run: npm test   (node --test test/)
 */

// No unit test may reach a real Mongo or the live API.
process.env.MONGODB_URL ??= 'mongodb://127.0.0.1:9';
process.env.YGGDRASIL_API_URL ??= 'http://127.0.0.1:9/v1';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const yggdrasil = require('../modules/yggdrasil');
const { isPrivateServer, publicServers } = require('../modules/privateServers');
const liveEmbedManager = require('../modules/liveEmbedManager');
const serversCommand = require('../discord/commands/servers');
const onlineCommand = require('../discord/commands/online');

const realGetServers = yggdrasil.getServers;
const realGetPlayers = yggdrasil.getPlayersDetailed;
afterEach(() => {
    yggdrasil.getServers = realGetServers;
    yggdrasil.getPlayersDetailed = realGetPlayers;
});

const doc = (tag, name, extra = {}) => ({
    id: tag + name, tag, name, serverId: (tag + name).slice(0, 8), serverVersion: '1.7.10', modpackVersion: '1.0',
    platform: 'curseforge', status: 'running', earlyAccess: false, excludeFromServerList: false, ...extra,
});
const GTTW = doc('gttw', 'GT Twist', { isPrivate: true });
const GTNH = doc('gtnh', 'GTNH', { platform: 'gregtechnewhorizons' });
const ATM = doc('atm', 'AllTheMods', { serverVersion: '1.21.1' });
const IL2 = doc('il2', 'Ilum', { serverVersion: '1.20.1' });
const IL2P = doc('il2', 'Ilum Private', { serverVersion: '1.20.1', accessGate: { kind: 'allowlist', uuids: [] } });

/** An embed's JSON without the clock. */
function shape(embed) {
    const json = embed.toJSON();
    delete json.timestamp;
    if (json.description) json.description = json.description.replace(/<t:\d+:R>/, '<t:R>');
    return json;
}

test('private: the flag or the allowlist kind makes a server private, nothing else does', () => {
    assert.strictEqual(isPrivateServer(GTTW), true);
    assert.strictEqual(isPrivateServer(IL2P), true);
    for (const s of [GTNH, null, undefined, { isPrivate: 'yes' }, { accessGate: { kind: 'network_playtime', hours: 150 } }, { accessGate: null }]) {
        assert.strictEqual(isPrivateServer(s), false, JSON.stringify(s));
    }
    const list = [GTTW, GTNH, IL2P, IL2];
    assert.deepStrictEqual(publicServers(list), [GTNH, IL2]);
    assert.strictEqual(list.length, 4, 'the input is not changed');
    assert.deepStrictEqual(publicServers(undefined), []);
});

async function serversReply(list) {
    yggdrasil.getServers = async () => structuredClone(list);
    const reply = await serversCommand.execute({ reply: async (msg) => msg });
    return shape(reply.embeds[0]);
}

test('private: /servers lists a private server nowhere', async () => {
    const withPrivate = await serversReply([GTTW, GTNH, IL2P, IL2, ATM]);
    const without = await serversReply([GTNH, IL2, ATM]);
    assert.deepStrictEqual(withPrivate, without);
    assert.ok(!/gttw|GT Twist|Ilum Private/i.test(JSON.stringify(withPrivate)));
    assert.strictEqual(withPrivate.description, 'Servers online: 3', 'a private server is not counted online');

    // A private copy ordered first must not claim the tag for the public one.
    const first = await serversReply([IL2P, IL2]);
    assert.ok(JSON.stringify(first).includes('IL2 | Ilum**'), JSON.stringify(first));
});

test('private: the live embed and its hash leave a private server out', () => {
    const withPrivate = [GTTW, GTNH, IL2P, IL2];
    const without = [GTNH, IL2];
    assert.deepStrictEqual(shape(liveEmbedManager.generateServerEmbed(withPrivate)), shape(liveEmbedManager.generateServerEmbed(without)));
    assert.strictEqual(liveEmbedManager.generateServerStateHash(withPrivate), liveEmbedManager.generateServerStateHash(without));

    const turned = [{ ...GTNH, isPrivate: true }, IL2];
    assert.notStrictEqual(liveEmbedManager.generateServerStateHash(turned), liveEmbedManager.generateServerStateHash(without),
        'a server that turns private changes the hash, so the embed is redrawn');

    const legacy = without.map(({ isPrivate, ...rest }) => rest);
    const flagged = without.map(s => ({ ...s, isPrivate: false }));
    assert.strictEqual(liveEmbedManager.generateServerStateHash(flagged), liveEmbedManager.generateServerStateHash(legacy),
        'the new isPrivate field leaves the stored hashes valid');
});

async function onlineReply(list, players) {
    yggdrasil.getServers = async () => structuredClone(list);
    yggdrasil.getPlayersDetailed = async () => structuredClone(players);
    let out = null;
    await onlineCommand.execute({ deferReply: async () => {}, editReply: async (msg) => { out = msg; return msg; } });
    return out.embeds.map(shape);
}

const p = (username, instance) => ({ username, uuid: username, ping: 20, instance });

test('private: /online shows no private server and none of its players', async () => {
    const list = [GTTW, GTNH, IL2P, IL2];
    const withPrivate = await onlineReply(list, {
        gttw: [p('Friend', 'GT Twist')],
        gtnh: [p('Stranger', 'GTNH')],
        il2: [p('Inner', 'Ilum Private'), p('Outer', 'Ilum')],
    });
    const without = await onlineReply(list, { gtnh: [p('Stranger', 'GTNH')], il2: [p('Outer', 'Ilum')] });
    assert.deepStrictEqual(withPrivate, without);
    assert.strictEqual(withPrivate[0].title, 'Players online: 2');
    const text = JSON.stringify(withPrivate);
    assert.ok(!/Friend|Inner|GT Twist|Ilum Private|gttw/.test(text), text);

    const open = list.map(s => ({ ...s, isPrivate: false, accessGate: null }));
    const all = await onlineReply(open, { gttw: [p('Friend', 'GT Twist')], gtnh: [p('Stranger', 'GTNH')] });
    assert.strictEqual(all[0].title, 'Players online: 2', 'no private server: everybody is listed as before');
    assert.ok(JSON.stringify(all).includes('Friend'));
});
