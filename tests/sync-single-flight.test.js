import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance, findInstance, listInstances } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { triggerSync, startAll, reconcile, stopAll } from '../server/integrations/sync-scheduler.js';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function homes(count, run) {
  const previousHome = process.env.U2OS_HOME;
  const previousFetch = globalThis.fetch;
  const dirs = Array.from({ length: count }, () => fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-sync-flight-')));
  const records = dirs.map((dir) => { process.env.U2OS_HOME = dir; return { dir, db: getDb() }; });
  try { await run(records); }
  finally {
    await stopAll(); globalThis.fetch = previousFetch; closeAllForTests();
    if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}
function account({ dir, db }, label) {
  process.env.U2OS_HOME = dir;
  const created = createConnectionInstance(db, { connectorId: 'google', label, status: 'connected' });
  const instance = findInstance(db, 'google', created.id);
  for (const service of ['gmail', 'calendar']) storeTokens(instance.vault_key, service,
    { access_token: `fixture-${label}`, refresh_token: `fixture-refresh-${label}`, expires_in: 3600 }, dir);
  return instance;
}
function select(home, instance, domain = 'email') {
  process.env.U2OS_HOME = home.dir;
  const config = loadConnectorsConfig(home.dir);
  config[domain] = { ...config[domain], active: domain === 'email' ? 'gmail' : 'google-calendar', activeInstanceId: instance.id };
  saveConnectorsConfig(config, home.dir);
}
function options(home) { return { db: home.db, dataDir: home.dir }; }
const success = () => ({ ok: true, json: async () => ({ messages: [], items: [] }) });

test('concurrent explicit account syncs share work and health; completion permits a new owner retry', () => homes(1, async ([home]) => {
  const instance = account(home, 'first'); select(home, instance);
  const entered = deferred(), release = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; entered.resolve(); await release.promise; return success(); };
  const first = triggerSync('email', options(home)); await entered.promise;
  const second = triggerSync('email', options(home));
  release.resolve(); assert.deepEqual(await first, await second); assert.equal(calls, 1);
  assert.ok(listInstances(home.db, 'google')[0].sync.email.lastSyncAt);
  await triggerSync('email', options(home)); assert.equal(calls, 2);
}));

test('account selection, domain and data-home identity keep concurrent syncs independent', () => homes(2, async ([firstHome, secondHome]) => {
  const first = account(firstHome, 'first'), second = account(firstHome, 'second'), other = account(secondHome, 'other');
  const release = deferred(), entered = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 4) entered.resolve(); await release.promise; return success(); };
  select(firstHome, first); const a = triggerSync('email', options(firstHome));
  select(firstHome, second); const b = triggerSync('email', options(firstHome));
  select(firstHome, first, 'calendar'); const c = triggerSync('calendar', options(firstHome));
  select(secondHome, other); const d = triggerSync('email', options(secondHome));
  // Wait for provider entry, not a guessed number of promise turns.
  await entered.promise; assert.equal(calls, 4);
  release.resolve(); await Promise.all([a, b, c, d]);
  assert.ok(listInstances(firstHome.db, 'google').find((item) => item.id === first.id).sync.email.lastSyncAt);
  assert.ok(listInstances(firstHome.db, 'google').find((item) => item.id === second.id).sync.email.lastSyncAt);
  assert.ok(listInstances(secondHome.db, 'google')[0].sync.email.lastSyncAt);
}));

test('an outage is shared and sanitized, releases its flight and allows a later explicit retry', () => homes(1, async ([home]) => {
  const instance = account(home, 'outage'); select(home, instance);
  const entered = deferred(), release = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; entered.resolve(); await release.promise; return { ok: false, status: 429 }; };
  const a = triggerSync('email', options(home)); await entered.promise;
  const b = triggerSync('email', options(home));
  const settled = Promise.allSettled([a, b]);
  let drained = false; const drain = stopAll().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); release.resolve();
  const results = await settled;
  await drain; assert.equal(drained, true);
  assert.equal(calls, 1); assert.ok(results.every((result) => result.status === 'rejected' && /rate limited.*retry later/.test(result.reason.message)));
  assert.match(listInstances(home.db, 'google')[0].sync.email.lastError, /429/);
  globalThis.fetch = async () => { calls++; return success(); };
  await triggerSync('email', options(home)); assert.equal(calls, 2);
  assert.equal(listInstances(home.db, 'google')[0].sync.email.lastError, null);
}));

test('provider exceptions cannot leak private text and failed bookkeeping is released', () => homes(1, async ([home]) => {
  const instance = account(home, 'private-error'); select(home, instance);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('fixture-private-password and private message body'); };
  const results = await Promise.allSettled([triggerSync('email', options(home)), triggerSync('email', options(home))]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /check account credentials and provider availability/);
    assert.doesNotMatch(result.reason.message, /fixture-private-password|message body/);
  }
  assert.doesNotMatch(JSON.stringify(listInstances(home.db, 'google')), /fixture-private-password|message body/);
  await stopAll(); globalThis.fetch = async () => success();
  await triggerSync('email', options(home));
  assert.equal(listInstances(home.db, 'google')[0].sync.email.lastError, null);
}));

test('unavailable health storage cannot leak raw errors or prevent shutdown drain', () => homes(1, async ([home]) => {
  const instance = account(home, 'storage'); select(home, instance);
  const entered = deferred(), release = deferred();
  globalThis.fetch = async () => { entered.resolve(); await release.promise; return success(); };
  const result = triggerSync('email', options(home)); await entered.promise;
  const rejection = assert.rejects(result, /check account credentials and provider availability/);
  closeAllForTests();
  const drain = stopAll(); release.resolve(); await rejection; await drain;
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM connection_sync_state WHERE instance_id = ?').get(instance.id).n, 0);
}));

test('poll reconciliation preserves single-flight and stopped generations cannot start work; stop drains started writes', (t) => homes(1, async ([home]) => {
  const instance = account(home, 'poll'); select(home, instance);
  const callbacks = [], cleared = [];
  t.mock.method(globalThis, 'setInterval', (callback) => { callbacks.push(callback); return callbacks.length; });
  t.mock.method(globalThis, 'clearInterval', (handle) => cleared.push(handle));
  const entered = deferred(), release = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; entered.resolve(); await release.promise; return success(); };
  assert.deepEqual(startAll(options(home)).started, ['email']);
  callbacks[0](); await entered.promise;
  reconcile(options(home)); callbacks[0](); callbacks[1]();
  const manual = triggerSync('email', options(home));
  let drained = false;
  const drain = stopAll().then(() => { drained = true; });
  assert.deepEqual(cleared, [1, 2]); callbacks[0](); callbacks[1]();
  await Promise.resolve(); assert.equal(drained, false); assert.equal(calls, 1);
  release.resolve(); await drain; await manual;
  assert.equal(drained, true); assert.equal(calls, 1);
  assert.ok(listInstances(home.db, 'google')[0].sync.email.lastSyncAt);
}));
