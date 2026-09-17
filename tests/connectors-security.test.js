import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { setActiveProvider } from '../server/integrations/connectors-config.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-connsec-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir, handle) {
  syncScheduler.stopAll();
  if (handle?.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('GET /api/connectors never leaks a stored secret, access token, or client secret', async () => {
  const dir = tempHome();
  let handle;
  try {
    // Deliberately store fake-but-realistic secrets BEFORE boot, the way a
    // real owner would after pasting credentials into the Connectors page.
    writeEncryptedFile(
      'google',
      {
        clientId: 'test.apps.googleusercontent.com',
        clientSecret: 'FAKE_CLIENT_SECRET_VALUE',
        tokens: {
          calendar: {
            access_token: 'FAKE_ACCESS_TOKEN_VALUE',
            refresh_token: 'FAKE_REFRESH_TOKEN_VALUE',
            expiry: Date.now() + 3600_000,
          },
        },
      },
      dir
    );
    writeEncryptedFile('web-search', { apiKey: 'FAKE_BRAVE_API_KEY_VALUE' }, dir);
    writeEncryptedFile('notify-webhook', { webhookUrl: 'https://ntfy.sh/FAKE_TOPIC_VALUE', format: 'ntfy' }, dir);

    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const res = await fetch(`http://127.0.0.1:${port}/api/connectors`);
    const bodyText = await res.text();

    assert.equal(res.status, 200);
    for (const secret of [
      'FAKE_CLIENT_SECRET_VALUE',
      'FAKE_ACCESS_TOKEN_VALUE',
      'FAKE_REFRESH_TOKEN_VALUE',
      'FAKE_BRAVE_API_KEY_VALUE',
      'FAKE_TOPIC_VALUE',
    ]) {
      assert.doesNotMatch(bodyText, new RegExp(secret), `response body must never contain "${secret}"`);
    }

    // Sanity: the endpoint still reports real, non-secret status.
    const parsed = JSON.parse(bodyText);
    assert.equal(parsed.connectors.length, 5);
  } finally {
    await cleanup(dir, handle);
  }
});

test('OAuth callback rejects an unknown/never-issued state instead of silently accepting it', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const res = await fetch(
      `http://127.0.0.1:${port}/api/connectors/google/oauth/callback?code=some-code&state=never-issued-state-xyz`,
      { redirect: 'manual' }
    );

    // Must NOT be treated as a successful connect (a 3xx redirect to
    // ?connected=... would mean the forged callback was accepted).
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /state/i);
  } finally {
    await cleanup(dir, handle);
  }
});

test(
  'switching calendar.active to google-calendar (not connected) never bypasses policy -- reschedule still requires approval, identical to the mock path',
  async () => {
    const dir = tempHome();
    let handle;
    try {
      handle = await startServer({ port: 0 });

      // Configure the domain for the real connector, but never connect it
      // (no stored Google tokens) -- provider-registry must fall back to
      // mock for the actual data, and MORE IMPORTANTLY the policy gate must
      // not care either way.
      setActiveProvider('calendar', 'google-calendar', dir);

      const result = await handle.agent.handleMessage({
        text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.',
        actorId: 'user',
      });

      assert.equal(result.actions.length, 1);
      const proposed = result.actions[0];
      assert.equal(proposed.tool, 'calendar.reschedule');
      assert.equal(proposed.status, 'pending', 'must still require approval, exactly like the mock-provider path');

      const db = handle.eventBus.db;
      const row = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(proposed.id);
      assert.ok(row);
      assert.equal(row.status, 'pending');
      assert.equal(row.requires_approval, 1);
      assert.equal(row.tool, 'calendar.reschedule');
    } finally {
      await cleanup(dir, handle);
    }
  }
);
