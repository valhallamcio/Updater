/*
 * File: linkPanel.js
 * Project: valhalla-updater
 * -----
 * Keeps ONE panel message in #link with [Link account] and [My accounts]. The buttons
 * themselves are answered in discord/events/interactionCreate.js through
 * discord/commands/util/linkFlow.js, so they work whether this scheduler runs or not.
 *
 * The panel is posted once and then kept. Its message id is remembered in Mongo, so a
 * restart edits the same message. When that record is missing or points at a message
 * that is gone, the channel's recent and pinned messages are searched for a panel this
 * bot posted before it posts a new one, and any extra copy it finds is deleted. An edit
 * only goes out when the panel text changed, so the message does not show "(edited)"
 * after every boot.
 *
 * No channelId means one warning at startup and nothing else.
 */

const crypto = require('crypto');
const mongo = require('../modules/mongo');
const sessionLogger = require('../modules/sessionLogger');
const linkFlow = require('../discord/commands/util/linkFlow');

const LOG = 'LinkPanel';
const PANEL_KEY = 'linkPanel';
// Discord's cap for one history page.
const SCAN_LIMIT = 100;

// One pass at a time: a slow channel must not let the next interval post a second panel
// behind it.
let running = false;

/**
 * A stable fingerprint of the panel payload, so an unchanged panel is never edited.
 * @param {object} payload From linkFlow.buildPanel().
 * @returns {string} Hex sha1.
 */
function panelHash(payload) {
    const json = JSON.stringify({
        embeds: payload.embeds.map(e => (typeof e.toJSON === 'function' ? e.toJSON() : e)),
        components: payload.components.map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c))
    });
    return crypto.createHash('sha1').update(json).digest('hex');
}

module.exports = {
    name: 'linkPanel',
    defaultConfig: {
        "active": true,
        // minutes between checks that the panel is still there
        "interval": 60,
        "channelId": linkFlow.LINK_CHANNEL_ID
    },

    /**
     * Makes sure the panel exists, then checks on it every interval.
     * @param {object} options Scheduler config (`scheduler.linkPanel` in config.json).
     */
    start: async function (options) {
        const config = Object.assign({}, this.defaultConfig, options || {});

        if (!config.channelId) {
            sessionLogger.warn(LOG, 'Set the #link channel up in /config/config.json!');
            return;
        }

        const tick = () => this.ensurePanel(config).catch(error =>
            sessionLogger.error(LOG, 'Could not keep the #link panel (will try again next interval):', error.message));
        tick();
        setInterval(tick, Math.max(5, Number(config.interval) || 60) * 60 * 1000);
    },

    /**
     * Finds the panel, edits it when its text changed, or posts it when there is none.
     * @param {object} config Scheduler config.
     * @param {object} [deps] `{channel, botId}` - only tests pass them.
     * @returns {Promise<object>} `{action, messageId, removed}`; action is 'kept', 'edited',
     *     'posted', or 'skipped' with a reason.
     */
    ensurePanel: async function (config, deps = {}) {
        if (running) return { action: 'skipped', reason: 'in-flight' };
        running = true;
        try {
            let channel = deps.channel;
            let botId = deps.botId;
            if (!channel || !botId) {
                const { getClient } = require('../discord/bot');
                const client = await getClient();
                botId = botId || client.user.id;
                channel = channel || await client.channels.fetch(String(config.channelId)).catch(error => {
                    sessionLogger.error(LOG, `Could not fetch channel ${config.channelId}:`, error.message);
                    return null;
                });
            }
            if (!channel) return { action: 'skipped', reason: 'no-channel' };

            const payload = linkFlow.buildPanel();
            const hash = panelHash(payload);

            let stored = null;
            try {
                stored = await mongo.getDiscordPanel(PANEL_KEY);
            } catch (error) {
                sessionLogger.warn(LOG, 'Could not read the stored panel id; searching the channel instead', error.message);
            }

            let panel = null;
            let removed = 0;
            if (stored && stored.messageId && String(stored.channelId) === String(channel.id)) {
                const message = await channel.messages.fetch(String(stored.messageId)).catch(() => null);
                if (linkFlow.isPanelMessage(message, botId)) panel = message;
            }

            if (!panel) {
                const found = await this.findPanels(channel, botId);
                panel = found[0] || null;
                for (const extra of found.slice(1)) {
                    try {
                        await extra.delete();
                        removed++;
                    } catch (error) {
                        sessionLogger.warn(LOG, `Could not delete the extra panel ${extra.id}`, error.message);
                    }
                }
                // A panel found by search has no stored hash, so it is edited once.
                stored = null;
            }

            let action;
            if (panel) {
                if (stored && stored.hash === hash) {
                    return { action: 'kept', messageId: String(panel.id), removed };
                }
                await panel.edit(payload);
                action = 'edited';
            } else {
                panel = await channel.send(payload);
                action = 'posted';
            }

            try {
                await mongo.saveDiscordPanel(PANEL_KEY, { channelId: channel.id, messageId: panel.id, hash });
            } catch (error) {
                // The next pass finds the panel by searching the channel, so nothing is posted twice.
                sessionLogger.warn(LOG, 'Could not remember the panel id', error.message);
            }
            sessionLogger.info(LOG, `The #link panel was ${action} (${panel.id})`);
            return { action, messageId: String(panel.id), removed };
        } finally {
            running = false;
        }
    },

    /**
     * This bot's panel messages in the channel, oldest first. Looks at the pins and the
     * last page of history.
     * @param {object} channel A text channel.
     * @param {string} botId The bot's user id.
     * @returns {Promise<object[]>} Panel messages, no duplicates.
     */
    findPanels: async function (channel, botId) {
        const byId = new Map();
        const collect = (messages) => {
            if (!messages) return;
            for (const message of messages.values()) {
                if (linkFlow.isPanelMessage(message, botId)) byId.set(String(message.id), message);
            }
        };
        collect(await channel.messages.fetchPinned().catch(() => null));
        collect(await channel.messages.fetch({ limit: SCAN_LIMIT }).catch(() => null));
        return [...byId.values()].sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
    },

    panelHash: panelHash
};
