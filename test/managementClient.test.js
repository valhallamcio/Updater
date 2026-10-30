/*
 * Unit tests for modules/managementClient.js and the reboot pre-stop save that uses it
 * (rebootScheduler.saveViaManagement).
 * Run: npm test   (node --test test/)
 *
 * A local ws server plays the game server's management endpoint the way 26.1.2 does it:
 * Bearer secret checked on the upgrade (401 otherwise), JSON-RPC 2.0 text frames,
 * notifications as `minecraft:notification/<path>` with a one-element params array.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const managementClient = require('../modules/managementClient');
const rs = require('../schedulers/rebootScheduler');
const pterodactyl = require('../modules/pterodactyl');
// No standby supervisor on these servers: state.json reads find no file and never reach the panel.
pterodactyl.readFileOnce = async () => null;
const functions = require('../modules/functions');
const sessionLogger = require('../modules/sessionLogger');
const config = require('../config/config.json');

const { ManagementClient, METHODS } = managementClient;
const SECRET = 'TestSecret0123456789abcdefghijABCDEFGHIJ';
const SECRET_ENV = 'VU_TEST_MANAGEMENT_SECRET';
const SERVER = { serverId: 'abc123', name: 'X' };

const orig = {
    sendCommand: pterodactyl.sendCommand,
    sendPowerAction: pterodactyl.sendPowerAction,
    getStatus: pterodactyl.getStatus,
    sleep: functions.sleep,
    warn: sessionLogger.warn,
    info: sessionLogger.info,
    runtimeConfig: rs.runtimeConfig,
    hadManagement: Object.prototype.hasOwnProperty.call(config, 'management'),
    management: config.management,
};

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
    Object.assign(pterodactyl, {
        sendCommand: orig.sendCommand,
        sendPowerAction: orig.sendPowerAction,
        getStatus: orig.getStatus,
    });
    functions.sleep = orig.sleep;
    sessionLogger.warn = orig.warn;
    sessionLogger.info = orig.info;
    rs.runtimeConfig = orig.runtimeConfig;
    if (orig.hadManagement) config.management = orig.management;
    else delete config.management;
    delete process.env[SECRET_ENV];
    rs.managementFallbackLogged.clear();
});

/**
 * Starts the fake endpoint. answer(message, socket) returns a result to send back,
 * or undefined to stay silent. Set server.refuse = true to answer upgrades with 503.
 */
function fakeServer(answer) {
    return new Promise((resolve) => {
        const server = { authHeaders: [], upgrades: [], sockets: [], received: [], refuse: false };
        const wss = new WebSocketServer({
            host: '127.0.0.1',
            port: 0,
            verifyClient: (info, done) => {
                server.upgrades.push(Date.now());
                server.authHeaders.push(info.req.headers.authorization);
                if (info.req.headers.authorization !== `Bearer ${SECRET}`) return done(false, 401, 'Unauthorized');
                if (server.refuse) return done(false, 503, 'Busy');
                done(true);
            },
        });
        wss.on('connection', (socket) => {
            server.sockets.push(socket);
            socket.on('message', (data) => {
                const message = JSON.parse(data.toString());
                server.received.push(message);
                const result = answer ? answer(message, socket) : undefined;
                if (result !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
            });
        });
        wss.on('listening', () => {
            server.url = `ws://127.0.0.1:${wss.address().port}`;
            cleanups.push(() => new Promise((done) => {
                for (const socket of wss.clients) socket.terminate();
                wss.close(() => done());
            }));
            resolve(server);
        });
    });
}

function client(options) {
    const c = new ManagementClient({ secret: SECRET, reconnect: false, requestTimeoutMs: 1000, ...options });
    cleanups.push(() => c.close());
    return c;
}

function within(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function once(emitter, event) {
    return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

async function until(check, ms, what) {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error(`${what}: not reached within ${ms} ms`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** Panel and sleep stubs for ensureServerStopped. The panel reports offline at once. */
function stubReboot(preStopSaveWaitSeconds) {
    const log = [];
    const warnings = [];
    const infos = [];
    pterodactyl.sendCommand = async (id, cmd) => { log.push(`cmd:${cmd}`); };
    pterodactyl.sendPowerAction = async (id, action) => { log.push(`power:${action}`); };
    pterodactyl.getStatus = async () => ({ attributes: { current_state: 'offline' } });
    functions.sleep = async (ms) => { log.push(`sleep:${ms}`); };
    sessionLogger.warn = (source, message) => { warnings.push(String(message)); };
    sessionLogger.info = (source, message) => { infos.push(String(message)); };
    rs.runtimeConfig = { playerAlerts: { preStopSaveWaitSeconds } };
    return { log, warnings, infos };
}

test('auth: the secret goes as a Bearer header; a wrong secret gets 401 and no socket', { timeout: 5000 }, async () => {
    const server = await fakeServer();
    const good = client({ url: server.url });
    const bad = client({ url: server.url, secret: 'wrong' });

    await good.connect();
    assert.strictEqual(server.authHeaders[0], `Bearer ${SECRET}`);
    assert.ok(good.connected);

    await assert.rejects(bad.connect(), /401/);
    assert.strictEqual(server.sockets.length, 1, 'only the right secret gets a socket');
});

test('request/response: each reply resolves its own request by id, an error reply rejects', { timeout: 5000 }, async () => {
    const held = [];
    const server = await fakeServer((message, socket) => {
        if (message.method === 'minecraft:nope') {
            socket.send(JSON.stringify({
                jsonrpc: '2.0', id: message.id,
                error: { code: -32601, message: 'Method not found', data: 'Method not found: minecraft:nope' },
            }));
            return undefined;
        }
        // Hold two requests, then answer them in reverse order.
        held.push(message);
        if (held.length === 2) {
            for (const m of held.reverse()) {
                socket.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echo: m.method } }));
            }
        }
        return undefined;
    });
    const c = client({ url: server.url });
    await c.connect();

    const [players, status] = await Promise.all([c.request(METHODS.players), c.request(METHODS.status)]);
    assert.deepStrictEqual(players, { echo: 'minecraft:players' });
    assert.deepStrictEqual(status, { echo: 'minecraft:server/status' });
    assert.strictEqual(server.received[0].jsonrpc, '2.0');
    assert.notStrictEqual(server.received[0].id, server.received[1].id, 'every request gets its own id');
    assert.ok(!('params' in server.received[0]), 'a parameterless method is sent without params');

    await assert.rejects(c.request('minecraft:nope'),
        (error) => error.code === -32601 && /Method not found/.test(error.message));
    assert.strictEqual(c.pending.size, 0);
});

test('notification: a joined player and a save without params reach their subscribers', { timeout: 5000 }, async () => {
    const server = await fakeServer();
    const c = client({ url: server.url });
    await c.connect();

    const joined = new Promise((resolve) => c.subscribe('players/joined', resolve));
    const saved = new Promise((resolve) => c.subscribe('server/saved', () => resolve('saved')));
    const player = { id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', name: 'AlpDerps' };
    server.sockets[0].send(JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/players/joined', params: [player] }));
    server.sockets[0].send(JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/server/saved' }));

    assert.deepStrictEqual(await within(joined, 1000, 'players/joined'), player);
    assert.strictEqual(await within(saved, 1000, 'server/saved'), 'saved');
});

test('timeout: a request with no reply rejects with ETIMEDOUT and leaves nothing pending', { timeout: 5000 }, async () => {
    const server = await fakeServer(); // never answers
    const c = client({ url: server.url });
    await c.connect();

    const started = Date.now();
    await assert.rejects(c.request(METHODS.save, { flush: true }, 100), (error) => error.code === 'ETIMEDOUT');
    assert.ok(Date.now() - started >= 95, 'the timeout is the one asked for');
    assert.strictEqual(c.pending.size, 0);
});

test('fallback: a management save that times out runs save-all and the wait; the warning is logged once per run', { timeout: 5000 }, async () => {
    const server = await fakeServer(); // never answers server/save
    config.management = { [SERVER.serverId]: { url: server.url, secretEnv: SECRET_ENV } };
    process.env[SECRET_ENV] = SECRET;
    const { log, warnings } = stubReboot(0.2);

    assert.strictEqual(await rs.ensureServerStopped(SERVER), true);
    assert.deepStrictEqual(log, ['cmd:save-all', 'sleep:200', 'power:stop']);
    assert.deepStrictEqual(server.received[0].params, { flush: true });

    log.length = 0;
    assert.strictEqual(await rs.ensureServerStopped(SERVER), true);
    assert.deepStrictEqual(log, ['cmd:save-all', 'sleep:200', 'power:stop'], 'the second reboot falls back the same way');
    assert.strictEqual(server.received.length, 2, 'each reboot tries the protocol first');
    assert.strictEqual(warnings.filter((w) => /management save failed/.test(w)).length, 1,
        `one warning per run, got: ${warnings.join(' | ')}`);
});

test('reconnect: a dropped connection comes back with growing backoff and serves requests; close() ends it', { timeout: 8000 }, async () => {
    const server = await fakeServer((message) => (message.method === METHODS.status ? { started: true, players: [] } : undefined));
    const c = client({ url: server.url, reconnect: true, reconnectMinMs: 50, reconnectMaxMs: 1000 });
    await c.connect();

    server.refuse = true;
    const closed = once(c, 'close');
    server.sockets[0].terminate();
    await within(closed, 1000, 'close');

    // Three refused attempts (50, 100, 200 ms apart from each close), then let the next one in.
    await until(() => server.upgrades.length >= 4, 3000, 'three reconnect attempts');
    const opened = once(c, 'open');
    server.refuse = false;
    await within(opened, 3000, 'reopen');

    const [first, second, third] = server.upgrades.slice(1, 4);
    assert.ok(second - first >= 90 && third - second >= 190,
        `backoff doubles (about 100 then 200 ms), got ${second - first} and ${third - second} ms`);
    assert.deepStrictEqual(await c.request(METHODS.status), { started: true, players: [] });

    // Drop again and close inside the backoff: no attempt may follow.
    const closedAgain = once(c, 'close');
    server.sockets[server.sockets.length - 1].terminate();
    await within(closedAgain, 1000, 'second close');
    const attempts = server.upgrades.length;
    await c.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(server.upgrades.length, attempts, 'close() stops the reconnects');
});

test('save over the protocol: a configured server skips save-all and the flush wait', { timeout: 5000 }, async () => {
    const server = await fakeServer((message) => (message.method === METHODS.save ? true : undefined));
    config.management = { [SERVER.serverId]: { url: server.url, secretEnv: SECRET_ENV } };
    process.env[SECRET_ENV] = SECRET;
    const { log, warnings, infos } = stubReboot(90);

    assert.strictEqual(await rs.ensureServerStopped(SERVER), true);

    assert.deepStrictEqual(log, ['power:stop'], 'no console save-all and no 90 s wait');
    assert.deepStrictEqual(server.received, [{ jsonrpc: '2.0', id: 1, method: 'minecraft:server/save', params: { flush: true } }]);
    assert.ok(infos.some((m) => /world saved over the management protocol/.test(m)));
    assert.strictEqual(warnings.length, 0);
});

test('not configured: no entry keeps save-all, the 90 s wait and the stop, and opens no socket', { timeout: 5000 }, async () => {
    const server = await fakeServer((message) => (message.method === METHODS.save ? true : undefined));
    process.env[SECRET_ENV] = SECRET;

    // Prod today has no management key; an entry for another server must not touch this one.
    for (const management of [undefined, {}, { otherServer: { url: server.url, secretEnv: SECRET_ENV } }]) {
        if (management === undefined) delete config.management;
        else config.management = management;
        const { log, warnings } = stubReboot(90);

        assert.strictEqual(await rs.ensureServerStopped(SERVER), true);

        assert.deepStrictEqual(log, ['cmd:save-all', 'sleep:90000', 'power:stop']);
        assert.strictEqual(warnings.length, 0, `nothing to warn about, got: ${warnings.join(' | ')}`);
    }
    assert.strictEqual(server.upgrades.length, 0, 'no connection attempt');
});
