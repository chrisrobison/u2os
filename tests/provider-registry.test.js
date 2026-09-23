import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider, getHealth, resolveConnectedRealProvider } from '../server/integrations/provider-registry.js';
import { setActiveProvider } from '../server/integrations/connectors-config.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { closeAllForTests } from '../server/db/connection.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-registry-test-'));
  process.env.U2OS_HOME = dir;
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
    writeEncryptedFile('google', {
      tokens: {
        gmail: { access_token: 'test-access', refresh_token: 'test-refresh', expiry: Date.now() + 60_000 },
        contacts: { access_token: 'test-access', refresh_token: 'test-refresh', expiry: Date.now() + 60_000 },
      },
    });

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
