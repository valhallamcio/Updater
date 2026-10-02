/*
 * Unit tests for modules/nbtWriter.js and modules/questRewards.js.
 * Run: npm test   (node --test test/)
 *
 * The contract, because a 1.12.2 backend reads these bytes:
 *
 *  - the root is a compound with an empty name, uncompressed, big-endian,
 *  - strings are Java's modified UTF-8 (U+0000 and emoji differ from plain UTF-8),
 *  - an empty list has element type END,
 *  - the founder trophy carries its number in TrophyName at the ROOT of the tag
 *    (Simple Trophies moves a display Name there on the first tick anyway),
 *    TrophyEarnedAt is a long in epoch SECONDS,
 *  - the weekly head is minecraft:skull meta 3 with a SkullOwner string,
 *  - `nbt` passes Yggdrasil's base64 check.
 *
 * The bytes are read back with mc-nbt-lib's reader, a decoder this repo did not write.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { NBTReader } = require('mc-nbt-lib/nbt-core');
const nbt = require('../modules/nbtWriter');
const questRewards = require('../modules/questRewards');
const { seedDoc } = require('../scripts/seed-quest-event-dj2r');

// The give_item `nbt` check in yggdrasil/src/domains/biforesting/ops-catalog.ts.
const YGGDRASIL_NBT = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decodes base64 NBT into plain values: {type, value} pairs flattened, longs as BigInt. */
function decode(base64) {
    const tag = new NBTReader(Buffer.from(base64, 'base64')).readTag();
    assert.strictEqual(tag.type, 'compound');
    assert.strictEqual(tag.name, '', 'the root name is empty');
    return tag.value;
}

test('nbt: a one-byte compound encodes to the exact vanilla bytes', () => {
    const bytes = nbt.encode(nbt.compound({ a: nbt.byte(1) }));
    assert.deepStrictEqual([...bytes], [0x0a, 0x00, 0x00, 0x01, 0x00, 0x01, 0x61, 0x01, 0x00]);
});

test('nbt: every tag type round-trips through an independent reader', () => {
    const root = nbt.compound({
        b: nbt.byte(-2),
        s: nbt.short(300),
        i: nbt.int(-70000),
        l: nbt.long(1759190400n),
        str: nbt.string('Founder #7'),
        lore: nbt.list('string', ['one', 'two']),
        nested: nbt.compound({ id: nbt.string('minecraft:nether_star'), Count: nbt.byte(1) }),
        skipped: undefined
    });
    const value = new NBTReader(nbt.encode(root)).readTag().value;
    assert.deepStrictEqual(value.b, { type: 'byte', value: -2 });
    assert.deepStrictEqual(value.s, { type: 'short', value: 300 });
    assert.deepStrictEqual(value.i, { type: 'int', value: -70000 });
    assert.deepStrictEqual(value.l, { type: 'long', value: 1759190400n });
    assert.deepStrictEqual(value.str, { type: 'string', value: 'Founder #7' });
    assert.deepStrictEqual(value.lore, { type: 'list', value: { type: 'string', value: ['one', 'two'] } });
    assert.strictEqual(value.nested.value.id.value, 'minecraft:nether_star');
    assert.ok(!('skipped' in value), 'an undefined entry is left out');
});

test('nbt: an empty list is written with element type END and length 0', () => {
    const bytes = nbt.encode(nbt.compound({ x: nbt.list('string', []) }));
    // 0a 0000 | 09 0001 'x' | 00 00000000 | 00
    assert.deepStrictEqual([...bytes], [0x0a, 0, 0, 0x09, 0, 1, 0x78, 0x00, 0, 0, 0, 0, 0x00]);
});

test('nbt: strings are modified UTF-8, the way NBTTagString reads them', () => {
    assert.deepStrictEqual([...nbt.modifiedUtf8('A')], [0x41]);
    assert.deepStrictEqual([...nbt.modifiedUtf8('§')], [0xc2, 0xa7], 'the section sign is two bytes');
    assert.deepStrictEqual([...nbt.modifiedUtf8('\u0000')], [0xc0, 0x80], 'U+0000 is two bytes, never a zero byte');
    // U+1F600 is the surrogate pair D83D DE00, three bytes each. Plain UTF-8 would give four.
    assert.deepStrictEqual([...nbt.modifiedUtf8('\u{1F600}')], [0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]);
});

test('nbt: the root must be a compound', () => {
    assert.throws(() => nbt.encode(nbt.string('x')), /root must be a compound/);
});

const FOUNDER = seedDoc().founder.reward;
const WEEKLY = seedDoc().weeklyReward;

test('rewards: the founder trophy carries its number and Simple Trophies keys at the root', () => {
    const earnedAt = Date.UTC(2026, 9, 3, 12, 0, 0);
    const params = questRewards.rewardParams(FOUNDER, { n: 7, earnedAt });
    assert.strictEqual(params.id, 'simple_trophies:trophy');
    assert.strictEqual(params.meta, 0);
    assert.strictEqual(params.count, 1);
    assert.match(params.nbt, YGGDRASIL_NBT);

    const tag = decode(params.nbt);
    assert.deepStrictEqual(tag.TrophyName, { type: 'string', value: 'DJ2 Season 2 Founder #7' });
    assert.deepStrictEqual(tag.TrophyVariant, { type: 'string', value: 'classic' });
    assert.deepStrictEqual(tag.TrophyColorRed, { type: 'int', value: 255 });
    assert.deepStrictEqual(tag.TrophyColorGreen, { type: 'int', value: 190 });
    assert.deepStrictEqual(tag.TrophyColorBlue, { type: 'int', value: 0 });
    assert.deepStrictEqual(tag.TrophyEarnedAt, { type: 'long', value: BigInt(earnedAt / 1000) }, 'epoch seconds');
    assert.deepStrictEqual(tag.TrophyShowsTooltip, { type: 'byte', value: 1 });
    assert.deepStrictEqual(tag.TrophyItem.value, {
        id: { type: 'string', value: 'minecraft:nether_star' },
        Count: { type: 'byte', value: 1 },
        Damage: { type: 'short', value: 0 }
    });
    assert.deepStrictEqual(tag.display.value.Lore.value.value, ['One of the first players of DJ2 Season 2.']);
    assert.ok(!('Name' in tag.display.value), 'the name lives in TrophyName');
});

test('rewards: the weekly badge is a named player head with the week in name and lore', () => {
    const params = questRewards.rewardParams(WEEKLY, { week: 3 });
    assert.strictEqual(params.id, 'minecraft:skull');
    assert.strictEqual(params.meta, 3);
    assert.match(params.nbt, YGGDRASIL_NBT);

    const tag = decode(params.nbt);
    assert.deepStrictEqual(tag.SkullOwner, { type: 'string', value: 'AlpDerps' });
    assert.strictEqual(tag.display.value.Name.value, 'DJ2 Season 2 Week 3');
    assert.deepStrictEqual(tag.display.value.Lore.value.value, ['The community met the week 3 quest goal.']);
});

test('rewards: a spec with ready nbt passes it through untouched', () => {
    const params = questRewards.rewardParams({ id: 'minecraft:diamond', count: 2, nbt: 'CgAAAA==' });
    assert.deepStrictEqual(params, { id: 'minecraft:diamond', count: 2, nbt: 'CgAAAA==' });
});

test('rewards: a plain item with no name or lore gets no nbt', () => {
    assert.deepStrictEqual(questRewards.rewardParams({ id: 'minecraft:cake' }), { id: 'minecraft:cake', count: 1 });
});

test('rewards: a token with no value stays, and a spec without an id is refused', () => {
    assert.strictEqual(questRewards.fill('Founder #{n} {missing}', { n: 2 }), 'Founder #2 {missing}');
    assert.throws(() => questRewards.rewardParams({ name: 'x' }), /needs an item id/);
});
