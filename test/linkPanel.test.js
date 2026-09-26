/*
 * Unit tests for the #link panel - the one message Fenrir keeps in the channel with
 * [Link account] and [My accounts].
 * Run: npm test   (node --test test/)
 *
 * The contract:
 *
 *  - an empty channel gets exactly one panel, and its id is remembered,
 *  - a restart finds the remembered message and leaves it alone while its text is the
 *    same, so it never reads "(edited)" after a boot,
 *  - a lost record makes it search the channel for its OWN panel before it posts, and an
 *    extra copy it finds is deleted - another author's message is never touched,
 *  - two passes at once post one panel, not two.
 *
 * Mongo is faked at the module surface, the way test/link.test.js does it. The channel
 * is a fake with the three calls the scheduler makes.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const linkPanel = require('../schedulers/linkPanel');
const linkFlow = require('../discord/commands/util/linkFlow');
const mongo = require('../modules/mongo');

const BOT = 'bot-fenrir';
const CONFIG = { active: true, interval: 60, channelId: 'chan-link' };

let store;      // the discord_panels doc, or null
let saves;      // saveDiscordPanel calls
let readThrows;

beforeEach(() => {
    store = null;
    saves = [];
    readThrows = false;
    mongo.getDiscordPanel = async (key) => {
        if (readThrows) throw new Error('no primary');
        return store && store._id === key ? { ...store } : null;
    };
    mongo.saveDiscordPanel = async (key, fields) => {
        saves.push({ key, ...fields });
        store = { _id: key, ...fields };
        return { matchedCount: 1 };
    };
});

/**
 * A text channel with a message history. Messages are `{id, authorId, customIds, at}`.
 */
function fakeChannel(seed = []) {
    const byId = new Map();
    const sent = [];
    const edits = [];
    const deletes = [];
    let seq = 100;

    function makeMessage(spec) {
        const message = {
            id: spec.id,
            author: { id: spec.authorId },
            createdTimestamp: spec.at,
            pinned: Boolean(spec.pinned),
            components: [{ components: (spec.customIds || []).map(id => ({ customId: id })) }],
            edit: async (payload) => { edits.push({ id: spec.id, payload }); return message; },
            delete: async () => { deletes.push(spec.id); byId.delete(spec.id); }
        };
        return message;
    }
    for (const spec of seed) byId.set(spec.id, makeMessage(spec));

    const asCollection = (list) => new Map(list.map(m => [m.id, m]));
    return {
        id: CONFIG.channelId,
        byId, sent, edits, deletes,
        messages: {
            fetch: async (arg) => {
                if (typeof arg === 'string') {
                    const message = byId.get(arg);
                    if (!message) throw new Error('Unknown Message');
                    return message;
                }
                return asCollection([...byId.values()].slice(-arg.limit));
            },
            fetchPinned: async () => asCollection([...byId.values()].filter(m => m.pinned))
        },
        send: async (payload) => {
            const customIds = payload.components.flatMap(row => row.toJSON().components.map(c => c.custom_id));
            const message = makeMessage({ id: `m${++seq}`, authorId: BOT, customIds, at: 1000 + seq });
            byId.set(message.id, message);
            sent.push(payload);
            return message;
        }
    };
}

const PANEL_BUTTONS = ['link:open', 'link:mine'];

test('the panel carries [Link account] and [My accounts] and nothing else', () => {
    const payload = linkFlow.buildPanel();
    const buttons = payload.components[0].toJSON().components;
    assert.deepStrictEqual(buttons.map(b => [b.custom_id, b.label]),
        [['link:open', 'Link account'], ['link:mine', 'My accounts']]);
    assert.match(payload.embeds[0].toJSON().description, /type `\/link` in game/);
    assert.strictEqual(linkPanel.defaultConfig.channelId, '1552762887276335294', 'the #link channel');
});

test('an empty channel gets one panel, and the next pass keeps it without an edit', async () => {
    const channel = fakeChannel();
    const first = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });
    assert.strictEqual(first.action, 'posted');
    assert.strictEqual(channel.sent.length, 1);
    assert.deepStrictEqual(saves.map(s => [s.key, s.channelId, s.messageId]), [['linkPanel', 'chan-link', first.messageId]]);
    assert.strictEqual(saves[0].hash, linkPanel.panelHash(linkFlow.buildPanel()));

    const second = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });
    assert.deepStrictEqual([second.action, second.messageId], ['kept', first.messageId]);
    assert.strictEqual(channel.sent.length, 1, 'never a second panel');
    assert.strictEqual(channel.edits.length, 0, 'an unchanged panel is not edited');
});

test('a lost record finds its own panel in the channel and edits it instead of posting', async () => {
    const channel = fakeChannel([
        { id: 'old-panel', authorId: BOT, customIds: PANEL_BUTTONS, at: 10 },
        { id: 'chatter', authorId: 'user-1', at: 20 }
    ]);
    const result = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });

    assert.deepStrictEqual([result.action, result.messageId], ['edited', 'old-panel']);
    assert.strictEqual(channel.sent.length, 0);
    assert.deepStrictEqual(channel.edits.map(e => e.id), ['old-panel']);
    assert.strictEqual(store.messageId, 'old-panel');

    const again = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });
    assert.strictEqual(again.action, 'kept');
    assert.strictEqual(channel.edits.length, 1);
});

test('duplicates from older runs are deleted, the oldest stays, other authors are left alone', async () => {
    const channel = fakeChannel([
        { id: 'panel-b', authorId: BOT, customIds: PANEL_BUTTONS, at: 30 },
        { id: 'panel-a', authorId: BOT, customIds: PANEL_BUTTONS, at: 10, pinned: true },
        { id: 'other-bot', authorId: 'bot-valhallamc', customIds: ['link:open'], at: 5 },
        { id: 'fenrir-note', authorId: BOT, customIds: [], at: 15 }
    ]);
    const result = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });

    assert.deepStrictEqual([result.action, result.messageId, result.removed], ['edited', 'panel-a', 1]);
    assert.deepStrictEqual(channel.deletes, ['panel-b']);
    assert.ok(channel.byId.has('other-bot'), 'a panel another bot posted is not ours to delete');
    assert.ok(channel.byId.has('fenrir-note'), 'our own message without the buttons is not a panel');
    assert.strictEqual(channel.sent.length, 0);
});

test('a record that points at a deleted message searches, then posts once', async () => {
    store = { _id: 'linkPanel', channelId: 'chan-link', messageId: 'gone', hash: 'x' };
    const channel = fakeChannel([{ id: 'chatter', authorId: 'user-1', at: 20 }]);
    const result = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });

    assert.strictEqual(result.action, 'posted');
    assert.strictEqual(channel.sent.length, 1);
    assert.strictEqual(store.messageId, result.messageId);
});

test('changed panel text edits the remembered message and posts nothing', async () => {
    const channel = fakeChannel([{ id: 'kept-panel', authorId: BOT, customIds: PANEL_BUTTONS, at: 10 }]);
    store = { _id: 'linkPanel', channelId: 'chan-link', messageId: 'kept-panel', hash: 'last-release' };
    const result = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });

    assert.deepStrictEqual([result.action, result.messageId], ['edited', 'kept-panel']);
    assert.strictEqual(channel.sent.length, 0);
    assert.strictEqual(store.hash, linkPanel.panelHash(linkFlow.buildPanel()));
});

test('a remembered id that is not our panel is ignored, and a Mongo outage still posts no duplicate', async () => {
    const channel = fakeChannel([
        { id: 'someone', authorId: 'user-1', customIds: PANEL_BUTTONS, at: 5 },
        { id: 'ours', authorId: BOT, customIds: PANEL_BUTTONS, at: 10 }
    ]);
    store = { _id: 'linkPanel', channelId: 'chan-link', messageId: 'someone', hash: 'x' };
    const result = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });
    assert.strictEqual(result.messageId, 'ours');

    readThrows = true;
    const again = await linkPanel.ensurePanel(CONFIG, { channel, botId: BOT });
    assert.deepStrictEqual([again.action, again.messageId], ['edited', 'ours'], 'found by search, not posted');
    assert.strictEqual(channel.sent.length, 0);
});

test('two passes at once post one panel', async () => {
    const channel = fakeChannel();
    const [a, b] = await Promise.all([
        linkPanel.ensurePanel(CONFIG, { channel, botId: BOT }),
        linkPanel.ensurePanel(CONFIG, { channel, botId: BOT })
    ]);
    assert.deepStrictEqual([a.action, b.action].sort(), ['posted', 'skipped']);
    assert.strictEqual(channel.sent.length, 1);
});
