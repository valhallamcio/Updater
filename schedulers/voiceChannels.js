/*
 * File: voiceChannels.js
 * Project: valhalla-updater
 * -----
 * Voice channels that grow and shrink on their own.
 *
 * The forum asked for voice chat per team. In-game VoIP needs a client mod, so
 * the answer is a category on Discord that always has a free room in it: the
 * moment somebody joins the last empty one, another appears, and a room that
 * has stood empty long enough goes away again.
 *
 * `planVoice` is pure and holds the whole policy — how many to make, which ones
 * to drop — so the rules are tested on values, not on a live guild. `reconcile`
 * is the side of it that talks to Discord: one pass at a time, and it never
 * throws out of a tick.
 *
 * A channel somebody named by hand is invisible to all of it. Only rooms
 * carrying `namePrefix` are ours.
 */

const { ChannelType } = require('discord.js');
const sessionLogger = require('../modules/sessionLogger');

const LOG = 'VoiceChannels';
/** A join and a leave in the same second are one reconcile, not two. */
const DEBOUNCE_MS = 2000;

/** channel id -> when it was first SEEN empty. Lives as long as the process. */
const emptySince = new Map();
/** One pass at a time: a slow guild must not have the next tick creating again. */
let reconciling = false;

const defaults = {
    "active": false,
    "interval": 1,
    "guildId": "",
    "categoryId": "",
    "namePrefix": "Voice",
    "minFree": 1,
    "maxChannels": 10,
    "idleMinutes": 5
};

/** The number on `Voice 3`, or null for a name that is not one of ours. */
function numberOf(name, prefix) {
    const match = String(name).match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`));
    return match ? Number(match[1]) : null;
}

module.exports = {
    name: 'voiceChannels',
    defaultConfig: defaults,

    /**
     * Decides what the category should look like. Pure.
     * @param {object} input `{channels, config, now}` - channels are OUR voice channels only,
     *                       each `{id, name, memberCount, emptySince}`.
     * @returns {{create: number, remove: string[]}} How many rooms to add, and which ids to drop.
     */
    planVoice: function ({ channels, config, now }) {
        const cfg = Object.assign({}, defaults, config || {});
        const prefix = String(cfg.namePrefix || '');
        const minFree = Math.max(0, Math.floor(Number(cfg.minFree) || 0));
        const maxChannels = Math.max(0, Math.floor(Number(cfg.maxChannels) || 0));
        const idleMs = Math.max(0, Number(cfg.idleMinutes) || 0) * 60 * 1000;

        // A hand-named room is somebody else's; it is never counted and never
        // touched. "Voice Lounge" starts with the prefix and is still not ours:
        // only `<prefix> <number>` is.
        const mine = (channels || []).filter(c => c && typeof c.name === 'string' && numberOf(c.name, prefix) !== null);
        const empty = mine.filter(c => (Number(c.memberCount) || 0) === 0);

        const create = Math.max(0, Math.min(minFree - empty.length, maxChannels - mine.length));

        const surplus = empty.length - minFree;
        const remove = [];
        if (surplus > 0) {
            const idle = empty
                .filter(c => typeof c.emptySince === 'number' && now - c.emptySince >= idleMs)
                .sort((a, b) => a.emptySince - b.emptySince);
            for (const channel of idle.slice(0, surplus)) remove.push(channel.id);
        }
        return { create: create, remove: remove };
    },

    /**
     * Starts the reconciler and hooks it to voice activity.
     * @param {object} options Scheduler config (`scheduler.voiceChannels` in config.json).
     */
    start: async function (options) {
        const config = Object.assign({}, defaults, options || {});

        if (!config.guildId || !config.categoryId) {
            sessionLogger.warn(LOG, 'Set the voice channel guild and category up in /config/config.json!');
            return;
        }

        const tick = () => this.reconcile(config).catch(error =>
            sessionLogger.error(LOG, 'Could not reconcile the voice channels (will try again next interval):', error.message));

        const { getClient } = require('../discord/bot');
        const client = await getClient();

        let debounce = null;
        client.on('voiceStateUpdate', () => {
            if (debounce) return;
            debounce = setTimeout(() => {
                debounce = null;
                tick();
            }, DEBOUNCE_MS);
        });

        tick();
        setInterval(tick, Math.max(1, config.interval) * 60 * 1000);
    },

    /**
     * Brings the category in line with the plan. Never throws.
     * @param {object} config Scheduler config.
     * @param {object} [deps] `{guild}` - only tests pass one.
     * @returns {Promise<object>} `{created, removed}`, or `{skipped}` when it did nothing.
     */
    reconcile: async function (config, deps = {}) {
        if (reconciling) return { skipped: 'in-flight' };
        reconciling = true;
        try {
            const guild = deps.guild || await this.getGuild(config.guildId);
            if (!guild) return { skipped: 'no-guild' };

            const prefix = String(config.namePrefix || defaults.namePrefix);
            const live = (await this.readChannels(guild)).filter(channel =>
                channel
                && channel.type === ChannelType.GuildVoice
                && String(channel.parentId) === String(config.categoryId)
                && typeof channel.name === 'string'
                && numberOf(channel.name, prefix) !== null);

            const now = Date.now();
            const channels = live.map(channel => {
                const memberCount = this.membersIn(guild, channel);
                if (memberCount === 0) {
                    if (!emptySince.has(channel.id)) emptySince.set(channel.id, now);
                } else {
                    emptySince.delete(channel.id);
                }
                return {
                    id: channel.id,
                    name: channel.name,
                    memberCount: memberCount,
                    emptySince: emptySince.has(channel.id) ? emptySince.get(channel.id) : null
                };
            });
            // A room somebody deleted by hand must not keep its timer forever.
            for (const id of [...emptySince.keys()]) {
                if (!channels.some(channel => channel.id === id)) emptySince.delete(id);
            }

            const plan = this.planVoice({ channels: channels, config: config, now: now });

            const taken = new Set(channels.map(channel => numberOf(channel.name, prefix)).filter(n => n !== null));
            let created = 0;
            for (let i = 0; i < plan.create; i++) {
                let next = 1;
                while (taken.has(next)) next++;
                taken.add(next);
                try {
                    await guild.channels.create({
                        name: `${prefix} ${next}`,
                        type: ChannelType.GuildVoice,
                        parent: config.categoryId
                    });
                    created++;
                } catch (error) {
                    sessionLogger.error(LOG, `Could not create ${prefix} ${next}:`, error.message);
                }
            }

            let removed = 0;
            for (const id of plan.remove) {
                const channel = live.find(c => c.id === id);
                if (!channel) continue;
                try {
                    await channel.delete('voiceChannels: empty for too long');
                    emptySince.delete(id);
                    removed++;
                } catch (error) {
                    sessionLogger.error(LOG, `Could not delete ${channel.name}:`, error.message);
                }
            }

            if (created > 0 || removed > 0) {
                sessionLogger.info(LOG, `Voice category reconciled: ${created} added, ${removed} removed`);
            }
            return { created: created, removed: removed };
        } finally {
            reconciling = false;
        }
    },

    /**
     * How many people sit in a voice channel. `channel.members` only counts
     * voice states whose MEMBER is cached, and this bot has no GuildMembers
     * intent, so after a restart an occupied room can read as empty there. The
     * guild's own voice states are what the gateway actually sends.
     * @param {object} guild The guild.
     * @param {object} channel The voice channel.
     * @returns {number} Members in it.
     */
    membersIn: function (guild, channel) {
        const states = guild && guild.voiceStates && guild.voiceStates.cache;
        if (states && typeof states.values === 'function') {
            let count = 0;
            for (const state of states.values()) {
                if (state && String(state.channelId) === String(channel.id)) count++;
            }
            return count;
        }
        return channel.members && typeof channel.members.size === 'number' ? channel.members.size : 0;
    },

    /**
     * The guild's channels, from the API when it answers and from the cache when it does not.
     * @param {object} guild The guild.
     * @returns {Promise<object[]>} Channel objects.
     */
    readChannels: async function (guild) {
        const manager = guild.channels;
        if (!manager) return [];
        let source = manager.cache;
        if (typeof manager.fetch === 'function') {
            source = await manager.fetch().catch(() => manager.cache);
        }
        if (!source || typeof source.values !== 'function') return [];
        return [...source.values()];
    },

    /**
     * Gets the guild off the bot client.
     * @param {string} guildId Guild snowflake.
     * @returns {Promise<object|null>} The guild, or null when it cannot be reached.
     */
    getGuild: async function (guildId) {
        try {
            const { getClient } = require('../discord/bot');
            const client = await getClient();
            return await client.guilds.fetch(String(guildId));
        } catch (error) {
            sessionLogger.error(LOG, `Could not fetch guild ${guildId}:`, error.message);
            return null;
        }
    },

    /** Test seam: the empty-timer map lives as long as the process. */
    _emptySince: emptySince
};
