import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider, getHealth, resolveConnectedRealProvider, captureAccountBinding, getProviderForBinding } from '../server/integrations/provider-registry.js';
import { setActiveProvider } from '../server/integrations/connectors-config.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { EmailSearchTool } from '../server/tools/email-tools.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-registry-test-'));
  process.env.U2OS_HOME = dir;
  ensureInstallationMode('demo', dir);
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('with no connectors.yaml, every domain resolves to its mock provider', () => {
  const dir = tempHome();
  try {
    assert.equal(getProvider('calendar').id, 'mock-calendar');
    assert.equal(getProvider('email').id, 'mock-email');
    assert.equal(getProvider('contacts').id, 'mock-contacts');
    assert.equal(getProvider('web').id, 'mock-web-search');
    assert.equal(getProvider('notifications').id, 'mock-notifications');

    const health = getHealth();
    assert.equal(health.length, 5);
    for (const entry of health) {
      assert.equal(entry.active, 'mock');
      assert.equal(entry.connected, true);
    }
  } finally {
    cleanup(dir);
  }
});

test('configuring a real provider without stored credentials falls back to mock, health reports not connected', () => {
  const dir = tempHome();
  try {
    setActiveProvider('calendar', 'google-calendar');

    const provider = getProvider('calendar');
    assert.equal(provider.id, 'mock-calendar', 'must gracefully fall back to the mock calendar provider');

    const health = getHealth();
    const calendarHealth = health.find((h) => h.domain === 'calendar');
    assert.equal(calendarHealth.active, 'google-calendar');
    assert.equal(calendarHealth.connected, false);

    // sync-scheduler must never treat this as a connected real provider.
    assert.equal(resolveConnectedRealProvider('calendar'), null);
  } finally {
    cleanup(dir);
  }
});

test('health reports connected real providers independently of the active provider', () => {
  const dir = tempHome();
  try {
    // issue #163 PR 4: credentials live at a connection instance's own
    // vault_key, not the legacy bare 'google' key -- getHealth()'s
    // connectedProviders now scans every live instance of a connector
    // (regardless of which one, if any, is the domain's active instance).
    const db = getDb();
    const instance = createConnectionInstance(db, { connectorId: 'google', label: 'Test account', status: 'connected' });
    const vaultKey = db.prepare('SELECT vault_key FROM connection_instances WHERE id = ?').get(instance.id).vault_key;
    storeTokens(vaultKey, 'gmail', { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
    storeTokens(vaultKey, 'contacts', { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });

    const health = getHealth();
    const email = health.find((entry) => entry.domain === 'email');
    const contacts = health.find((entry) => entry.domain === 'contacts');

    assert.equal(email.active, 'mock');
    assert.equal(email.connected, true, 'the active mock provider remains healthy');
    assert.deepEqual(email.connectedProviders, ['gmail']);
    assert.equal(contacts.active, 'mock');
    assert.deepEqual(contacts.connectedProviders, ['google-contacts']);
  } finally {
    cleanup(dir);
  }
});

test('unknown domain throws rather than silently returning undefined', () => {
  const dir = tempHome();
  try {
    assert.throws(() => getProvider('not-a-real-domain'));
  } finally {
    cleanup(dir);
  }
});

test('personal mode never resolves an unconfigured or disconnected service to mock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-personal-registry-'));
  process.env.U2OS_HOME = dir;
  try {
    ensureInstallationMode('personal', dir);
    for (const domain of ['calendar', 'email', 'contacts', 'web', 'notifications']) {
      assert.throws(() => getProvider(domain), { code: 'SERVICE_UNAVAILABLE' });
      assert.equal(getHealth().find((entry) => entry.domain === domain).connected, false);
    }
    assert.throws(() => captureAccountBinding('email'), { code: 'SERVICE_UNAVAILABLE' });
    await assert.rejects(new EmailSearchTool().execute({ query: 'anything' }), { code: 'SERVICE_UNAVAILABLE' });
    assert.throws(() => getProviderForBinding('email', { domain: 'email', providerId: 'mock', connectorId: null, instanceId: null }), { code: 'SERVICE_UNAVAILABLE' });
    setActiveProvider('calendar', 'google-calendar');
    assert.throws(() => getProvider('calendar'), /disconnected/);
    assert.equal(getHealth().find((entry) => entry.domain === 'calendar').active, 'google-calendar');
  } finally { cleanup(dir); }
});
