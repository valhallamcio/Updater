/*
 * File: mailDoc.js
 * Project: valhalla-updater
 * -----
 * Pure builder for the bifrost.mail doc /reply writes (the command loader only picks up
 * top-level files in commands/, so this util is never registered as a command).
 *
 * The proxy watches bifrost.mail with a change stream: an unread doc for an online player
 * is delivered inline within a second, otherwise it waits in their in-game inbox.
 */

const BODY_CAP = 500;
const DEFAULT_TTL_DAYS = 90;

/** Staff mail renders as MiniMessage on the wire — no clicks authored from Discord. */
function hasForbiddenTags(text) {
    return /<\s*(click|hover)\s*:/i.test(String(text || ''));
}

/**
 * Builds the mail doc for a staff reply.
 * @param {object} input { toUuid, toName, fromName, discordId, text, now, ttlDays }.
 * @returns {{ok: true, doc: object}|{ok: false, error: string}} The doc or why not.
 */
function buildMailDoc(input) {
    const now = input.now instanceof Date ? input.now : new Date();
    const ttlDays = typeof input.ttlDays === 'number' && input.ttlDays > 0 ? input.ttlDays : DEFAULT_TTL_DAYS;

    const to = String(input.toUuid || '').trim();
    if (!to) return { ok: false, error: 'No uuid for that player.' };

    const body = String(input.text || '').trim();
    if (!body) return { ok: false, error: 'Message is empty.' };
    if (body.length > BODY_CAP) return { ok: false, error: `Message is ${body.length} chars — the cap is ${BODY_CAP}.` };
    if (hasForbiddenTags(body)) return { ok: false, error: 'Message carries a `<click:>`/`<hover:>` tag — those are not authored from Discord.' };

    return {
        ok: true,
        doc: {
            to: to,
            toName: String(input.toName || ''),
            from: { uuid: null, name: String(input.fromName || 'staff') },
            kind: 'admin',
            body: body,
            sentAt: now,
            readAt: null,
            expiresAt: new Date(now.getTime() + ttlDays * 86400e3),
            meta: { via: 'discord', discordId: String(input.discordId || '') }
        }
    };
}

module.exports = { BODY_CAP, DEFAULT_TTL_DAYS, hasForbiddenTags, buildMailDoc };
