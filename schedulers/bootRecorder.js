/*
 * bootRecorder.js
 *
 * One record per boot of a server that starts through the standby supervisor, in
 * bifrost.server_boots. Wings does not see a warm reboot or a crash restore (the container keeps
 * running), so standby/state.json is the only source of these boots (modules/supervisorState).
 * Each pass reads the file of every supervisor server. A new lastBoot (bootCount went up, or a
 * new supervisor after a container restart) gives one record.
 *
 * Off by default (config.json scheduler.bootRecorder.active). Servers without a supervisor cost
 * one file read per supervisorState.DETECT_TTL_MS. Two boots between two passes give one record:
 * state.json holds only the last boot.
 */

const yggdrasil = require('../modules/yggdrasil');
const mongo = require('../modules/mongo');
const supervisorState = require('../modules/supervisorState');
const sessionLogger = require('../modules/sessionLogger');

module.exports = {
    name: 'bootRecorder',
    defaultConfig: {
        active: false,
        interval: 60, // seconds between passes
    },

    // serverId -> key of the last boot written (or found already written)
    lastSeen: new Map(),
    running: false,

    start: async function (options) {
        sessionLogger.info('BootRecorder', `Started - reading supervisor state.json every ${options.interval}s`);
        mongo.ensureServerBootIndexes().catch(error =>
            sessionLogger.warn('BootRecorder', `server_boots indexes not ensured: ${error.message}`));
        setInterval(() => this.tick().catch(error =>
            sessionLogger.error('BootRecorder', 'pass failed', error.message)), options.interval * 1000);
    },

    /** "<supervisor start ms>#<bootCount>": one boot of one supervisor run. */
    bootKey: function (state) {
        return `${state.supervisorStartedAtMs}#${state.bootCount}`;
    },

    /**
     * The record of the last boot in a state.json, or null while that boot is not ready.
     * @param {object} server The Yggdrasil server doc.
     * @param {object} state supervisorState.parse output.
     */
    bootRecord: function (server, state) {
        const b = state.lastBoot;
        if (!b.kind || b.readyAtMs === null || state.supervisorStartedAtMs === null) return null;
        return {
            serverId: server.serverId,
            tag: server.tag || null,
            name: server.name || null,
            kind: b.kind,
            trigger: b.trigger,
            seconds: b.seconds,
            cpuMs: b.cpuMs,
            fallback: b.fallback,
            startedAt: b.startedAtMs === null ? null : new Date(b.startedAtMs),
            readyAt: new Date(b.readyAtMs),
            bootCount: state.bootCount,
            supervisorStartedAt: new Date(state.supervisorStartedAtMs),
            supervisorVersion: state.supervisorVersion,
            mode: state.mode,
            recordedAt: new Date(),
        };
    },

    /**
     * One pass over every server. A failed write is tried again at the next pass.
     * @param {object} [deps] Injectable for tests: yggdrasil, mongo, supervisorState.
     * @returns {Promise<number>} Records written.
     */
    tick: async function (deps = {}) {
        if (this.running) return 0;
        this.running = true;
        const ygg = deps.yggdrasil || yggdrasil;
        const db = deps.mongo || mongo;
        const sup = deps.supervisorState || supervisorState;
        let written = 0;
        try {
            const servers = await ygg.getServers();
            for (const server of servers || []) {
                if (!server || !server.serverId) continue;
                const state = await sup.current(server.serverId);
                if (!state) continue;
                const doc = this.bootRecord(server, state);
                if (!doc) continue;
                const key = this.bootKey(state);
                if (this.lastSeen.get(server.serverId) === key) continue;
                try {
                    if (await db.insertServerBoot(doc)) {
                        written++;
                        sessionLogger.info('BootRecorder',
                            `[${server.name || server.serverId}] boot ${doc.kind} (${doc.trigger || '?'}) ${doc.seconds}s, bootCount ${doc.bootCount}`);
                    }
                    this.lastSeen.set(server.serverId, key);
                } catch (error) {
                    sessionLogger.warn('BootRecorder', `[${server.name || server.serverId}] server_boots write failed: ${error.message}`);
                }
            }
        } finally {
            this.running = false;
        }
        return written;
    },
};
