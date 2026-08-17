/*
 * File: linkCode.js
 * Project: valhalla-updater
 * -----
 * The link-code rules and the two doc shapes /link and /unlink write, shared with the
 * proxy (Bifrost's discord-link `codes.ts` mints the codes). Codes are 6 Crockford
 * base32 chars - the alphabet drops I, L, O and U so a player reading one off a chat
 * card can't turn it into a different code by mistyping.
 *
 * Normalisation forgives what people actually type: lower case, spaces and dashes, and
 * the three lookalikes (O for zero, I and L for one). Anything else is simply not a code.
 * (The commands/ loader only picks up top-level files, so this util is never a command.)
 */

const CODE_LENGTH = 6;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * Folds what someone typed into the canonical code form.
 * @param {string} input Whatever came in on the slash command.
 * @returns {string} Upper-case, unspaced, lookalikes resolved (not necessarily valid).
 */
function normalizeCode(input) {
    return String(input == null ? '' : input)
        .toUpperCase()
        .replace(/[\s\-‐-―]+/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');
}

/**
 * Checks a normalised code against the alphabet and length.
 * @param {string} code A code from normalizeCode.
 * @returns {boolean} Whether it can exist at all.
 */
function isValidCode(code) {
    return CODE_RE.test(String(code == null ? '' : code));
}

/**
 * Builds the three fields the proxy reads off a bifrost.players doc. `discord_id` is a
 * STRING: a snowflake is past 2^53, so a JS number loses its last digits.
 * @param {object} input `{discordId, discordName, now}`.
 * @returns {object} The `$set` for the player doc.
 */
function buildLinkFields(input) {
    return {
        discord_id: String(input.discordId),
        discord_name: String(input.discordName || ''),
        discord_linked_at: input.now instanceof Date ? input.now : new Date()
    };
}

/**
 * Builds one row for bifrost.discord_link_audit. History only - the proxy never reads it.
 * @param {object} input `{uuid, discordId, action, discordName, actor, now}`.
 * @returns {object} The audit doc (`actor` only when someone unlinked another's account).
 */
function buildLinkAudit(input) {
    const doc = {
        uuid: String(input.uuid),
        discordId: String(input.discordId),
        action: input.action,
        by: 'discord',
        discordName: input.discordName == null ? null : String(input.discordName),
        at: input.now instanceof Date ? input.now : new Date()
    };
    if (input.actor && String(input.actor) !== doc.discordId) doc.actor = String(input.actor);
    return doc;
}

module.exports = { CODE_LENGTH, ALPHABET, normalizeCode, isValidCode, buildLinkFields, buildLinkAudit };
