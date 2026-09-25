/*
 * Unit tests for the chat guard cards: the card staff decide on, and the console command
 * each button sends to Bifrost.
 * Run: npm test   (node --test test/)
 *
 * The contract, because a ban or an unmute lands on a real player:
 *
 *  - the flag leaves `open` BEFORE the command goes out, on a filter that only matches
 *    while it is open with the action the clicker saw, so a double click sends one command,
 *  - the loser of that race is told who won and sends nothing,
 *  - each button sends the exact console line Bifrost's punishments plugin reads, with no
 *    leading slash, because Bifrost's console does not strip one,
 *  - a command that does not reach Bifrost is shown to the clicker and on the card, and
 *    the flag stays decided,
 *  - player text cannot format the card or mention anybody,
 *  - the card follows the proxy when it adds context or raises review to muted,
 *  - somebody without the staff role is refused before any of it.
 *
 * Every module is faked at its own surface, the way test/linkRequests.test.js does it.
 * Every other Mongo and Pterodactyl function throws, so nothing here can reach prod.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { PermissionFlagsBits } = require('discord.js');
const chatFlags = require('../schedulers/chatFlags');
const mongo = require('../modules/mongo');
const pterodactyl = require('../modules/pterodactyl');
const sessionLogger = require('../modules/sessionLogger');

const CONFIG = { interval: 1, channelId: 'chan-1', staffRoleIds: ['role-staff'] };
const GREY = 0x95a5a6;

for (const target of [mongo, pterodactyl]) {
    for (const key of Object.keys(target)) {
        if (typeof target[key] === 'function') {
            target[key] = () => { throw new Error(`${key} is not faked - a test must never reach prod`); };
        }
    }
}

let flags;      // _id -> bifrost.chat_flags doc
let writes;     // every write and command, in the order it was issued
let commands;   // pterodactyl.sendCommand calls
let sent;       // channel.send payloads
let messages;   // message id -> fake message
let logs;       // sessionLogger warn and error calls
let clients;    // chatFlags.getClient calls

beforeEach(() => {
    flags = {
        'flag-1': {
            _id: 'flag-1',
            uuid: 'uuid-griefer',
            username: 'Griefer',
            server: 'Arcadia',
            message: 'the flagged line',
            context: [
                { at: new Date('2026-09-25T10:00:00Z'), text: 'first line' },
                { at: new Date('2026-09-25T10:00:05Z'), text: 'the flagged line' }
            ],
            source: 'hardlist',
            scores: null,
            action: 'muted',
            status: 'open',
            createdAt: new Date('2026-09-25T10:00:05Z')
        },
        'flag-2': {
            _id: 'flag-2',
            uuid: 'uuid-reviewed',
            username: 'Reviewed',
            server: 'Star Technology',
            message: 'borderline line',
            context: [{ at: new Date('2026-09-25T11:00:00Z'), text: 'borderline line' }],
            source: 'jev',
            scores: { hate: 0.614, harass: 0.2, threat: 0.031, selfharm: 0 },
            action: 'review',
            status: 'open',
            createdAt: new Date('2026-09-25T11:00:00Z')
        }
    };
    writes = [];
    commands = [];
    sent = [];
    messages = new Map();
    logs = [];
    clients = 0;

    require('../config/config.json').pterodactyl.velocityID = 'bifrost-ptero';

    const copy = doc => structuredClone(doc);
    mongo.findChatFlagsToPost = async () => Object.values(flags)
        .filter(f => f.status === 'open' && f.posted !== true)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(copy);
    mongo.findPostedChatFlags = async () => Object.values(flags)
        .filter(f => f.status === 'open' && f.posted === true)
        .map(copy);
    mongo.getChatFlag = async (id) => (flags[id] ? copy(flags[id]) : null);
    mongo.markChatFlagPosted = async (id, messageId, channelId, cardHash) => {
        Object.assign(flags[id], { posted: true, postedAt: new Date(), messageId, channelId, cardHash });
        writes.push('posted');
        return { matchedCount: 1, modifiedCount: 1 };
    };
    mongo.setChatFlagCardHash = async (id, cardHash) => {
        if (!flags[id] || flags[id].status !== 'open') return { matchedCount: 0, modifiedCount: 0 };
        flags[id].cardHash = cardHash;
        return { matchedCount: 1, modifiedCount: 1 };
    };
    // the real one is a single updateOne filtered on status:'open' and the action - the read
    // and the flip cannot interleave, so this must not await before it mutates
    mongo.claimChatFlag = async (id, action, status, decidedBy, decidedName) => {
        const doc = flags[id];
        if (!doc || doc.status !== 'open' || doc.action !== action) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(doc, { status, decidedBy: String(decidedBy), decidedName: String(decidedName), decidedAt: new Date() });
        writes.push('claim');
        return { matchedCount: 1, modifiedCount: 1 };
    };
    pterodactyl.sendCommand = async (serverId, command) => {
        commands.push({ serverId, command });
        writes.push('command');
        return { success: true };
    };

    sessionLogger.info = () => {};
    sessionLogger.warn = (...args) => logs.push({ level: 'warn', text: args.join(' ') });
    sessionLogger.error = (...args) => logs.push({ level: 'error', text: args.join(' ') });

    chatFlags.getClient = async () => {
        clients++;
        throw new Error('a test must never reach Discord');
    };
});

/** A card message that records its edits, the way discord.js hands one back. */
function message(id) {
    const msg = {
        id,
        edits: [],
        edit: async (payload) => { msg.edits.push(payload); return msg; }
    };
    messages.set(id, msg);
    return msg;
}

/** The staff channel. `send` hands back a message id and keeps the message to edit. */
function channel() {
    return {
        id: 'chan-1',
        send: async (payload) => {
            sent.push(payload);
            return message(`msg-${sent.length}`);
        },
        messages: {
            fetch: async (id) => {
                if (!messages.has(id)) throw new Error('Unknown Message');
                return messages.get(id);
            }
        }
    };
}

/** A button interaction with just the surface the scheduler touches. */
function click(action, id, opts = {}) {
    const replies = [];
    return {
        replies,
        customId: `chatflag:${action}:${id}`,
        user: { id: opts.userId || 'd-mod', username: opts.username || 'mod' },
        member: { roles: { cache: new Map((opts.roles || ['role-staff']).map(r => [r, { id: r }])) } },
        memberPermissions: { has: (flag) => Boolean(opts.manageGuild) && flag === PermissionFlagsBits.ManageGuild },
        message: opts.message || message(`card-${id}-${Math.random()}`),
        reply: async (payload) => { replies.push(payload); return payload; },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); return payload; }
    };
}

/** The embed fields as a name -> value map. */
function fields(embed) {
    return new Map(embed.fields.map(f => [f.name, f.value]));
}

/** The custom ids on a payload's button row. */
function buttonIds(payload) {
    return payload.components[0].toJSON().components.map(b => b.custom_id);
}

test('an open flag is posted once, with the player, the scores and the context on the card', async () => {
    const result = await chatFlags.postOpenFlags(CONFIG, { channel: channel() });

    assert.strictEqual(result.posted, 2);
    assert.strictEqual(flags['flag-1'].posted, true);
    assert.strictEqual(flags['flag-1'].messageId, 'msg-1');
    assert.strictEqual(flags['flag-1'].channelId, 'chan-1');
    assert.ok(flags['flag-1'].postedAt instanceof Date);
    assert.match(flags['flag-1'].cardHash, /^[0-9a-f]{40}$/);

    const muted = sent[0].embeds[0].toJSON();
    assert.strictEqual(muted.title, 'Chat flag: muted automatically');
    assert.strictEqual(muted.footer.text, 'Flag flag-1');
    const mutedFields = fields(muted);
    assert.strictEqual(mutedFields.get('Player'), 'Griefer');
    assert.strictEqual(mutedFields.get('UUID'), '`uuid-griefer`');
    assert.strictEqual(mutedFields.get('Server'), 'Arcadia');
    assert.strictEqual(mutedFields.get('Source'), 'Hard word list');
    assert.strictEqual(mutedFields.get('Scores'), 'None');
    assert.strictEqual(mutedFields.get('Message'), 'the flagged line');
    assert.match(muted.description, /<t:1790330400:T> first line\n<t:1790330405:T> the flagged line$/,
        'every context line carries its own Discord timestamp, oldest first');
    assert.deepStrictEqual(buttonIds(sent[0]), ['chatflag:ban:flag-1', 'chatflag:unmute:flag-1', 'chatflag:keep:flag-1']);

    const review = sent[1].embeds[0].toJSON();
    assert.strictEqual(review.title, 'Chat flag: needs review');
    assert.strictEqual(fields(review).get('Scores'), 'hate 61%, harass 20%, threat 3%, selfharm 0%');
    assert.strictEqual(fields(review).get('Source'), 'Jev classifier');
    assert.deepStrictEqual(buttonIds(sent[1]), ['chatflag:mute:flag-2', 'chatflag:ban:flag-2', 'chatflag:dismiss:flag-2']);

    for (const payload of sent) {
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] }, 'no post may ping anybody');
    }

    // Second pass: both are marked as posted and nothing changed, so nothing goes out.
    const again = await chatFlags.postOpenFlags(CONFIG, { channel: channel() });
    assert.strictEqual(again.posted, 0);
    assert.strictEqual(again.edited, 0);
    assert.strictEqual(sent.length, 2);
});

test('player text cannot format the card or mention anybody', async () => {
    Object.assign(flags['flag-1'], {
        username: 'Grief_er',
        server: '**Arc**',
        message: '@everyone <@123> <@&456> <#789> **bold** # heading',
        context: [{ at: new Date('2026-09-25T10:00:00Z'), text: '@here _x_ [link](https://evil.example) `code`\nsecond' }]
    });
    delete flags['flag-2'];

    await chatFlags.postOpenFlags(CONFIG, { channel: channel() });

    const embed = sent[0].embeds[0].toJSON();
    const text = JSON.stringify(embed);
    assert.doesNotMatch(text, /@(everyone|here)/, 'a mass mention survived');
    assert.doesNotMatch(text, /<@&?\d|<#\d/, 'a user, role or channel mention survived');

    const f = fields(embed);
    assert.strictEqual(f.get('Player'), 'Grief\\_er');
    assert.strictEqual(f.get('Server'), '\\*\\*Arc\\*\\*');
    assert.match(f.get('Message'), /\\\*\\\*bold\\\*\\\*/);
    assert.match(f.get('Message'), /^@\u200beveryone /);
    assert.match(embed.description, /\\_x\\_/);
    assert.match(embed.description, /\\`code\\`/);
    assert.doesNotMatch(embed.description, /`code`/);
    assert.strictEqual(embed.description.split('\n').length, 2, 'a newline in player text starts no new line');
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
});

// Each button: the status it leaves behind and the exact line Bifrost gets.
const CHOICES = [
    { flag: 'flag-1', button: 'ban', status: 'banned', command: 'ban Griefer chatguard flag flag-1 (hardlist) by mod' },
    { flag: 'flag-1', button: 'unmute', status: 'unmuted', command: 'unmute Griefer' },
    { flag: 'flag-1', button: 'keep', status: 'kept', command: null },
    { flag: 'flag-2', button: 'mute', status: 'muted', command: 'mute Reviewed chatguard flag flag-2 (jev) by mod' },
    { flag: 'flag-2', button: 'ban', status: 'banned', command: 'ban Reviewed chatguard flag flag-2 (jev) by mod' },
    { flag: 'flag-2', button: 'dismiss', status: 'dismissed', command: null }
];

for (const choice of CHOICES) {
    test(`${choice.button} on a ${choice.flag === 'flag-1' ? 'muted' : 'review'} card: ${choice.status}, `
        + `${choice.command ? `sends "${choice.command}"` : 'sends nothing'}`, async () => {
        const it = click(choice.button, choice.flag);
        await chatFlags.handleButton(it, CONFIG);

        const doc = flags[choice.flag];
        assert.strictEqual(doc.status, choice.status);
        assert.strictEqual(doc.decidedBy, 'd-mod');
        assert.strictEqual(doc.decidedName, 'mod');
        assert.ok(doc.decidedAt instanceof Date);

        if (choice.command) {
            assert.deepStrictEqual(commands, [{ serverId: 'bifrost-ptero', command: choice.command }]);
            assert.deepStrictEqual(writes, ['claim', 'command'],
                'the other way round, two clicks racing would both pass the check and both send');
            assert.ok(it.replies[0].includes(`\`${choice.command}\``), it.replies[0]);
        } else {
            assert.deepStrictEqual(commands, []);
            assert.deepStrictEqual(writes, ['claim']);
        }
        assert.match(it.replies[0], /^✅/);

        const edit = it.message.edits[0];
        const embed = edit.embeds[0].toJSON();
        assert.strictEqual(embed.color, GREY);
        assert.deepStrictEqual(edit.components, [], 'the buttons come off once it is decided');
        assert.match(fields(embed).get('Decision'), /^\S.* by mod, <t:\d+:f>$/);
        assert.deepStrictEqual(edit.allowedMentions, { parse: [] });
    });
}

test('two clicks on the same flag: one decision, one command, and the loser is told who won', async () => {
    const card = message('card-shared');
    const first = click('ban', 'flag-1', { userId: 'd-a', username: 'moda', message: card });
    const second = click('unmute', 'flag-1', { userId: 'd-b', username: 'modb', message: card });

    await Promise.all([
        chatFlags.handleButton(first, CONFIG),
        chatFlags.handleButton(second, CONFIG)
    ]);

    assert.strictEqual(writes.filter(w => w === 'claim').length, 1, 'the claim is the atomic step');
    assert.strictEqual(commands.length, 1, 'only the winner sends a command');
    const winner = flags['flag-1'].decidedBy === 'd-a' ? first : second;
    const loser = winner === first ? second : first;
    const winnerName = winner.user.username;
    assert.strictEqual(loser.replies[0], `Already handled by **${winnerName}** (${flags['flag-1'].status}).`);
    assert.strictEqual(card.edits.length, 1, 'the loser does not rewrite the card');
});

test('somebody without the staff role is refused, and nothing is written or sent', async () => {
    const it = click('ban', 'flag-1', { roles: ['role-member'] });
    await chatFlags.handleButton(it, CONFIG);

    assert.deepStrictEqual(writes, [], 'the refusal comes first - before the claim, before the command');
    assert.strictEqual(flags['flag-1'].status, 'open');
    assert.strictEqual(it.replies.length, 1);
    assert.strictEqual(it.replies[0].ephemeral, true);
    assert.match(it.replies[0].content, /staff/);
    assert.strictEqual(it.message.edits.length, 0);
});

test('an empty staffRoleIds list falls back to Manage Guild', () => {
    assert.strictEqual(chatFlags.isStaff(click('ban', 'flag-1', { manageGuild: true }), []), true);
    assert.strictEqual(chatFlags.isStaff(click('ban', 'flag-1', { roles: [] }), []), false);
    assert.strictEqual(chatFlags.isStaff(click('ban', 'flag-1', { manageGuild: true, roles: [] }),
        CONFIG.staffRoleIds), false, 'with a role list configured, the role is what counts');
});

test('a command that does not reach Bifrost: the flag stays decided, and the clicker and the card say so', async () => {
    pterodactyl.sendCommand = async (serverId, command) => {
        commands.push({ serverId, command });
        writes.push('command');
        throw new Error('Command failed with status 409');
    };

    const it = click('ban', 'flag-1');
    await chatFlags.handleButton(it, CONFIG);

    assert.strictEqual(flags['flag-1'].status, 'banned', 'the decision stands');
    assert.match(it.replies[0], /^⚠️ The flag stays marked \*\*banned\*\*/);
    assert.match(it.replies[0], /did not reach Bifrost: Command failed with status 409/);
    assert.match(it.replies[0], /by hand/);
    assert.ok(logs.some(l => l.level === 'error' && l.text.includes('flag-1') && l.text.includes('409')),
        JSON.stringify(logs));
    const card = fields(it.message.edits[0].embeds[0].toJSON());
    assert.match(card.get('Bifrost command failed'), /ban Griefer chatguard flag flag-1/);
});

test('a Pterodactyl timeout is reported as a command that may not have run', async () => {
    pterodactyl.sendCommand = async (serverId, command) => {
        commands.push({ serverId, command });
        return { success: true, timeout: true };
    };

    const it = click('unmute', 'flag-1');
    await chatFlags.handleButton(it, CONFIG);

    assert.strictEqual(flags['flag-1'].status, 'unmuted');
    assert.match(it.replies[0], /timed out/);
    assert.doesNotMatch(it.replies[0], /^✅/);
});

test('the card is edited when the proxy adds a context line, and only then', async () => {
    delete flags['flag-2'];
    const ch = channel();
    await chatFlags.postOpenFlags(CONFIG, { channel: ch });
    const card = messages.get('msg-1');

    flags['flag-1'].context.push({ at: new Date('2026-09-25T10:00:09Z'), text: 'one more wall' });
    const result = await chatFlags.postOpenFlags(CONFIG, { channel: ch });

    assert.strictEqual(result.edited, 1);
    assert.strictEqual(card.edits.length, 1);
    assert.match(card.edits[0].embeds[0].toJSON().description, /<t:1790330409:T> one more wall$/);
    assert.deepStrictEqual(card.edits[0].allowedMentions, { parse: [] });
    assert.strictEqual(sent.length, 1, 'an edit, never a second card');

    const quiet = await chatFlags.postOpenFlags(CONFIG, { channel: ch });
    assert.strictEqual(quiet.edited, 0);
    assert.strictEqual(card.edits.length, 1);
});

test('the card follows the proxy from review to muted, buttons included', async () => {
    delete flags['flag-1'];
    const ch = channel();
    await chatFlags.postOpenFlags(CONFIG, { channel: ch });
    const card = messages.get('msg-1');

    flags['flag-2'].action = 'muted';
    await chatFlags.postOpenFlags(CONFIG, { channel: ch });

    assert.strictEqual(card.edits.length, 1);
    const embed = card.edits[0].embeds[0].toJSON();
    assert.strictEqual(embed.title, 'Chat flag: muted automatically');
    assert.strictEqual(embed.color, 0xe74c3c);
    assert.deepStrictEqual(buttonIds(card.edits[0]), ['chatflag:ban:flag-2', 'chatflag:unmute:flag-2', 'chatflag:keep:flag-2']);
});

test('a click on a card the proxy changed decides nothing and redraws the card', async () => {
    flags['flag-2'].action = 'muted';   // the card still shows Mute, Ban, Dismiss
    const it = click('dismiss', 'flag-2');
    await chatFlags.handleButton(it, CONFIG);

    assert.strictEqual(flags['flag-2'].status, 'open', 'a dismiss must not close a flag that now carries a mute');
    assert.deepStrictEqual(writes, []);
    assert.match(it.replies[0], /changed/);
    assert.deepStrictEqual(buttonIds(it.message.edits[0]), ['chatflag:ban:flag-2', 'chatflag:unmute:flag-2', 'chatflag:keep:flag-2']);
});

test('a click that lands while the sync pass redraws the card leaves the card closed', async () => {
    delete flags['flag-2'];
    const ch = channel();
    await chatFlags.postOpenFlags(CONFIG, { channel: ch });
    const card = messages.get('msg-1');
    flags['flag-1'].context.push({ at: new Date('2026-09-25T10:00:09Z'), text: 'one more wall' });

    // Staff decide between the sync pass reading the flag and its edit landing.
    card.edit = async (payload) => {
        card.edits.push(payload);
        if (card.edits.length === 1) {
            Object.assign(flags['flag-1'], { status: 'banned', decidedBy: 'd-a', decidedName: 'moda', decidedAt: new Date() });
        }
        return card;
    };
    await chatFlags.postOpenFlags(CONFIG, { channel: ch });

    const last = card.edits[card.edits.length - 1];
    assert.deepStrictEqual(last.components, [], 'the redraw must not put the buttons back');
    assert.match(fields(last.embeds[0].toJSON()).get('Decision'), /^Banned by moda/);
});

test('a name that could break the console line is refused before the claim', async () => {
    flags['flag-1'].username = 'Griefer\nstop';
    const it = click('ban', 'flag-1');
    await chatFlags.handleButton(it, CONFIG);

    assert.deepStrictEqual(writes, []);
    assert.strictEqual(flags['flag-1'].status, 'open');
    assert.match(it.replies[0], /in game/);
});

test('no channelId: one warning, and no Discord or Mongo at all', async () => {
    const outcome = await chatFlags.start({ active: true, interval: 1, channelId: '' }).catch(error => error);

    assert.strictEqual(outcome, undefined, 'start returns quietly');
    assert.strictEqual(clients, 0, 'Discord was reached');
    assert.deepStrictEqual(writes, []);
    assert.strictEqual(logs.filter(l => l.level === 'warn').length, 1);
    assert.match(logs[0].text, /chat flag channel/);
});
