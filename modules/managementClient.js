/*
 * managementClient.js
 *
 * Client for the Server Management Protocol of 1.21.9+ dedicated servers (our 26.x packs):
 * JSON-RPC 2.0 over a websocket, served by the game server itself.
 *
 * Wire facts (26.1.2 source, net/minecraft/server/jsonrpc/):
 *   - Auth: `Authorization: Bearer <secret>` on the upgrade request (security/AuthenticationHandler).
 *     That path skips the Origin check. The secret is 40 letters and digits.
 *   - Methods are `minecraft:<path>` (IncomingRpcMethods). Params go by name or as a one-element array.
 *   - Notifications are `minecraft:notification/<path>` with no id, params as a one-element array
 *     (OutgoingRpcMethods, JsonRPCUtils.createRequest).
 *
 * Opt-in per server in config.json:
 *   "management": { "<serverId>": { "url": "ws://10.0.0.3:<port>", "secretEnv": "NOVA_MANAGEMENT_SECRET" } }
 * The secret is read from the env var named by secretEnv. Optional `caFile` trusts a self-signed wss cert.
 * No entry = no connection: the caller keeps its console path.
 */

const EventEmitter = require('events');
const fs = require('fs');
const WebSocket = require('ws');

const NOTIFICATION_PREFIX = 'minecraft:notification/';

const METHODS = {
    status: 'minecraft:server/status',
    save: 'minecraft:server/save',
    stop: 'minecraft:server/stop',
    players: 'minecraft:players',
};

class ManagementClient extends EventEmitter {
    /**
     * @param {object} options { url, secret, ca, requestTimeoutMs, connectTimeoutMs,
     *                           reconnect, reconnectMinMs, reconnectMaxMs }
     */
    constructor(options = {}) {
        super();
        this.url = options.url;
        this.secret = options.secret;
        this.ca = options.ca;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
        // Reconnect only after a connection that was up drops. A first connect that fails rejects.
        this.reconnect = options.reconnect !== false;
        this.reconnectMinMs = options.reconnectMinMs ?? 1000;
        this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;

        this.ws = null;
        this.opening = null;
        this.closed = false;
        this.everOpened = false;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.nextId = 0;
        this.pending = new Map(); // id -> { resolve, reject, timer }
    }

    get connected() {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /** Opens the socket. Resolves on open; rejects on a refused handshake (401), error or timeout. */
    connect() {
        if (this.closed) return Promise.reject(new Error('management client is closed'));
        if (this.connected) return Promise.resolve();
        if (this.opening) return this.opening;
        return this.open();
    }

    open() {
        this.opening = new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url, {
                headers: { Authorization: `Bearer ${this.secret}` },
                handshakeTimeout: this.connectTimeoutMs,
                ca: this.ca,
            });
            this.ws = ws;
            let isOpen = false;
            let lastError = null;

            ws.on('open', () => {
                isOpen = true;
                this.opening = null;
                this.everOpened = true;
                this.reconnectAttempt = 0;
                resolve();
                this.emit('open');
            });
            ws.on('message', (data) => this.handleMessage(data));
            ws.on('error', (error) => { lastError = error; });
            ws.on('close', (code) => {
                if (!isOpen) {
                    if (this.ws === ws) this.opening = null;
                    reject(lastError || new Error(`management connection closed during handshake (${code})`));
                }
                this.handleClose(ws, isOpen, code);
            });
        });
        return this.opening;
    }

    handleClose(ws, wasOpen, code) {
        if (this.ws !== ws) return;
        this.ws = null;
        this.rejectAll(new Error(`management connection closed (${code})`));
        if (wasOpen) this.emit('close', code);
        if (!this.closed && this.reconnect && this.everOpened) this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.reconnectAttempt);
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // A failed attempt closes its socket, and handleClose schedules the next one.
            this.open().catch(() => {});
        }, delay);
    }

    /**
     * Sends one request and resolves with its result.
     * @param {string} method Full method id, e.g. 'minecraft:server/save'.
     * @param {object|Array} [params] By-name object or one-element array.
     * @param {number} [timeoutMs] Defaults to requestTimeoutMs.
     */
    request(method, params, timeoutMs = this.requestTimeoutMs) {
        if (!this.connected) return Promise.reject(new Error('management client is not connected'));
        const id = ++this.nextId;
        const message = { jsonrpc: '2.0', id, method };
        if (params !== undefined) message.params = params;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                const error = new Error(`${method} got no reply in ${timeoutMs} ms`);
                error.code = 'ETIMEDOUT';
                reject(error);
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify(message), (error) => {
                if (error) this.settle(id, error);
            });
        });
    }

    /**
     * Calls handler(params) for each notification with this name ('players/joined', 'server/saved').
     * @returns {Function} Removes the handler.
     */
    subscribe(name, handler) {
        const listener = (notification, params) => {
            if (notification === name) handler(params);
        };
        this.on('notification', listener);
        return () => this.off('notification', listener);
    }

    handleMessage(data) {
        let parsed;
        try {
            parsed = JSON.parse(data.toString());
        } catch (_) {
            return;
        }
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            if (!message || typeof message !== 'object') continue;
            if (typeof message.method === 'string' && message.id === undefined) {
                const name = message.method.startsWith(NOTIFICATION_PREFIX)
                    ? message.method.slice(NOTIFICATION_PREFIX.length)
                    : message.method;
                const params = Array.isArray(message.params) ? message.params[0] : message.params;
                this.emit('notification', name, params);
            } else if (this.pending.has(message.id)) {
                if (message.error) {
                    const error = new Error(message.error.message || 'JSON-RPC error');
                    error.code = message.error.code;
                    error.data = message.error.data;
                    this.settle(message.id, error);
                } else {
                    this.settle(message.id, null, message.result);
                }
            }
        }
    }

    settle(id, error, result) {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (error) entry.reject(error);
        else entry.resolve(result);
    }

    rejectAll(error) {
        for (const id of [...this.pending.keys()]) this.settle(id, error);
    }

    /** Stops reconnects, rejects open requests and closes the socket. */
    close() {
        this.closed = true;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.rejectAll(new Error('management client closed'));
        const ws = this.ws;
        this.ws = null;
        if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
        return new Promise((resolve) => {
            ws.once('close', () => resolve());
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1000);
                // A peer that never answers the close frame must not hold the caller.
                setTimeout(() => ws.terminate(), 2000).unref();
            } else {
                ws.terminate();
            }
        });
    }
}

/**
 * The connection settings for a server, or null when config.json has no management entry for it.
 * Throws when the entry is there but unusable, so the caller can log why it fell back.
 */
function entryFor(serverId, management) {
    if (management === undefined) {
        try {
            management = require('../config/config.json').management;
        } catch (_) {
            management = null; // config.json is generated on first run
        }
    }
    const entry = management && management[serverId];
    if (!entry) return null;
    if (!entry.url) throw new Error(`management.${serverId}.url is not set`);
    const secret = entry.secretEnv ? process.env[entry.secretEnv] : '';
    if (!secret) throw new Error(`management.${serverId}: env var ${entry.secretEnv || '(secretEnv not set)'} is empty`);
    return {
        url: entry.url,
        secret,
        ca: entry.caFile ? fs.readFileSync(entry.caFile) : undefined,
        connectTimeoutMs: entry.connectTimeoutMs,
    };
}

/**
 * Saves the world over a one-shot connection. Resolves when the save is on disk.
 * server/save runs on the main thread and the reply goes out after saveEverything returns.
 * flush:true makes that save wait for the region writes (ChunkMap.saveAllChunks: synchronize(true).join()).
 */
async function saveWorld(entry, timeoutMs) {
    const client = new ManagementClient({ ...entry, reconnect: false });
    try {
        await client.connect();
        const saved = await client.request(METHODS.save, { flush: true }, timeoutMs);
        if (saved !== true) throw new Error(`server/save answered ${JSON.stringify(saved)}`);
    } finally {
        await client.close();
    }
}

module.exports = {
    ManagementClient,
    METHODS,
    NOTIFICATION_PREFIX,
    entryFor,
    saveWorld,
};
