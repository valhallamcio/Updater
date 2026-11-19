/*
 * File: imageScamFilter.js
 * Project: valhalla-updater
 * -----
 * Hacked Discord accounts post scam images: celebrity crypto casino ads, "activate code
 * BONUS" pages, fake withdrawal or wallet screenshots. This scores every image a guild
 * member posts with SubQ Snap (modules/scamImages.js). A score at or over the threshold
 * deletes the message, times the author out and posts a card to the alert channel. In log
 * mode the card is the only action.
 *
 * Such an account posts the same scam in many channels at once. After a hit the author is
 * remembered for rememberMinutes: a later message with an image or a link goes without a new
 * SubQ call, and the card is edited, never posted again. Right after the hit, a sweep deletes
 * the author's messages of the last sweepMinutes in every text channel the bot can read. It
 * reads the message cache first, and fetches one page of recent messages only where the cache
 * does not reach back far enough. The card counts every deleted message and channel.
 *
 * Bots, webhooks, staff (Manage Messages or a staff role) and the ignored channels (or their
 * category or parent) are skipped. A message is scored once per image and acted on once.
 * The filter fails open: a SubQ error or timeout lets the message through with a warn line,
 * and a run of failures posts one notice to the alert channel per hour at most.
 *
 * It needs the GuildMessages and MessageContent intents (discord/bot.js asks for them while
 * this is active) and SUBQ_API_KEY in .env. With no key or no alert channel it warns once
 * and stays off.
 */

const axios = require('axios');
const {
    AttachmentBuilder,
    EmbedBuilder,
    GatewayIntentBits,
    PermissionFlagsBits,
    SnowflakeUtil,
    escapeMarkdown
} = require('discord.js');
const scamImages = require('../modules/scamImages');
const subq = require('../modules/subq');
const sessionLogger = require('../modules/sessionLogger');

const LOG = 'ImageScamFilter';
const NO_MENTIONS = { parse: [] };
const COLOUR = { enforce: 0xe74c3c, log: 0xe67e22 };

// Discord allows 10 attachments. Eight images are two SubQ requests at most.
const MAX_IMAGES = 8;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10000;
// The SubQ key allows 10 requests at once and Bifrost's chat guard uses the same key.
const SUBQ_CONCURRENCY = 3;
const SUBQ_QUEUE_MAX = 50;
const FAILURE_ALERT_AFTER = 3;
const FAILURE_ALERT_EVERY_MS = 60 * 60 * 1000;
// Discord caps a timeout at 28 days.
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const SWEEP_MAX_CHANNELS = 50;
const SWEEP_FETCH_LIMIT = 100;
const SWEEP_BUDGET_MS = 60000;
const SEEN_MAX = 5000;
const DISCORD_HOST = /^https:\/\/([a-z0-9-]+\.)*(discordapp\.(com|net)|discord\.com)\//i;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i;
const LINK = /https?:\/\/|discord(app)?\.(gg|com\/invite)\/|\bwww\.[a-z0-9-]+\./i;
const UNKNOWN_MESSAGE = 10008;

// message id -> {keys: Set of scored image keys, acted}
const seen = new Map();
// "guildId:userId" -> incident (see act)
const incidents = new Map();
const failures = { count: 0, alertedAt: -Infinity };
let active = 0;
const queue = [];

/**
 * Runs a SubQ call when one of the SUBQ_CONCURRENCY slots is free.
 * @param {function(): Promise} task The call.
 * @returns {Promise} Its result. Rejects at once when the queue is full.
 */
function limit(task) {
    if (active >= SUBQ_CONCURRENCY && queue.length >= SUBQ_QUEUE_MAX) {
        return Promise.reject(new Error('SubQ queue is full (' + SUBQ_QUEUE_MAX + ' waiting)'));
    }
    return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
    });
}

function drain() {
    while (active < SUBQ_CONCURRENCY && queue.length) {
        const { task, resolve, reject } = queue.shift();
        active++;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
            active--;
            drain();
        });
    }
}

/**
 * The images of a message that the filter can score: image attachments, and the image of an
 * image, gifv or rich embed. A link preview thumbnail (article, video) is left out, so a
 * YouTube thumbnail is not scored. Embeds are fetched through Discord's media proxy only.
 * @param {object} message A discord.js message.
 * @returns {Array<{key: string, name: string, url: string, size: number|null}>}
 */
function collectImages(message) {
    const images = [];
    for (const attachment of message.attachments ? message.attachments.values() : []) {
        const type = String(attachment.contentType || '');
        const isImage = type ? type.startsWith('image/') && !type.includes('svg') : IMAGE_NAME.test(attachment.name || '');
        if (!isImage || !DISCORD_HOST.test(attachment.url || '')) continue;
        images.push({ key: 'a:' + attachment.id, name: attachment.name || attachment.id, url: attachment.url, size: attachment.size || null });
    }
    for (const embed of message.embeds || []) {
        const type = embed.data ? embed.data.type : embed.type;
        const picture = type === 'rich' ? embed.image : (type === 'image' || type === 'gifv') ? (embed.image || embed.thumbnail) : null;
        const url = picture && picture.proxyURL;
        if (!url || !DISCORD_HOST.test(url)) continue;
        images.push({ key: 'e:' + url, name: (embed.url || url).split('?')[0].split('/').pop() || 'embed', url, size: null });
    }
    return images;
}

function hasImagesOrLinks(message) {
    return collectImages(message).length > 0 || (message.embeds || []).length > 0 || LINK.test(message.content || '');
}

function lastActivity(channel) {
    return channel.lastMessageId ? SnowflakeUtil.timestampFrom(channel.lastMessageId) : 0;
}

function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
}

function stamp(ms) {
    const s = Math.floor(ms / 1000);
    return '<t:' + s + ':d> (<t:' + s + ':R>)';
}

function minutesText(minutes) {
    if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
    if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
    return plural(minutes, 'minute');
}

function trim(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

module.exports = {
    name: 'imageScamFilter',
    defaultConfig: {
        // first, so the config check skips the empty alertChannelId while this is off
        "active": false,
        // "enforce" deletes and times out, "log" only posts the card
        "mode": "enforce",
        "threshold": 0.3,
        "timeoutMinutes": 1440,
        "alertChannelId": "",
        // a category id covers every channel in it, a channel id covers its threads
        "ignoreChannelIds": [],
        // Manage Messages counts as staff too
        "staffRoleIds": [],
        "rememberMinutes": 30,
        "sweepMinutes": 10,
        "requestTimeoutMs": 15000
    },

    /**
     * The config with defaults filled in and the numbers checked.
     * @param {object} options scheduler.imageScamFilter from config.json.
     * @returns {object}
     */
    settings: function (options) {
        const config = Object.assign({}, this.defaultConfig, options || {});
        if (config.mode !== 'enforce' && config.mode !== 'log') {
            sessionLogger.warn(LOG, 'Unknown mode "' + config.mode + '", using log mode');
            config.mode = 'log';
        }
        const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
        config.threshold = number(config.threshold, 0.3);
        config.timeoutMinutes = Math.min(Math.max(1, number(config.timeoutMinutes, 1440)), MAX_TIMEOUT_MINUTES);
        config.rememberMinutes = Math.max(0, number(config.rememberMinutes, 30));
        config.sweepMinutes = Math.max(0, number(config.sweepMinutes, 10));
        config.requestTimeoutMs = Math.max(1000, number(config.requestTimeoutMs, 15000));
        config.ignoreChannelIds = (config.ignoreChannelIds || []).map(String);
        config.staffRoleIds = (config.staffRoleIds || []).map(String);
        return config;
    },

    /**
     * Hooks the filter onto new and edited guild messages.
     * @param {object} options Scheduler config (scheduler.imageScamFilter in config.json).
     */
    start: async function (options) {
        const config = this.settings(options);
        if (!process.env.SUBQ_API_KEY) {
            sessionLogger.warn(LOG, 'SUBQ_API_KEY is not set in .env, so the image scam filter is off');
            return;
        }
        if (!config.alertChannelId) {
            sessionLogger.warn(LOG, 'Set scheduler.imageScamFilter.alertChannelId in /config/config.json! The image scam filter is off');
            return;
        }
        this.subq = subq.createClient({ apiKey: process.env.SUBQ_API_KEY, timeoutMs: config.requestTimeoutMs });

        const client = await this.getClient();
        const intents = client.options && client.options.intents;
        if (intents && !(intents.has(GatewayIntentBits.GuildMessages) && intents.has(GatewayIntentBits.MessageContent))) {
            sessionLogger.warn(LOG, 'The bot has no GuildMessages or MessageContent intent, so the image scam filter sees no images');
        }

        const check = message => this.onMessage(message, config).catch(error =>
            sessionLogger.error(LOG, 'Image scam check failed:', error.message));
        client.on('messageCreate', check);
        // Discord adds a link's embed a moment after the message, in an update.
        client.on('messageUpdate', (before, after) => check(after));
        sessionLogger.info(LOG, 'Image scam filter on (' + config.mode + ' mode, threshold ' + config.threshold + ')');
    },

    /**
     * Checks one message. Never throws for a SubQ failure.
     * @param {object} message A discord.js message.
     * @param {object} config Output of settings().
     * @param {object} [deps] {subq, fetchImage, alertChannel, now} - only tests pass them.
     * @returns {Promise<object>} What happened: {skipped}, {failed}, {score, kind}, {burst} or {acted, incident}.
     */
    onMessage: async function (message, config, deps = {}) {
        const now = deps.now || Date.now;
        if (!message || message.partial || !message.author || !message.inGuild || !message.inGuild()) return { skipped: 'not-guild' };
        if (message.author.bot || message.webhookId || message.system) return { skipped: 'bot' };
        if (this.isIgnored(message.channel, config)) return { skipped: 'ignored-channel' };
        const member = message.member;
        if (this.isStaff(member, config)) return { skipped: 'staff' };

        const incident = this.activeIncident(message.guildId, message.author.id, now());
        if (incident) {
            if (seen.has(message.id) && seen.get(message.id).acted) return { skipped: 'acted' };
            if (!hasImagesOrLinks(message)) return { skipped: 'no-images-or-links' };
            await this.removeBurstMessage(message, incident, deps);
            return { burst: true, incident };
        }

        const images = collectImages(message);
        if (!images.length) return { skipped: 'no-images' };
        // State is kept only for messages with images, so chat does not push it out.
        const state = this.seenState(message.id);
        if (state.acted) return { skipped: 'acted' };
        const found = images
            .filter(image => !state.keys.has(image.key))
            .slice(0, Math.max(0, MAX_IMAGES - state.keys.size));
        if (!found.length) return { skipped: 'no-new-images' };
        for (const image of found) state.keys.add(image.key);

        const client = deps.subq || this.subq;
        if (!client) return { skipped: 'no-client' };

        const loaded = await this.loadImages(found, deps);
        if (!loaded.length) return { skipped: 'unreadable' };

        let result = null;
        try {
            for (let i = 0; i < loaded.length; i += scamImages.MAX_PER_REQUEST) {
                const body = scamImages.buildRequest(loaded.slice(i, i + scamImages.MAX_PER_REQUEST));
                const answer = scamImages.readAnswer(await limit(() => client.decide(body)));
                if (!result || answer.score > result.score) result = answer;
                if (answer.score >= config.threshold) break;
            }
        } catch (error) {
            await this.noteFailure(error, config, deps);
            return { failed: error.message };
        }
        failures.count = 0;

        sessionLogger.debug(LOG, 'Message ' + message.id + ' from ' + message.author.id + ': ' + plural(loaded.length, 'image') + ', score ' + result.score.toFixed(3));
        if (result.score < config.threshold) return { score: result.score, kind: result.kind };

        // Another message of the same burst can have been hit while this one was scored.
        const raced = this.activeIncident(message.guildId, message.author.id, now());
        if (raced) {
            await this.removeBurstMessage(message, raced, deps);
            return { burst: true, incident: raced, score: result.score };
        }
        if (state.acted) return { skipped: 'acted' };
        state.acted = true;
        return this.act(message, member, result, loaded, config, deps);
    },

    /**
     * Downloads and prepares the images. One that fails is left out with a warn line.
     * @returns {Promise<Array<{name: string, fileName: string, mediaType: string, buffer: Buffer}>>}
     */
    loadImages: async function (found, deps) {
        const fetchImage = deps.fetchImage || this.fetchImage;
        const loaded = await Promise.all(found.map(async (image, index) => {
            if (image.size && image.size > MAX_DOWNLOAD_BYTES) {
                sessionLogger.warn(LOG, 'Skipped image ' + image.name + ': ' + image.size + ' bytes is over the limit');
                return null;
            }
            try {
                const prepared = await scamImages.prepareImage(await fetchImage(image.url));
                const base = String(image.name).replace(/\.[^.]*$/, '').replace(/[^\w.-]/g, '_').slice(0, 60) || 'image';
                return Object.assign(prepared, { name: image.name, fileName: (index + 1) + '-' + base + '.' + scamImages.EXTENSIONS[prepared.mediaType] });
            } catch (error) {
                sessionLogger.warn(LOG, 'Skipped image ' + image.name + ': ' + error.message);
                return null;
            }
        }));
        return loaded.filter(Boolean);
    },

    /**
     * @param {string} url A Discord CDN or media proxy URL.
     * @returns {Promise<Buffer>}
     */
    fetchImage: async function (url) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: DOWNLOAD_TIMEOUT_MS,
            maxContentLength: MAX_DOWNLOAD_BYTES
        });
        return Buffer.from(response.data);
    },

    /**
     * The hit: delete, time out, post the card, sweep the burst, edit the card with the count.
     * The incident is stored before the first await, so a racing message of the same author
     * finds it and is handled as part of the burst.
     */
    act: async function (message, member, result, images, config, deps) {
        const now = deps.now || Date.now;
        const at = now();
        const incident = {
            key: message.guildId + ':' + message.author.id,
            userId: message.author.id,
            userTag: message.author.tag || message.author.username || message.author.id,
            createdAt: message.author.createdTimestamp,
            joinedAt: member ? member.joinedTimestamp : null,
            channelId: message.channelId,
            messageId: message.id,
            messageUrl: message.url,
            content: message.content || '',
            imageNames: images.map(image => image.name),
            label: result.label,
            kind: result.kind,
            score: result.score,
            threshold: config.threshold,
            enforce: config.mode === 'enforce',
            sweepMinutes: config.sweepMinutes,
            at,
            until: at + config.rememberMinutes * 60000,
            actions: [],
            deleted: new Set(),
            channels: new Set(),
            deleteFailures: 0,
            sweep: { state: config.sweepMinutes > 0 ? 'pending' : 'off' },
            alertMessage: null,
            editing: null,
            dirty: false
        };
        for (const [key, old] of incidents) if (old.until <= at) incidents.delete(key);
        incidents.set(incident.key, incident);

        if (incident.enforce) {
            try {
                await message.delete();
                this.count(incident, message.id, message.channelId);
                incident.actions.push('Message deleted');
            } catch (error) {
                incident.deleteFailures++;
                incident.actions.push('Delete failed: ' + error.message);
            }
            incident.actions.push(await this.timeoutMember(member, result, config));
        } else {
            this.count(incident, message.id, message.channelId);
            incident.actions.push('Log mode: nothing deleted, no timeout. [Jump to the message](' + message.url + ')');
        }

        const channel = deps.alertChannel || await this.getChannel(config.alertChannelId);
        if (channel) {
            try {
                incident.alertMessage = await channel.send({
                    ...this.buildAlert(incident),
                    files: images.slice(0, 4).map(image => new AttachmentBuilder(image.buffer, { name: image.fileName }))
                });
            } catch (error) {
                sessionLogger.error(LOG, 'Could not post the image scam card:', error.message);
            }
        }

        sessionLogger.warn(LOG, 'Image scam from ' + incident.userTag + ' (' + incident.userId + ') in ' + incident.channelId + ': ' +
            incident.label + ', score ' + result.score.toFixed(3) + '. ' + incident.actions.join('; '));

        if (config.sweepMinutes > 0) {
            try {
                await this.sweep(message.guild, incident, config, deps);
            } catch (error) {
                incident.sweep = { state: 'failed', error: error.message };
                sessionLogger.error(LOG, 'The burst sweep failed:', error.message);
            }
            await this.refreshAlert(incident);
        }
        return { acted: true, incident };
    },

    /**
     * @returns {Promise<string>} The action line for the card.
     */
    timeoutMember: async function (member, result, config) {
        if (!member || typeof member.timeout !== 'function') return 'Timeout failed: the member is not in the server';
        if (member.isCommunicationDisabled && member.isCommunicationDisabled()) {
            return 'Already timed out until ' + stamp(member.communicationDisabledUntilTimestamp);
        }
        const reason = 'Image scam filter: ' + result.label + ', score ' + result.score.toFixed(2);
        try {
            await member.timeout(config.timeoutMinutes * 60000, reason);
            return 'Timed out for ' + minutesText(config.timeoutMinutes);
        } catch (error) {
            return 'Timeout failed: ' + error.message;
        }
    },

    /**
     * Deletes a later message of a remembered author (log mode: counts it) and edits the card.
     */
    removeBurstMessage: async function (message, incident, deps) {
        const state = this.seenState(message.id);
        if (state.acted) return;
        state.acted = true;
        if (incident.deleted.has(message.id)) return;
        if (incident.enforce) {
            try {
                await message.delete();
                this.count(incident, message.id, message.channelId);
            } catch (error) {
                if (error.code !== UNKNOWN_MESSAGE) {
                    incident.deleteFailures++;
                    sessionLogger.warn(LOG, 'Could not delete burst message ' + message.id + ':', error.message);
                }
            }
        } else {
            this.count(incident, message.id, message.channelId);
        }
        await this.refreshAlert(incident);
    },

    /**
     * Deletes (log mode: counts) the author's messages of the last sweepMinutes in every text
     * channel with activity in that window. Bounded by SWEEP_MAX_CHANNELS, one fetch of
     * SWEEP_FETCH_LIMIT messages per channel, and SWEEP_BUDGET_MS. discord.js queues the
     * requests by Discord's rate limits.
     */
    sweep: async function (guild, incident, config, deps) {
        const now = deps.now || Date.now;
        const started = now();
        const since = incident.at - config.sweepMinutes * 60000;
        const me = guild && guild.members ? guild.members.me : null;
        const channels = [];
        for (const channel of guild && guild.channels ? guild.channels.cache.values() : []) {
            if (typeof channel.isTextBased !== 'function' || !channel.isTextBased() || !channel.messages) continue;
            if (this.isIgnored(channel, config) || lastActivity(channel) < since) continue;
            if (me && typeof channel.permissionsFor === 'function') {
                const permissions = channel.permissionsFor(me);
                if (!permissions || !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
            }
            channels.push(channel);
        }
        channels.sort((a, b) => lastActivity(b) - lastActivity(a));

        const sweep = incident.sweep = {
            state: 'running',
            channels: Math.min(channels.length, SWEEP_MAX_CHANNELS),
            skipped: Math.max(0, channels.length - SWEEP_MAX_CHANNELS),
            fetched: 0,
            failed: 0
        };
        for (const channel of channels.slice(0, SWEEP_MAX_CHANNELS)) {
            if (now() - started > SWEEP_BUDGET_MS) {
                sweep.state = 'stopped';
                break;
            }
            try {
                const ids = await this.findBurst(channel, incident, since, sweep);
                if (ids.length) await this.deleteMany(channel, ids, incident);
            } catch (error) {
                sweep.failed++;
                sessionLogger.warn(LOG, 'Burst sweep of channel ' + channel.id + ' failed:', error.message);
            }
        }
        if (sweep.state === 'running') sweep.state = 'done';
        return sweep;
    },

    /**
     * The author's message ids in one channel since a time, from the cache, plus one fetch
     * when the cache does not reach back to that time.
     */
    findBurst: async function (channel, incident, since, sweep) {
        const ids = new Set();
        const pick = messages => {
            for (const message of messages.values()) {
                if (message.author && message.author.id === incident.userId && message.createdTimestamp >= since && !incident.deleted.has(message.id)) {
                    ids.add(message.id);
                }
            }
        };
        const cache = channel.messages.cache;
        pick(cache);
        let oldest = Infinity;
        for (const message of cache.values()) oldest = Math.min(oldest, message.createdTimestamp);
        if (oldest > since) {
            sweep.fetched++;
            pick(await channel.messages.fetch({ limit: SWEEP_FETCH_LIMIT }));
        }
        return [...ids];
    },

    deleteMany: async function (channel, ids, incident) {
        if (!incident.enforce) {
            for (const id of ids) this.count(incident, id, channel.id);
            return;
        }
        if (ids.length === 1 || typeof channel.bulkDelete !== 'function') {
            for (const id of ids) {
                try {
                    await channel.messages.delete(id);
                    this.count(incident, id, channel.id);
                } catch (error) {
                    if (error.code !== UNKNOWN_MESSAGE) incident.deleteFailures++;
                }
            }
            return;
        }
        for (let i = 0; i < ids.length; i += 100) {
            const removed = await channel.bulkDelete(ids.slice(i, i + 100), true);
            for (const id of removed.keys()) this.count(incident, id, channel.id);
        }
    },

    count: function (incident, messageId, channelId) {
        incident.deleted.add(messageId);
        incident.channels.add(channelId);
    },

    /**
     * Edits the card to the incident's current state. Edits run one at a time, and the
     * changes that come in while one runs go out in one more edit.
     */
    refreshAlert: function (incident) {
        if (!incident.alertMessage) return Promise.resolve();
        if (incident.editing) {
            incident.dirty = true;
            return incident.editing;
        }
        incident.editing = (async () => {
            do {
                incident.dirty = false;
                try {
                    await incident.alertMessage.edit(this.buildAlert(incident));
                } catch (error) {
                    sessionLogger.warn(LOG, 'Could not edit the image scam card:', error.message);
                }
            } while (incident.dirty);
            incident.editing = null;
        })();
        return incident.editing;
    },

    /**
     * The staff card. Player text cannot mention anybody or format the card.
     * @returns {{embeds: Array, allowedMentions: object}}
     */
    buildAlert: function (incident) {
        const mode = incident.enforce ? 'enforce' : 'log';
        const sweep = incident.sweep;
        const sweepLine = {
            off: 'No sweep (sweepMinutes is 0)',
            pending: 'Sweep of the last ' + incident.sweepMinutes + ' min: starting',
            running: 'Sweep of the last ' + incident.sweepMinutes + ' min: running',
            done: 'Sweep of the last ' + incident.sweepMinutes + ' min: ' + plural(sweep.channels || 0, 'channel') + ' checked',
            stopped: 'Sweep of the last ' + incident.sweepMinutes + ' min: stopped at the time limit',
            failed: 'Sweep failed: ' + (sweep.error || '')
        }[sweep.state] || '';
        const notes = [];
        if (sweep.skipped) notes.push(plural(sweep.skipped, 'channel') + ' over the sweep limit not checked');
        if (sweep.failed) notes.push(plural(sweep.failed, 'channel') + ' could not be swept');
        if (incident.deleteFailures) notes.push(plural(incident.deleteFailures, 'delete') + ' failed');
        const total = plural(incident.deleted.size, 'message') + ' in ' + plural(incident.channels.size, 'channel');
        const text = incident.content ? trim(escapeMarkdown(incident.content), 1000) : '*(no text)*';

        const embed = new EmbedBuilder()
            .setColor(COLOUR[mode])
            .setTitle(trim('Image scam: ' + incident.label, 256))
            .setDescription(text)
            .addFields(
                { name: 'User', value: '<@' + incident.userId + '> \u0060' + incident.userId + '\u0060\n' + trim(escapeMarkdown(incident.userTag), 100), inline: true },
                { name: 'Account created', value: incident.createdAt ? stamp(incident.createdAt) : 'unknown', inline: true },
                { name: 'Joined the server', value: incident.joinedAt ? stamp(incident.joinedAt) : 'unknown', inline: true },
                { name: 'Channel', value: '<#' + incident.channelId + '>', inline: true },
                { name: 'Scam kind', value: incident.label, inline: true },
                { name: 'Score', value: incident.score.toFixed(3) + ' (threshold ' + incident.threshold + ')', inline: true },
                { name: 'Images', value: trim(incident.imageNames.map(name => escapeMarkdown(String(name))).join('\n') || 'none', 1024) },
                { name: 'Action', value: trim(incident.actions.join('\n') || 'none', 1024) },
                { name: incident.enforce ? 'Deleted' : 'Seen (log mode, not deleted)', value: trim([total, sweepLine].concat(notes).filter(Boolean).join('\n'), 1024) }
            )
            .setFooter({ text: 'message ' + incident.messageId + ' | ' + mode + ' mode' })
            .setTimestamp(incident.at);
        return { embeds: [embed], allowedMentions: NO_MENTIONS };
    },

    /**
     * Logs a SubQ failure. After FAILURE_ALERT_AFTER failures in a row it tells the alert
     * channel, once per FAILURE_ALERT_EVERY_MS.
     */
    noteFailure: async function (error, config, deps) {
        const now = deps.now || Date.now;
        failures.count++;
        sessionLogger.warn(LOG, 'Image scam check failed, message let through (' + failures.count + ' in a row): ' + error.message);
        if (failures.count < FAILURE_ALERT_AFTER || now() - failures.alertedAt < FAILURE_ALERT_EVERY_MS) return;
        failures.alertedAt = now();
        const channel = deps.alertChannel || await this.getChannel(config.alertChannelId);
        if (!channel) return;
        try {
            await channel.send({
                content: 'Image scam filter: SubQ failed ' + failures.count + ' times in a row, so images are not checked right now. Last error: ' + trim(error.message, 300),
                allowedMentions: NO_MENTIONS
            });
        } catch (sendError) {
            sessionLogger.error(LOG, 'Could not post the SubQ failure notice:', sendError.message);
        }
    },

    isIgnored: function (channel, config) {
        if (!channel) return false;
        const ignored = config.ignoreChannelIds;
        return ignored.includes(String(channel.id)) ||
            (channel.parentId && ignored.includes(String(channel.parentId))) ||
            Boolean(channel.parent && channel.parent.parentId && ignored.includes(String(channel.parent.parentId)));
    },

    isStaff: function (member, config) {
        if (!member) return false;
        if (member.permissions && typeof member.permissions.has === 'function' && member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
        const roles = member.roles && member.roles.cache;
        return Boolean(roles && config.staffRoleIds.some(id => roles.has(id)));
    },

    seenState: function (messageId) {
        let state = seen.get(messageId);
        if (!state) {
            state = { keys: new Set(), acted: false };
            seen.set(messageId, state);
            if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
        }
        return state;
    },

    activeIncident: function (guildId, userId, now) {
        const key = guildId + ':' + userId;
        const incident = incidents.get(key);
        if (!incident) return null;
        if (incident.until <= now) {
            incidents.delete(key);
            return null;
        }
        return incident;
    },

    /**
     * Gets the bot client. Tests replace it.
     * @returns {Promise<object>} The discord.js client once it is ready.
     */
    getClient: async function () {
        const { getClient } = require('../discord/bot');
        return getClient();
    },

    /**
     * @param {string} channelId Channel snowflake.
     * @returns {Promise<object|null>} The channel, or null when it cannot be reached.
     */
    getChannel: async function (channelId) {
        try {
            const client = await this.getClient();
            return await client.channels.fetch(String(channelId));
        } catch (error) {
            sessionLogger.error(LOG, 'Could not fetch channel ' + channelId + ':', error.message);
            return null;
        }
    },

    /** Clears every bit of state. Tests only. */
    _reset: function () {
        seen.clear();
        incidents.clear();
        failures.count = 0;
        failures.alertedAt = -Infinity;
    },

    _internals: { collectImages, hasImagesOrLinks, limit }
};
