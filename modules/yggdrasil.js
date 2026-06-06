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
    connect,
    disconnect,
    isConnected,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter)
};
