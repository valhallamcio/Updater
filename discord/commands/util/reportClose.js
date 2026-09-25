/*
 * File: reportClose.js
 * Project: valhalla-updater
 * -----
 * Pure helpers for `/reply ... report:<id>` (the command loader only picks up top-level
 * files in commands/, so this util is never registered as a command).
 *
 * A player files a report in game and the proxy stores it in bifrost.reports. Staff close it
 * in game with `/reports close <id> <note>`. /reply closes it with the same fields, so the
 * player's `/report list` shows the reply under the report. The id rules and the field shape
 * are copied from Bifrost src/plugins/support (store.ts `shortId`/`idMatches`/`truncate`,
 * index.ts `closeReport`). Change them there first.
 */

/** The proxy cuts a close note at 200 chars. The whole reply is still in /mail. */
const NOTE_CAP = 200;
/** How many of a player's newest reports a typed id is matched against (the proxy's ID_SCAN_LIMIT). */
const ID_SCAN_LIMIT = 500;
/** How much of a report the autocomplete quotes (the proxy's LIST_PREVIEW_CHARS). */
const PREVIEW_CHARS = 60;

/**
 * The last six characters of an ObjectId. The staff embed footer and `/report list` show it.
 * @param {*} id An ObjectId or its string form.
 * @returns {string} The short id.
 */
function shortId(id) {
    const text = String(id == null ? '' : id);
    return text.length <= 6 ? text : text.slice(-6);
}

/**
 * Does `candidate` name `id`? Either the whole id or a tail of four characters or more.
 * @param {*} id The report _id.
 * @param {string} candidate What staff typed.
 * @returns {boolean} True on a match.
 */
function idMatches(id, candidate) {
    const full = String(id == null ? '' : id).toLowerCase();
    const want = String(candidate || '').trim().toLowerCase().replace(/^#/, '');
    if (!want) return false;
    return full === want || (want.length >= 4 && full.endsWith(want));
}

/**
 * Reads the `report` option. `#2c4a87`, `2c4a87` and the full ObjectId all work.
 * @param {string|null} raw The option value.
 * @returns {null|{ok: true, id: string}|{ok: false}} Null when the option is absent.
 */
function parseReportId(raw) {
    if (raw == null || !String(raw).trim()) return null;
    const id = String(raw).trim().toLowerCase().replace(/^#/, '');
    return /^[0-9a-f]{4,24}$/.test(id) ? { ok: true, id: id } : { ok: false };
}

function truncate(text, max) {
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

/**
 * The `$set` of a report close, field for field what the proxy's `/reports close` writes.
 * @param {object} input { staffName, text, now }.
 * @returns {object} `{status, closedBy, closedAt, note}`. `note` is left out when the text is empty.
 */
function buildReportClose(input) {
    const note = truncate(String(input.text || '').replace(/[\r\n]+/g, ' ').trim(), NOTE_CAP);
    return {
        status: 'closed',
        closedBy: String(input.staffName || 'Staff'),
        closedAt: input.now instanceof Date ? input.now : new Date(),
        ...(note ? { note: note } : {})
    };
}

/**
 * One autocomplete choice: the short id and the first words of the report. The value is the
 * whole id, so two reports that share a tail can never be mixed up.
 * @param {object} doc A bifrost.reports doc with `_id` and `text`.
 * @returns {{name: string, value: string}} The choice.
 */
function reportChoice(doc) {
    const text = String(doc.text || '').replace(/\s+/g, ' ').trim();
    const quoted = text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS).trimEnd()}...`;
    return {
        name: truncate(`#${shortId(doc._id)} ${quoted}`.trim(), 100),
        value: String(doc._id)
    };
}

module.exports = { NOTE_CAP, ID_SCAN_LIMIT, shortId, idMatches, parseReportId, buildReportClose, reportChoice };
