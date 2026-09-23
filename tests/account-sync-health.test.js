import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance, deleteConnectionInstance, findInstance, listInstances } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { getHealth, recordSyncError, recordSyncSuccess, resetForTests, safeSyncError } from '../server/integrations/provider-registry.js';
import { triggerSync } from '../server/integrations/sync-scheduler.js';

function withHome(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-sync-health-'));
  process.env.U2OS_HOME = dir;
  try { return run(dir, getDb()); }
  finally {
    resetForTests();
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function googleAccount(db, dir, label) {
  const created = createConnectionInstance(db, { connectorId: 'google', label });
  const row = findInstance(db, 'google', created.id);
  const tokens = { access_token: `fixture-${label}`, refresh_token: `refresh-${label}`, expires_in: 3600 };
  storeTokens(row.vault_key, 'gmail', tokens, dir);
  storeTokens(row.vault_key, 'calendar', tokens, dir);
  return row;
}

function selectEmail(dir, instanceId) {
  const config = loadConnectorsConfig(dir);
  config.email = { ...config.email, active: 'gmail', activeInstanceId: instanceId };
  saveConnectorsConfig(config, dir);
}

test('sync errors give safe recovery guidance without echoing provider text', () => {
  assert.match(safeSyncError(new Error('gmail: syncChanges failed (status 401)')), /reconnect this account/);
  assert.match(safeSyncError(new Error('gmail: syncChanges failed (status 429)')), /retry later/);
  assert.doesNotMatch(safeSyncError(new Error('token fixture-secret expired')), /fixture-secret/);
});

test('account and Google service sync health remains separate across switching and SQLite reopen', () => withHome((dir, db) => {
  const first = googleAccount(db, dir, 'First');
  const second = googleAccount(db, dir, 'Second');
  selectEmail(dir, first.id);
  recordSyncSuccess('email', first.id, { db });
  recordSyncError('calendar', first.id, new Error('google-calendar: syncChanges failed (status 429)'), { db });
  recordSyncError('email', second.id, new Error('upstream token fixture-Second appeared in a response'), { db });

  let health = getHealth({ dataDir: dir }).find((entry) => entry.domain === 'email');
  assert.ok(health.lastSyncAt);
  assert.equal(health.lastError, null);
  selectEmail(dir, second.id);
  health = getHealth({ dataDir: dir }).find((entry) => entry.domain === 'email');
  assert.equal(health.lastSyncAt, null);
  assert.match(health.lastError, /check account credentials/);
  assert.doesNotMatch(health.lastError, /fixture-Second/);

  closeAllForTests();
  const reopened = getDb();
  const listed = listInstances(reopened, 'google');
  assert.ok(listed.find((row) => row.id === first.id).sync.email.lastSyncAt);
  assert.match(listed.find((row) => row.id === first.id).sync.calendar.lastError, /429/);
  assert.equal(listed.find((row) => row.id === second.id).sync.calendar, undefined);
  recordSyncSuccess('email', second.id, { db: reopened });
  assert.equal(listInstances(reopened, 'google').find((row) => row.id === second.id).sync.email.lastError, null);
  assert.match(listInstances(reopened, 'google').find((row) => row.id === first.id).sync.calendar.lastError, /429/);

  deleteConnectionInstance(reopened, { row: findInstance(reopened, 'google', second.id), dataDir: dir });
  health = getHealth({ dataDir: dir }).find((entry) => entry.domain === 'email');
  assert.equal(health.connected, false);
  assert.equal(health.lastSyncAt, null);
  assert.equal(health.lastError, null);
}));

test('an in-flight sync records health for the account that actually ran, even after selection changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-sync-health-race-'));
  process.env.U2OS_HOME = dir;
  const originalFetch = globalThis.fetch;
  try {
    const db = getDb();
    const first = googleAccount(db, dir, 'First');
    const second = googleAccount(db, dir, 'Second');
    selectEmail(dir, first.id);
    globalThis.fetch = async () => {
      selectEmail(dir, second.id);
      return { ok: true, json: async () => ({ messages: [] }) };
    };
    await triggerSync('email', { db, dataDir: dir });
    const listed = listInstances(db, 'google');
    assert.ok(listed.find((row) => row.id === first.id).sync.email.lastSyncAt);
    assert.equal(listed.find((row) => row.id === second.id).sync.email, undefined);
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ private: 'fixture-secret' }) });
    await assert.rejects(triggerSync('email', { db, dataDir: dir }), /status 429/);
    const afterFailure = listInstances(db, 'google');
    assert.match(afterFailure.find((row) => row.id === second.id).sync.email.lastError, /status 429/);
    assert.doesNotMatch(JSON.stringify(afterFailure), /fixture-secret/);
    assert.equal(afterFailure.find((row) => row.id === first.id).sync.email.lastError, null);
  } finally {
    globalThis.fetch = originalFetch;
    resetForTests();
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
