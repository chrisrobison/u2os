import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { setActiveProvider } from '../server/integrations/connectors-config.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';
import { activateGoogleProvider } from '../server/api/routes/connectors.js';
import { loadConnectorsConfig } from '../server/integrations/connectors-config.js';

// Capture the native implementation before startServer installs the test-only
// fetch wrapper that automatically authenticates requests to test servers.
const unauthenticatedFetch = globalThis.fetch;

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-connsec-test-'));
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

    const res = await unauthenticatedFetch(
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

test('only the state-protected OAuth callback is public among Google connector routes', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;

    const callback = await unauthenticatedFetch(
      `${origin}/api/connectors/google/oauth/callback?code=some-code&state=never-issued-state-xyz`,
      { redirect: 'manual' }
    );
    assert.equal(callback.status, 400);
    assert.match((await callback.json()).error, /state/i);

    const start = await unauthenticatedFetch(`${origin}/api/connectors/google/oauth/start?service=calendar`, {
      redirect: 'manual',
    });
    assert.equal(start.status, 401);
    assert.equal((await start.json()).error, 'Authentication required');

    const connectors = await unauthenticatedFetch(`${origin}/api/connectors`);
    assert.equal(connectors.status, 401);
  } finally {
    await cleanup(dir, handle);
  }
});

test('successful Google OAuth services activate their corresponding provider', () => {
  const dir = tempHome();
  try {
    activateGoogleProvider('calendar');
    activateGoogleProvider('gmail');
    activateGoogleProvider('contacts');

    const config = loadConnectorsConfig();
    assert.equal(config.calendar.active, 'google-calendar');
    assert.equal(config.email.active, 'gmail');
    assert.equal(config.contacts.active, 'google-contacts');
  } finally {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('connection-instance CRUD routes (#163 PR 2) never leak a stored secret across list/create/update/active/delete responses', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;
    const SECRET = 'sekrit-test-value-xyz';

    const createRes = await fetch(`http://127.0.0.1:${port}/api/connectors/imap/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Work IMAP', host: 'imap.example.com', username: 'alice', password: SECRET }),
    });
    const createBody = await createRes.text();
    assert.equal(createRes.status, 201, createBody);
    assert.doesNotMatch(createBody, new RegExp(SECRET), 'create response must never contain the stored secret');
    const created = JSON.parse(createBody);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/connectors/imap/instances`);
    const listBody = await listRes.text();
    assert.doesNotMatch(listBody, new RegExp(SECRET), 'list response must never contain the stored secret');

    const updateRes = await fetch(`http://127.0.0.1:${port}/api/connectors/imap/instances/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: `${SECRET}-rotated` }),
    });
    const updateBody = await updateRes.text();
    assert.equal(updateRes.status, 200, updateBody);
    assert.doesNotMatch(updateBody, new RegExp(SECRET), 'update response must never contain the stored secret');

    const activateRes = await fetch(`http://127.0.0.1:${port}/api/connectors/email/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorId: 'imap', instanceId: created.id, providerId: 'imap' }),
    });
    const activateBody = await activateRes.text();
    assert.equal(activateRes.status, 200, activateBody);
    assert.doesNotMatch(activateBody, new RegExp(SECRET), 'active-provider response must never contain the stored secret');

    const deleteRes = await fetch(`http://127.0.0.1:${port}/api/connectors/imap/instances/${created.id}`, { method: 'DELETE' });
    const deleteBody = await deleteRes.text();
    assert.equal(deleteRes.status, 200, deleteBody);
    assert.doesNotMatch(deleteBody, new RegExp(SECRET), 'delete response must never contain the stored secret');

    const overviewRes = await fetch(`http://127.0.0.1:${port}/api/connectors`);
    const overviewBody = await overviewRes.text();
    assert.doesNotMatch(overviewBody, new RegExp(SECRET), 'GET /api/connectors must never contain the stored secret');
  } finally {
    await cleanup(dir, handle);
  }
});

test(
  'switching calendar.active to google-calendar without an account blocks a consequential action',
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
      assert.equal(proposed.status, 'blocked');

      const db = handle.eventBus.db;
      const row = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(proposed.id);
      assert.ok(row);
      assert.equal(row.status, 'blocked');
      assert.equal(row.policy_rule, 'account-binding');
      assert.equal(row.tool, 'calendar.reschedule');
    } finally {
      await cleanup(dir, handle);
    }
  }
);
