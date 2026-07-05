const axios = require('axios');
const WebSocket = require('ws');
const EventEmitter = require('events');
const sessionLogger = require('./sessionLogger');
require('dotenv').config();

const API_BASE = process.env.YGGDRASIL_API_URL || 'https://api.valhallamc.dev/v1';
const WS_BASE = process.env.YGGDRASIL_WS_URL || 'wss://api.valhallamc.dev/';
const API_TOKEN = process.env.YGGDRASIL_API_TOKEN;

const emitter = new EventEmitter();

const headers = {};
if (API_TOKEN) {
    headers['X-Api-Key'] = API_TOKEN;
}

const client = axios.create({
    baseURL: API_BASE,
    timeout: 15000,
    headers
});

// WebSocket state
let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let intentionalClose = false;

/**
 * Fetches online players from the Yggdrasil API.
 * Keyed by server TAG (e.g. "gtnh"), value is an array of usernames:
 * { "gtnh": ["player1", "player2"], ... }
 * NOTE: keys are tags, not display names — consumers that look up by a stored
 * server name must resolve it to a tag first (see playerEventScheduler).
 */
async function getPlayers() {
    const response = await client.get('/players/');
    const raw = response.data.data;
    const result = {};

    for (const [serverName, players] of Object.entries(raw)) {
        result[serverName] = players.map(p => p.username);
    }

    return result;
}

async function getPlayersDetailed() {
    const response = await client.get('/players/');
    return response.data.data;
}

async function getServers() {
    const response = await client.get('/servers/');
    return response.data.data;
}

/**
 * Updates a server's fields via the Yggdrasil API.
 * @param {string} tag - Server tag to update.
 * @param {object} fields - Fields to update (e.g. { modpack_version, fileID }).
 */
async function updateServer(tag, fields) {
    await client.patch(`/servers/${tag}`, fields);
}

// ── Durable ops (biforesting v2 phase 2) ────────────────────────────────────
// Ops queue in Yggdrasil's biforesting_ops and survive restarts on both ends;
// state flow: pending -> dispatched -> acked -> completed|failed (+ waiting_player/
// expired/cancelled). Live updates arrive on the WS as 'biforesting.op.updated'.

/**
 * Creates a durable op for a backend server.
 * @param {string} server - link serverId, Pterodactyl serverId, tag, or instanceKey.
 * @param {object} op - { type, params, target?, flags?, idempotencyKey?, execTimeoutMs?, ... }
 * @returns {{ op: object, replayed: boolean }} replayed=true when the idempotencyKey already existed.
 */
async function createOp(server, op) {
    const response = await client.post(`/biforesting/${server}/ops`, op);
    return response.data.data;
}

async function getOp(opId) {
    const response = await client.get(`/biforesting/ops/${opId}`);
    return response.data.data;
}

/**
 * Lists a server's ops, newest first.
 * @param {object} [query] - { state?, type?, limit? }
 * @returns {Array} op docs (the endpoint wraps them as { instanceKey, ops, count }).
 */
async function listOps(server, query = {}) {
    const response = await client.get(`/biforesting/${server}/ops`, { params: query });
    return response.data.data.ops;
}

/** Cancels a queued op (pending/dispatched/waiting_player — post-ack is too late). */
async function cancelOp(opId) {
    const response = await client.post(`/biforesting/ops/${opId}/cancel`);
    return response.data.data;
}

/**
 * Player inventory: live (inspect_inventory op) when the server is linked, else the newest
 * stored snapshot with stale:true. Response: { source: 'live'|'snapshot', stale, inventory|snapshot }.
 */
async function getPlayerInventory(server, player) {
    const response = await client.get(`/biforesting/${server}/players/${encodeURIComponent(player)}/inventory`, {
        timeout: 15000 // the live path long-polls up to ~8s
    });
    return response.data.data;
}

/**
 * Quest registry search (v2 phase 6): exact-id hit, then text relevance, then substring.
 * Response: { instanceKey, source: 'ftbq'|'bq', registryCount, dumpedAt, count, quests }.
 */
async function searchQuests(server, search, limit = 10) {
    const response = await client.get(`/biforesting/${server}/quests`, {
        params: search ? { search, limit } : { limit }
    });
    return response.data.data;
}

/** Live link session snapshot for a server, or null when it isn't linked right now. */
async function getLinkSession(server) {
    try {
        const response = await client.get(`/biforesting/link/${server}`);
        return response.data.data;
    } catch (err) {
        if (err.response && err.response.status === 404) return null;
        throw err;
    }
}

/**
 * Creates an op and waits for it to reach a terminal state (completed/failed/expired/cancelled).
 * Prefers the 'biforesting.op.updated' WS event, falls back to polling.
 * @returns {object} the terminal op doc.
 */
async function runOp(server, op, timeoutMs = 30000) {
    const { op: created } = await createOp(server, op);
    const terminal = ['completed', 'failed', 'expired', 'cancelled'];
    if (terminal.includes(created.state)) return created;

    return new Promise((resolve, reject) => {
        let pollTimer = null;
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`op ${created._id} not terminal after ${timeoutMs}ms`));
        }, timeoutMs);

        const onUpdate = (payload) => {
            if (payload.opId !== created._id || !terminal.includes(payload.state)) return;
            cleanup();
            getOp(created._id).then(resolve, reject);
        };

        const cleanup = () => {
            clearTimeout(timeout);
            if (pollTimer) clearInterval(pollTimer);
            emitter.off('biforesting.op.updated', onUpdate);
        };

        emitter.on('biforesting.op.updated', onUpdate);
        pollTimer = setInterval(async () => {
            try {
                const doc = await getOp(created._id);
                if (terminal.includes(doc.state)) {
                    cleanup();
                    resolve(doc);
                }
            } catch (err) { /* transient — keep polling until the timeout */ }
        }, 5000);
    });
}

/**
 * Connects the WebSocket to the Yggdrasil API for real-time events.
 */
function connect() {
    if (!API_TOKEN) {
        sessionLogger.warn('Yggdrasil', 'No YGGDRASIL_API_TOKEN set, WebSocket connection skipped');
        return;
    }

    intentionalClose = false;
    const url = `${WS_BASE}?token=${API_TOKEN}`;

    try {
        ws = new WebSocket(url);

        ws.on('open', () => {
            sessionLogger.info('Yggdrasil', 'WebSocket connected');
            reconnectDelay = 1000;
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                const eventName = message.type || message.event;
                if (eventName) {
                    emitter.emit(eventName, message.payload || message.data || message);
                }
            } catch (err) {
                sessionLogger.error('Yggdrasil', 'Failed to parse WebSocket message', err.message);
            }
        });

        ws.on('close', () => {
            sessionLogger.warn('Yggdrasil', 'WebSocket closed');
            ws = null;
            if (!intentionalClose) {
                scheduleReconnect();
            }
        });

        ws.on('error', (err) => {
            sessionLogger.error('Yggdrasil', 'WebSocket error', err.message);
        });
    } catch (err) {
        sessionLogger.error('Yggdrasil', 'Failed to create WebSocket', err.message);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    sessionLogger.info('Yggdrasil', `Reconnecting in ${reconnectDelay / 1000}s...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connect();
    }, reconnectDelay);
}

/**
 * Gracefully disconnects the WebSocket.
 */
function disconnect() {
    intentionalClose = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
}

/**
 * Returns whether the WebSocket is currently connected.
 */
function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
}

module.exports = {
    getPlayers,
    getPlayersDetailed,
    getServers,
    updateServer,
    createOp,
    getOp,
    listOps,
    cancelOp,
    runOp,
    getLinkSession,
    getPlayerInventory,
    searchQuests,
    connect,
    disconnect,
    isConnected,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter)
};
