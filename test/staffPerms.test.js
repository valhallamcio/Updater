/*
 * Unit tests for staffPerms: a throttled subuser write is tried again after a wait.
 * Run: npm test   (node --test test/)
 *
 * Incident (2026-10-08): the panel let ten subuser creates through on Project Nova in 5 s,
 * then answered 429 "Too Many Attempts". The scheduler never tried again, so three staff
 * had no access until the next run 30 h later.
 *
 * Time runs on a fake clock: functions.sleep advances it.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const staffPerms = require('../schedulers/staffPerms');
const pterodactyl = require('../modules/pterodactyl');
const yggdrasil = require('../modules/yggdrasil');
const functions = require('../modules/functions');
const sessionLogger = require('../modules/sessionLogger');

const PERMS = ['control.console', 'file.sftp'];
const orig = {
    getServers: yggdrasil.getServers,
    listUsers: pterodactyl.listUsers,
    createSubUser: pterodactyl.createSubUser,
    updateSubUser: pterodactyl.updateSubUser,
    sleep: functions.sleep,
    info: sessionLogger.info,
    warn: sessionLogger.warn,
    error: sessionLogger.error,
};

let clock;
let created;  // [clock, serverId, email] of each create that went through
let errors;

beforeEach(() => {
    clock = 0;
    created = [];
    errors = [];
    functions.sleep = async (ms) => { clock += ms; };
    sessionLogger.info = () => {};
    sessionLogger.warn = () => {};
    sessionLogger.error = (source, message) => { errors.push(String(message)); };
    yggdrasil.getServers = async () => [{ serverId: 'nova', name: 'Project Nova' }];
    pterodactyl.listUsers = async () => ({ data: [] });
});

afterEach(() => {
    Object.assign(yggdrasil, { getServers: orig.getServers });
    Object.assign(pterodactyl, { listUsers: orig.listUsers, createSubUser: orig.createSubUser, updateSubUser: orig.updateSubUser });
    functions.sleep = orig.sleep;
    Object.assign(sessionLogger, { info: orig.info, warn: orig.warn, error: orig.error });
});

/** A panel that takes `limit` creates, then refuses until 60 s after the first one. */
function throttledCreate(limit) {
    let windowStart = null;
    let count = 0;
    return async (serverId, body) => {
        if (windowStart === null || clock - windowStart >= 60000) { windowStart = clock; count = 0; }
        if (count >= limit) return undefined; // the module logs the 429 and returns undefined
        count++;
        created.push([clock, serverId, body.email]);
        return { object: 'server_subuser' };
    };
}

test('a create the panel throttles goes through on a later try', async () => {
    pterodactyl.createSubUser = throttledCreate(10);
    const mails = Array.from({ length: 13 }, (_, i) => `staff${i}@example.com`);
    await staffPerms.givePerms({ staffMailList: mails, staffPermissions: PERMS });
    assert.deepStrictEqual(created.map(c => c[2]), mails);
    assert.deepStrictEqual(errors, []);
});

test('a create that never goes through stops after 3 tries and the run goes on', async () => {
    yggdrasil.getServers = async () => [{ serverId: 'a', name: 'A' }, { serverId: 'b', name: 'B' }];
    let calls = 0;
    pterodactyl.createSubUser = async (serverId, body) => {
        calls++;
        if (serverId === 'a') return undefined;
        created.push([clock, serverId, body.email]);
        return { object: 'server_subuser' };
    };
    await staffPerms.givePerms({ staffMailList: ['x@example.com'], staffPermissions: PERMS });
    assert.strictEqual(calls, 4);
    assert.deepStrictEqual(created.map(c => c[1]), ['b']);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Add of x@example.com to A failed 3 times/);
});

test('a failed subuser list skips that server instead of ending the run', async () => {
    yggdrasil.getServers = async () => [{ serverId: 'a', name: 'A' }, { serverId: 'b', name: 'B' }];
    pterodactyl.listUsers = async (serverId) => (serverId === 'a' ? undefined : { data: [] });
    pterodactyl.createSubUser = throttledCreate(10);
    await staffPerms.givePerms({ staffMailList: ['x@example.com'], staffPermissions: PERMS });
    assert.deepStrictEqual(created.map(c => c[1]), ['b']);
    assert.match(errors[0], /Subuser list for A failed 3 times/);
});

test('a throttled permission update is tried again', async () => {
    pterodactyl.listUsers = async () => ({ data: [{ attributes: { email: 'x@example.com', uuid: 'u1', permissions: ['control.console'] } }] });
    let tries = 0;
    pterodactyl.updateSubUser = async () => (++tries < 2 ? undefined : { object: 'server_subuser' });
    pterodactyl.createSubUser = async () => { throw new Error('no create expected'); };
    await staffPerms.givePerms({ staffMailList: ['x@example.com'], staffPermissions: PERMS });
    assert.strictEqual(tries, 2);
    assert.deepStrictEqual(errors, []);
});
