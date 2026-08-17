/*
 * File: noticeDoc.js
 * Project: valhalla-updater
 * -----
 * Pure builders for bifrost.notices docs written by /notice (the command loader only
 * picks up top-level files in commands/, so this util is never registered as a command).
 *
 * The proxy re-validates every doc it reads and silently drops the ones that don't fit,
 * so the shapes here mirror Bifrost's notices store exactly: id charset and length,
 * the 48-char title cap, the 400-char body cap, and `card` (not `body`) for tips.
 */

/** Types /notice can author. `help` docs stay Mongo/seed-script authored. */
const NOTICE_TYPES = ['announcement', 'broadcast', 'pinned', 'known_issue', 'event', 'tip'];

/** Types the proxy shows as a titled board card — a title is not optional there. */
const TITLE_REQUIRED = ['pinned', 'known_issue', 'event'];

/** Id prefix per type (convention, not enforced by the proxy). */
const TYPE_PREFIX = {
    announcement: 'announcement',
    broadcast: 'broadcast',
    pinned: 'pinned',
    known_issue: 'issue',
    event: 'event',
    tip: 'tip'
};

/** Bifrost's `NOTICE_ID_RE` / `MAX_ID_LEN` / `NOTICE_TEXT_CAPS`. */
const NOTICE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_ID_LEN = 128;
const TITLE_CAP = 48;
const BODY_CAP = 400;

/** Client version -> protocol number, for targets.minProto / targets.maxProto. */
const VERSION_PROTOCOLS = {
    '1.7.10': 5,
    '1.8': 47,
    '1.8.9': 47,
    '1.12.2': 340,
    '1.16.5': 754,
    '1.18.2': 758,
    '1.19.2': 760,
    '1.20.1': 763,
    '1.20.4': 765,
    '1.21.1': 767
};

/**
 * Staff can't inject clicks from Discord: a `<click:>`/`<hover:>` in a body would run
 * as MiniMessage on the wire, and a newline inside a hover eats the rest of a 1.7.10 card.
 * @param {string} text Text to check.
 * @returns {boolean} True when the text carries a click or hover tag.
 */
function hasForbiddenTags(text) {
    return /<\s*(click|hover)\s*:/i.test(String(text || ''));
}

/**
 * Turns free text into an id-safe slug.
 * @param {string} text Title or body to slug.
 * @param {number} max Max slug length.
 * @returns {string} Slug, or '' when nothing survives.
 */
function slugify(text, max = 24) {
    return String(text || '')
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/g, '');
}

/**
 * Default id for a new notice: `<prefix>.<slug>-<base36 ts>`, unique per authoring.
 * @param {string} type Notice type.
 * @param {string} seed Title, or the body when there is no title.
 * @param {number} now Epoch ms (injected for tests).
 * @returns {string} A valid notice id.
 */
function defaultNoticeId(type, seed, now = Date.now()) {
    const prefix = TYPE_PREFIX[type] || 'notice';
    const slug = slugify(seed) || 'notice';
    return `${prefix}.${slug}-${now.toString(36)}`.slice(0, MAX_ID_LEN);
}

/**
 * Parses a `12h` / `3d` duration.
 * @param {string} input Duration string.
 * @returns {{ok: true, ms: number}|{ok: false, error: string}} Parsed duration.
 */
function parseDuration(input) {
    const match = /^\s*(\d{1,4})\s*([hd])\s*$/i.exec(String(input || ''));
    if (!match) return { ok: false, error: `\`${input}\` is not a duration — use \`12h\` or \`3d\`.` };
    const amount = parseInt(match[1], 10);
    if (amount <= 0) return { ok: false, error: 'Duration must be greater than 0.' };
    const unit = match[2].toLowerCase() === 'h' ? 3600e3 : 86400e3;
    return { ok: true, ms: amount * unit };
}

/**
 * Maps a client version to its protocol number.
 * @param {string} version Version string like `1.7.10`.
 * @returns {number|null} Protocol number, or null when unknown.
 */
function protocolFor(version) {
    const key = String(version || '').trim();
    return Object.prototype.hasOwnProperty.call(VERSION_PROTOCOLS, key) ? VERSION_PROTOCOLS[key] : null;
}

/**
 * Splits the `tags` option into targets.tags.
 * @param {string} input Comma-separated tag list.
 * @returns {string[]} Trimmed, lower-cased, de-duplicated tags.
 */
function parseTags(input) {
    const tags = String(input || '')
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);
    return [...new Set(tags)];
}

/**
 * Builds the doc /notice create writes. Every rejection is a message staff can act on.
 * @param {object} input Command options plus `updatedBy` and `now` (a Date).
 * @returns {{ok: true, doc: object}|{ok: false, error: string}} The doc or why not.
 */
function buildNoticeDoc(input) {
    const now = input.now instanceof Date ? input.now : new Date();
    const type = String(input.type || '');
    if (!NOTICE_TYPES.includes(type)) return { ok: false, error: `Unknown type \`${type}\`.` };

    const body = String(input.body || '').trim();
    if (!body) return { ok: false, error: 'Body is empty.' };
    if (body.length > BODY_CAP) return { ok: false, error: `Body is ${body.length} chars — the cap is ${BODY_CAP}.` };
    if (hasForbiddenTags(body)) return { ok: false, error: 'Body carries a `<click:>`/`<hover:>` tag — those are not authored from Discord.' };

    const title = input.title ? String(input.title).trim() : '';
    if (TITLE_REQUIRED.includes(type) && !title) return { ok: false, error: `A \`${type}\` needs a title.` };
    if (title.length > TITLE_CAP) return { ok: false, error: `Title is ${title.length} chars — the cap is ${TITLE_CAP}.` };
    if (title && hasForbiddenTags(title)) return { ok: false, error: 'Title carries a `<click:>`/`<hover:>` tag.' };

    let id = input.id ? String(input.id).trim().toLowerCase() : '';
    if (id) {
        if (!NOTICE_ID_RE.test(id) || id.length > MAX_ID_LEN) {
            return { ok: false, error: `\`${id}\` is not a valid id — lower-case letters, digits, \`.\`, \`_\`, \`-\`, max ${MAX_ID_LEN}.` };
        }
    } else {
        id = defaultNoticeId(type, title || body, now.getTime());
    }

    const targets = {};
    const tags = parseTags(input.tags);
    if (tags.length) targets.tags = tags;
    if (typeof input.newOnly === 'boolean') targets.newPlayersOnly = input.newOnly;
    if (input.minVersion) {
        const proto = protocolFor(input.minVersion);
        if (proto === null) return { ok: false, error: `Unknown min_version \`${input.minVersion}\`. Known: ${Object.keys(VERSION_PROTOCOLS).join(', ')}.` };
        targets.minProto = proto;
    }
    if (input.maxVersion) {
        const proto = protocolFor(input.maxVersion);
        if (proto === null) return { ok: false, error: `Unknown max_version \`${input.maxVersion}\`. Known: ${Object.keys(VERSION_PROTOCOLS).join(', ')}.` };
        targets.maxProto = proto;
    }

    const doc = { id: id, type: type, enabled: true };
    if (title) doc.title = title;
    // A tip is a guide card override, and the proxy reads that text from `card`.
    if (type === 'tip') doc.card = { en: body };
    else doc.body = { en: body };
    if (Object.keys(targets).length) doc.targets = targets;
    doc.buttons = [];

    if (input.starts) {
        const parsed = parseDuration(input.starts);
        if (!parsed.ok) return { ok: false, error: `starts: ${parsed.error}` };
        doc.startsAt = new Date(now.getTime() + parsed.ms);
    }
    if (input.expires) {
        const parsed = parseDuration(input.expires);
        if (!parsed.ok) return { ok: false, error: `expires: ${parsed.error}` };
        const at = new Date(now.getTime() + parsed.ms);
        if (type === 'event') doc.endsAt = at;
        else doc.expiresAt = at;
    } else if (type === 'event') {
        return { ok: false, error: 'An `event` needs `expires` (when it ends), e.g. `3d`.' };
    }

    doc.createdAt = now;
    doc.updatedAt = now;
    doc.updatedBy = input.updatedBy || 'discord';
    doc.note = input.note || 'created via /notice';
    return { ok: true, doc: doc };
}

module.exports = {
    NOTICE_TYPES,
    TITLE_REQUIRED,
    TYPE_PREFIX,
    NOTICE_ID_RE,
    MAX_ID_LEN,
    TITLE_CAP,
    BODY_CAP,
    VERSION_PROTOCOLS,
    hasForbiddenTags,
    slugify,
    defaultNoticeId,
    parseDuration,
    protocolFor,
    parseTags,
    buildNoticeDoc
};
