/*
 * File: questRewards.js
 * Project: valhalla-updater
 * -----
 * Turns a quest event reward spec into `give_item` params for a 1.12.2 backend.
 * The spec lives on the event doc (`founder.reward`, `weeklyReward`), so staff can
 * change an item without a deploy. Text fields take `{n}` (founder number) and
 * `{week}` (week number, from 1).
 *
 * Spec shape:
 *   { id, meta?, count?, name?, lore?: [..],
 *     trophy?: { variant?, color?: [r, g, b], displayItem?: { id, meta? }, showsTooltip? },
 *     skullOwner?, nbt? }
 *
 * Simple Trophies 1.2.2 (`simple_trophies:trophy`) keeps its data at the root of the
 * stack tag: TrophyName, TrophyVariant (classic, neon or gold), TrophyColorRed/Green/Blue
 * (int 0..255), TrophyItem (the stack it shows), TrophyEarnedAt (epoch SECONDS) and
 * TrophyShowsTooltip. It moves a display Name into TrophyName on the first inventory
 * tick, so the name goes straight to TrophyName.
 */

const nbt = require('./nbtWriter');

const TROPHY_ID = 'simple_trophies:trophy';

/** Puts `vars` into the `{key}` tokens. A token with no value stays as it is. */
function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (token, key) =>
        vars[key] === undefined || vars[key] === null ? token : String(vars[key]));
}

function clampColor(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : fallback;
}

function loreTag(lines, vars) {
    if (!Array.isArray(lines) || lines.length === 0) return undefined;
    return nbt.list('string', lines.map(line => fill(line, vars)));
}

function displayTag(spec, vars, withName) {
    const name = withName && spec.name ? nbt.string(fill(spec.name, vars)) : undefined;
    const lore = loreTag(spec.lore, vars);
    return name || lore ? nbt.compound({ Name: name, Lore: lore }) : undefined;
}

function trophyTag(spec, vars) {
    const trophy = spec.trophy || {};
    const color = Array.isArray(trophy.color) ? trophy.color : [];
    const shown = trophy.displayItem;
    return nbt.compound({
        TrophyName: spec.name ? nbt.string(fill(spec.name, vars)) : undefined,
        TrophyVariant: nbt.string(trophy.variant || 'classic'),
        TrophyColorRed: nbt.int(clampColor(color[0], 255)),
        TrophyColorGreen: nbt.int(clampColor(color[1], 255)),
        TrophyColorBlue: nbt.int(clampColor(color[2], 255)),
        TrophyItem: shown && shown.id
            ? nbt.compound({ id: nbt.string(shown.id), Count: nbt.byte(1), Damage: nbt.short(Number(shown.meta) || 0) })
            : undefined,
        TrophyEarnedAt: Number.isFinite(vars.earnedAt) ? nbt.long(Math.floor(vars.earnedAt / 1000)) : undefined,
        TrophyShowsTooltip: nbt.byte(trophy.showsTooltip === false ? 0 : 1),
        display: displayTag(spec, vars, false)
    });
}

/**
 * The `give_item` params for one reward, without `overflow`.
 * @param {object} spec The reward spec from the event doc.
 * @param {object} [vars] `{n, week, earnedAt}`. `earnedAt` is epoch ms.
 * @returns {{id: string, meta?: number, count: number, nbt?: string}} `nbt` is base64 binary NBT.
 */
function rewardParams(spec, vars = {}) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) throw new Error('A reward spec needs an item id');
    const params = { id: spec.id, count: Number.isInteger(spec.count) && spec.count > 0 ? spec.count : 1 };
    if (Number.isInteger(spec.meta)) params.meta = spec.meta;

    if (typeof spec.nbt === 'string' && spec.nbt) {
        params.nbt = spec.nbt;
        return params;
    }

    let tag;
    if (spec.trophy || spec.id === TROPHY_ID) {
        tag = trophyTag(spec, vars);
    } else if (spec.skullOwner) {
        tag = nbt.compound({ SkullOwner: nbt.string(fill(spec.skullOwner, vars)), display: displayTag(spec, vars, true) });
    } else {
        const display = displayTag(spec, vars, true);
        tag = display ? nbt.compound({ display }) : undefined;
    }
    if (tag) params.nbt = nbt.toBase64(tag);
    return params;
}

module.exports = { TROPHY_ID, fill, rewardParams };
