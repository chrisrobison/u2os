import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import { createConnectionInstance, findInstance } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { stopAll as stopSync } from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';
import { ActionQueueWorker } from '../server/agent/action-queue-worker.js';
import { Agent } from '../server/agent/agent.js';

async function fixture(t, run) {
  const savedHome = process.env.U2OS_HOME;
  const savedQueue = process.env.U2OS_ACTION_QUEUE_TICK_MS, savedTrigger = process.env.U2OS_TRIGGER_TICK_MS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-bind-'));
  process.env.U2OS_HOME = dir; process.env.U2OS_ACTION_QUEUE_TICK_MS = '1234'; process.env.U2OS_TRIGGER_TICK_MS = '4321';
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (callback, ms) => {
    const handle = { unref() {} }; timers.push({ handle, callback, ms, cleared: false }); return handle;
  });
  t.mock.method(globalThis, 'clearInterval', (handle) => { const entry = timers.find((item) => item.handle === handle); if (entry) entry.cleared = true; });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('No fixture may call a real provider'); });
  const handles = [];
  try { await run({ dir, timers, handles }); }
  finally {
    for (const handle of handles) {
      handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve));
      await handle.stopBackgroundWorkers();
    }
    await stopSync(); await triggerEngine.stopAll(); closeAllForTests();
    for (const [key, value] of [['U2OS_HOME', savedHome], ['U2OS_ACTION_QUEUE_TICK_MS', savedQueue], ['U2OS_TRIGGER_TICK_MS', savedTrigger]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function configureSync(dir) {
  const db = getDb();
  const created = createConnectionInstance(db, { connectorId: 'google', label: 'Fixture sync account', status: 'connected' });
  const instance = findInstance(db, 'google', created.id);
  storeTokens(instance.vault_key, 'gmail', { access_token: 'fixture-bind-only', refresh_token: 'fixture-refresh', expires_in: 3600 }, dir);
  const config = loadConnectorsConfig(dir);
  config.email = { ...config.email, active: 'gmail', activeInstanceId: instance.id };
  saveConnectorsConfig(config, dir);
}

for (const configured of [false, true]) test(`occupied bind leaves no execution workers or adapter timers (${configured ? 'configured' : 'fresh'} personal home)`, (t) => fixture(t, async ({ dir, timers }) => {
  if (configured) configureSync(dir);
  const action = recordAudit({ requestedBy: 'owner', tool: 'notification.send', arguments: { title: 'fixture' },
    status: 'approved', correlationId: 'fixture_bind', policyDomain: 'notifications', policyRule: 'fixture:confirm', requiresApproval: true });
  enqueueAction({ actionId: action.id, tool: action.tool, arguments: action.arguments, approvalReference: 'fixture' });
  const before = getDb().prepare('SELECT * FROM action_queue').all();
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(startServer({ port: occupied.address().port, mode: 'personal' }), { code: 'EADDRINUSE' });
    assert.deepEqual(timers.map((item) => item.ms), [30000], 'Only the prepared WebSocket heartbeat may have been created');
    assert.ok(timers.every((item) => item.cleared));
    assert.deepEqual(getDb().prepare('SELECT * FROM action_queue').all(), before);
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM action_attempts').get().n, 0);
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM events WHERE type LIKE 'agent.action.%'").get().n, 0);
  } finally { await new Promise((resolve) => occupied.close(resolve)); }
}));

test('successful bind starts configured workers and ordinary close clears their timers', (t) => fixture(t, async ({ dir, timers, handles }) => {
  configureSync(dir);
  const handle = await startServer({ port: 0 }); handles.push(handle);
  assert.deepEqual(timers.map((item) => item.ms), [30000, 300000, 1234, 4321]);
  assert.ok(timers.every((item) => !item.cleared));
  await new Promise((resolve) => handle.server.close(resolve)); handles.pop();
  await handle.stopBackgroundWorkers();
  assert.ok(timers.every((item) => item.cleared));
}));

test('worker setup failure after bind closes the listener and drains partial startup', (t) => fixture(t, async ({ dir, timers }) => {
  configureSync(dir);
  const capture = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback, ms) => {
    if (ms === 1234) throw new Error('fixture queue setup unavailable');
    return capture(callback, ms);
  });
  let preparedServer;
  const create = http.createServer;
  t.mock.method(http, 'createServer', (...args) => { preparedServer = create(...args); return preparedServer; });
  await assert.rejects(startServer({ port: 0 }), /fixture queue setup unavailable/);
  assert.equal(preparedServer.listening, false);
  assert.deepEqual(timers.map((item) => item.ms), [30000, 300000]);
  assert.ok(timers.every((item) => item.cleared));
}));

test('background drain is idempotent, waits for active queue work and starts no continuation after stopping', (t) => fixture(t, async ({ timers, handles }) => {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let wakes = 0;
  t.mock.method(ActionQueueWorker.prototype, 'processNext', async () => { enter(); await gate; });
  t.mock.method(Agent.prototype, 'wakeWaitingRuns', async () => { wakes++; });
  const handle = await startServer({ port: 0 }); handles.push(handle);
  const queueTimer = timers.find((item) => item.ms === 1234);
  queueTimer.callback(); await entered;
  let drained = false;
  const stop = handle.stopBackgroundWorkers();
  assert.equal(handle.stopBackgroundWorkers(), stop);
  stop.then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); assert.equal(queueTimer.cleared, true);
  release(); await stop;
  assert.equal(drained, true); assert.equal(wakes, 0);
}));

test('another home failing to bind does not stop an existing runtime worker set', (t) => fixture(t, async ({ dir, timers, handles }) => {
  const active = await startServer({ port: 0 }); handles.push(active);
  const original = [...timers];
  const secondHome = path.join(dir, 'second-home');
  process.env.U2OS_HOME = secondHome;
  try {
    await assert.rejects(startServer({ port: active.port }), { code: 'EADDRINUSE' });
    assert.ok(original.every((item) => !item.cleared));
    assert.equal(timers.length, original.length + 1);
    assert.equal(timers.at(-1).cleared, true);
  } finally { process.env.U2OS_HOME = dir; }
}));
