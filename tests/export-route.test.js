import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-export-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir, handle) {
  syncScheduler.stopAll();
  await triggerEngine.stopAll();
  if (handle?.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('GET /api/export returns the documented domains and never leaks credentials/tokens/secrets', async () => {
  const dir = tempHome();
  let handle;
  try {
    // Same pattern as tests/connectors-security.test.js: store fake-but-
    // realistic secrets BEFORE boot, then assert none of them ever appear
    // in the export response body.
    writeEncryptedFile(
      'google',
      {
        clientId: 'test.apps.googleusercontent.com',
        clientSecret: 'FAKE_EXPORT_CLIENT_SECRET_VALUE',
        tokens: {
          calendar: {
            access_token: 'FAKE_EXPORT_ACCESS_TOKEN_VALUE',
            refresh_token: 'FAKE_EXPORT_REFRESH_TOKEN_VALUE',
            expiry: Date.now() + 3600_000,
          },
        },
      },
      dir
    );
    writeEncryptedFile('web-search', { apiKey: 'FAKE_EXPORT_BRAVE_API_KEY_VALUE' }, dir);

    handle = await startServer({ port: 0, disableAuthForTests: true });
    const port = handle.server.address().port;

    const res = await fetch(`http://127.0.0.1:${port}/api/export`);
    const bodyText = await res.text();

    assert.equal(res.status, 200);

    // Expected top-level shape.
    const parsed = JSON.parse(bodyText);
    for (const key of [
      'events',
      'entities',
      'facts',
      'relationships',
      'tasks',
      'calendar_events',
      'emails',
      'agent_actions',
    ]) {
      assert.ok(Array.isArray(parsed[key]), `expected top-level array key "${key}"`);
    }
    assert.ok(parsed.exportedAt, 'expected an exportedAt timestamp');

    // Seeded demo data means these arrays are non-trivial in the common
    // case, but the hard invariant under test is the absence of secrets,
    // not population counts.
    for (const secret of [
      'FAKE_EXPORT_CLIENT_SECRET_VALUE',
      'FAKE_EXPORT_ACCESS_TOKEN_VALUE',
      'FAKE_EXPORT_REFRESH_TOKEN_VALUE',
      'FAKE_EXPORT_BRAVE_API_KEY_VALUE',
    ]) {
      assert.doesNotMatch(bodyText, new RegExp(secret), `response body must never contain "${secret}"`);
    }
    // No key named "credentials" anywhere, and no generic secret/token
    // shaped field names either.
    assert.doesNotMatch(bodyText, /"credentials"/i);
    assert.doesNotMatch(bodyText, /master[_-]?key/i);
  } finally {
    await cleanup(dir, handle);
  }
});
