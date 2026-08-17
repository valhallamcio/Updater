/*
 * File: notices.js
 * Project: valhalla-updater
 * -----
 * The automated half of bifrost.notices: right now one `event` card per finished pack
 * update, so a player who joins on the old client version is told to restart their
 * launcher instead of finding out from a mismatch screen.
 *
 * Nothing here may fail or delay an update — every path swallows its own errors.
 */

const mongo = require('./mongo');
const sessionLogger = require('./sessionLogger');

const TITLE_CAP = 48;
const EVENT_DAYS = 3;

/**
 * Reads the feature gate. Missing config = on: the card is the point of the wave.
 * @returns {boolean} Whether pack-update events are posted.
 */
function enabled() {
    try {
        const config = require('../config/config.json');
        if (config.notices && config.notices.packUpdateEvents === false) return false;
    } catch (_) { /* no config = default on */ }
    return true;
}

/** Ids are `[a-z0-9._-]` on the proxy side; a tag with anything else is folded to '-'. */
function idSafe(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function yyyymmdd(date) {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Builds the event doc for a finished pack update. One doc per tag per day, so a
 * re-run of the same update updates the card instead of stacking a second one.
 * @param {object} input { tag, name, version, now }.
 * @returns {object|null} The notice doc, or null when there is no tag to target.
 */
function packUpdateEventDoc(input) {
    const now = input.now instanceof Date ? input.now : new Date();
    const tag = idSafe(input.tag);
    if (!tag) return null;

    const name = String(input.name || tag);
    const version = String(input.version || '').trim();
    const title = `${name} updated${version ? ` to ${version}` : ''}`;

    return {
        id: `event.update.${tag}.${yyyymmdd(now)}`,
        type: 'event',
        enabled: true,
        title: title.length > TITLE_CAP ? `${title.slice(0, TITLE_CAP - 3).trimEnd()}...` : title,
        body: { en: 'Restart your launcher to update. Details in Discord #announcements.' },
        targets: { tags: [tag] },
        startsAt: now,
        endsAt: new Date(now.getTime() + EVENT_DAYS * 86400e3),
        createdAt: now,
        updatedAt: now,
        updatedBy: 'updateManager',
        note: 'auto: pack update'
    };
}

/**
 * Posts the in-game "pack updated" card. Fire-and-forget: never throws, never rejects.
 * The changelog link stays in Discord - the in-game card is one line and no clicks.
 * @param {object} input { tag, name, version, changelogUrl }.
 * @returns {Promise<boolean>} True when a doc was written.
 */
async function postPackUpdateEvent(input) {
    try {
        if (!enabled()) return false;
        const doc = packUpdateEventDoc(input || {});
        if (!doc) return false;
        await mongo.upsertNotice(doc);
        sessionLogger.info('Notices', `Posted in-game update event ${doc.id}`);
        return true;
    } catch (error) {
        sessionLogger.warn('Notices', `Failed to post the in-game update event: ${error.message}`);
        return false;
    }
}

module.exports = { enabled, packUpdateEventDoc, postPackUpdateEvent };
