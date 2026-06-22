/*
 * Unit tests for the reboot de-dup gate in modules/rebootScheduler.js.
 * Run: npm test   (node --test test/)
 *
 * Regression (2026-06-22): `/voterestart` and staff `/reboot` returned "duplicate" and rebooted
 * NOTHING for any server the daily automated batch had already rebooted the same GMT+3 day.
 * executeFullServerReboot blocks on isServerActive() = activeReboots OR completedServers, and
 * completedServers is only cleared at the day rollover — so a vote fired hours after the morning
 * batch saw the server still in completedServers and bailed (observed: GT Odyssey @20:44 UTC,
 * "[GT Odyssey] Already being processed, skipping"). Fix: scheduled jobs pass {scheduled:true},
 * which ignores completedServers but still honors a genuinely in-flight reboot.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const rs = require('../schedulers/rebootScheduler');

function reset() {
    rs.state.activeReboots.clear();
    rs.state.completedServers.clear();
    rs.state.failedServers.clear();
}

test('isServerActive: batch path blocks on completedServers (de-dup within one batch)', () => {
    reset();
    rs.state.completedServers.add('abc123');
    assert.strictEqual(rs.stateOperations.isServerActive('abc123'), true);
});

test('isServerActive: scheduled reboot IGNORES completedServers (the duplicate fix)', () => {
    reset();
    rs.state.completedServers.add('abc123'); // daily batch already rebooted it today
    assert.strictEqual(rs.stateOperations.isServerActive('abc123', true), false,
        'a vote/staff reboot must not be skipped just because the daily batch already did it');
});

test('isServerActive: scheduled reboot STILL respects an in-flight reboot', () => {
    reset();
    rs.state.activeReboots.set('abc123', { stage: 'starting' });
    assert.strictEqual(rs.stateOperations.isServerActive('abc123', true), true,
        'never collide with a genuinely in-flight reboot of the same server');
});

test('executeFullServerReboot: batch path returns duplicate for a batch-completed server', async () => {
    reset();
    rs.state.completedServers.add('abc123');
    // No opts -> not scheduled -> still gated by completedServers; returns synchronously, no API calls.
    const r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X' }, 'node');
    assert.deepStrictEqual(r, { success: false, reason: 'duplicate' });
});

test('executeFullServerReboot: scheduled reboot still returns duplicate when one is in-flight', async () => {
    reset();
    rs.state.activeReboots.set('abc123', { stage: 'starting' });
    const r = await rs.executeFullServerReboot({ serverId: 'abc123', name: 'X' }, 'node', { scheduled: true });
    assert.deepStrictEqual(r, { success: false, reason: 'duplicate' });
    reset(); // drop the seeded active entry so nothing leaks to other tests
});
