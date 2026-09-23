// issue #163 PR 3 of 5: /api/connectors/google/oauth/start and .../callback
// must bind each OAuth flow to a specific `google` connection instance
// (issue #163 PR 2's connection_instances table), rather than assuming a
// single global Google account. These tests exercise the full HTTP route
// pair against a real server instance -- see server/api/routes/connectors.js
// for the implementation and its "instance-confusion protection" comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { readEncryptedFile } from '../server/security/vault.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

// Capture the native implementation before startServer installs the
// test-only fetch wrapper that automatically authenticates requests to test
// servers -- needed to hit the public, unauthenticated OAuth callback route.
const unauthenticatedFetch = globalThis.fetch;

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-oauth-instance-test-'));
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

/** Intercepts only outbound calls to Google's token endpoint (the one
 * exchangeCodeForTokens() in server/integrations/oauth/google-oauth.js
 * posts to) and returns a canned, per-code-distinguishable token response,
 * so concurrent flows can be told apart by their resulting access_token.
 * Everything else (including requests to the test server's own origin) is
 * passed through unchanged. Returns a restore function. */
function installGoogleTokenExchangeMock() {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const bodyStr = typeof init.body === 'string' ? init.body : '';
      const code = new URLSearchParams(bodyStr).get('code') || 'unknown';
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `AT_${code}`, refresh_token: `RT_${code}`, expires_in: 3600 }),
      };
    }
    return previousFetch(input, init);
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

async function configureGoogleCredentials(origin) {
  const res = await fetch(`${origin}/api/connectors/google/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'test.apps.googleusercontent.com', clientSecret: 'FAKE_OAUTH_BINDING_CLIENT_SECRET_VALUE' }),
  });
  assert.equal(res.status, 200);
}

async function createGoogleInstance(origin, label) {
  const res = await fetch(`${origin}/api/connectors/google/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body;
}

/** Starts an OAuth flow for `instanceId` and returns the `state` value the
 * server minted, by following the 302 redirect's Location query string
 * (never actually navigating to accounts.google.com). */
async function startOauthFlow(origin, { service, instanceId }) {
  const res = await fetch(
    `${origin}/api/connectors/google/oauth/start?service=${encodeURIComponent(service)}&instanceId=${encodeURIComponent(instanceId)}`,
    { redirect: 'manual' }
  );
  return res;
}

function stateFromStartRedirect(res) {
  const location = res.headers.get('location');
  return new URL(location).searchParams.get('state');
}

async function completeOauthCallback(origin, { code, state }) {
  return unauthenticatedFetch(
    `${origin}/api/connectors/google/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' }
  );
}

function vaultKeyForInstance(db, instanceId) {
  const row = db.prepare('SELECT vault_key FROM connection_instances WHERE id = ?').get(instanceId);
  return row?.vault_key || null;
}

test('starting OAuth without instanceId is rejected', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;

    const res = await fetch(`${origin}/api/connectors/google/oauth/start?service=calendar`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /instanceId/i);
  } finally {
    await cleanup(dir, handle);
  }
});

test('starting OAuth with a nonexistent instanceId is rejected', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;

    const res = await fetch(
      `${origin}/api/connectors/google/oauth/start?service=calendar&instanceId=conn_does_not_exist`,
      { redirect: 'manual' }
    );
    assert.equal(res.status, 404);
  } finally {
    await cleanup(dir, handle);
  }
});

test('starting OAuth with a soft-deleted instanceId is rejected', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;

    const instance = await createGoogleInstance(origin, 'Soon-deleted account');
    const deleteRes = await fetch(`${origin}/api/connectors/google/instances/${instance.id}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 200);

    const res = await startOauthFlow(origin, { service: 'calendar', instanceId: instance.id });
    assert.equal(res.status, 404);
  } finally {
    await cleanup(dir, handle);
  }
});

test('two concurrent OAuth flows for two different google instances write tokens only to their own vault key', async () => {
  const dir = tempHome();
  let handle;
  let restoreFetch;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;
    const db = handle.eventBus.db;

    await configureGoogleCredentials(origin);
    const instanceA = await createGoogleInstance(origin, 'Account A');
    const instanceB = await createGoogleInstance(origin, 'Account B');

    restoreFetch = installGoogleTokenExchangeMock();

    // Start BOTH flows before completing either -- A and B are simultaneously
    // pending in the server's in-memory state map at this point.
    const startA = await startOauthFlow(origin, { service: 'calendar', instanceId: instanceA.id });
    assert.equal(startA.status, 302);
    const stateA = stateFromStartRedirect(startA);

    const startB = await startOauthFlow(origin, { service: 'gmail', instanceId: instanceB.id });
    assert.equal(startB.status, 302);
    const stateB = stateFromStartRedirect(startB);
    assert.notEqual(stateA, stateB);

    const vaultKeyA = vaultKeyForInstance(db, instanceA.id);
    const vaultKeyB = vaultKeyForInstance(db, instanceB.id);

    // Complete A's callback while B is still a live pending flow.
    const callbackA = await completeOauthCallback(origin, { code: 'code-for-A', state: stateA });
    assert.equal(callbackA.status, 302);
    assert.match(callbackA.headers.get('location'), /connected=calendar/);

    const storedA = readEncryptedFile(vaultKeyA, dir);
    assert.equal(storedA?.tokens?.calendar?.access_token, 'AT_code-for-A');

    // B's vault key must have NO tokens at all yet -- A's completion must
    // never leak into B's storage.
    const storedBAfterA = readEncryptedFile(vaultKeyB, dir);
    assert.equal(storedBAfterA, null, "instance B's vault key must be untouched by instance A's callback");

    // Now complete B's callback -- it must still work correctly and land
    // only in its own vault key.
    const callbackB = await completeOauthCallback(origin, { code: 'code-for-B', state: stateB });
    assert.equal(callbackB.status, 302);
    assert.match(callbackB.headers.get('location'), /connected=gmail/);

    const storedB = readEncryptedFile(vaultKeyB, dir);
    assert.equal(storedB?.tokens?.gmail?.access_token, 'AT_code-for-B');

    // A's vault key must still hold only A's tokens (no gmail service, no
    // cross-contamination from B's later completion).
    const storedAAfterB = readEncryptedFile(vaultKeyA, dir);
    assert.equal(storedAAfterB?.tokens?.gmail, undefined);
    assert.equal(storedAAfterB?.tokens?.calendar?.access_token, 'AT_code-for-A');
  } finally {
    restoreFetch?.();
    await cleanup(dir, handle);
  }
});

test('completing OAuth also mirrors tokens to the legacy bare "google" vault key, so gmail/calendar/contacts providers (still instance-unaware until #163 PR 4) keep finding them', async () => {
  // Regression test: an earlier version of this PR wrote tokens ONLY to
  // instance.vault_key. gmail-provider.js/google-calendar-provider.js/
  // google-contacts-provider.js all still hardcode reading the bare
  // 'google' key (LEGACY_VAULT_KEY, see those files) until PR 4 makes them
  // instance-aware -- so a completed OAuth flow reported success but left
  // every provider's isConnected()/authHeaders() unable to find the tokens
  // it had just stored. This asserts the STOPGAP mirror write in the
  // callback route keeps that legacy read path working.
  const dir = tempHome();
  let handle;
  let restoreFetch;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;

    await configureGoogleCredentials(origin);
    const instance = await createGoogleInstance(origin, 'Only account');
    restoreFetch = installGoogleTokenExchangeMock();

    const start = await startOauthFlow(origin, { service: 'gmail', instanceId: instance.id });
    const state = stateFromStartRedirect(start);
    const callback = await completeOauthCallback(origin, { code: 'code-for-legacy-mirror', state });
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get('location'), /connected=gmail/);

    const legacy = readEncryptedFile('google', dir);
    assert.equal(
      legacy?.tokens?.gmail?.access_token,
      'AT_code-for-legacy-mirror',
      'legacy "google" vault key must also receive the tokens, or gmail-provider.js/etc cannot find them'
    );
  } finally {
    restoreFetch?.();
    await cleanup(dir, handle);
  }
});

test('a callback whose instance was soft-deleted mid-flow is rejected cleanly, with no tokens written anywhere', async () => {
  const dir = tempHome();
  let handle;
  let restoreFetch;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;
    const db = handle.eventBus.db;

    await configureGoogleCredentials(origin);
    const instance = await createGoogleInstance(origin, 'Deleted mid-flow');
    const vaultKey = vaultKeyForInstance(db, instance.id);

    restoreFetch = installGoogleTokenExchangeMock();

    const start = await startOauthFlow(origin, { service: 'calendar', instanceId: instance.id });
    assert.equal(start.status, 302);
    const state = stateFromStartRedirect(start);

    // Concurrent request deletes the instance after /oauth/start but before
    // the callback completes.
    const deleteRes = await fetch(`${origin}/api/connectors/google/instances/${instance.id}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 200);

    const callback = await completeOauthCallback(origin, { code: 'code-for-deleted', state });
    // Must fail cleanly (the generic connect_failed redirect all callback
    // errors use), never a "connected" redirect and never a fallback to some
    // other/default instance.
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get('location'), /error=connect_failed/);
    assert.doesNotMatch(callback.headers.get('location'), /connected=/);

    assert.equal(readEncryptedFile(vaultKey, dir), null, 'no tokens may ever be written for a deleted instance');
  } finally {
    restoreFetch?.();
    await cleanup(dir, handle);
  }
});

test('existing CSRF protections still hold: an unknown state is rejected and a consumed state cannot be replayed', async () => {
  const dir = tempHome();
  let handle;
  let restoreFetch;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.server.address().port}`;

    // Unknown/never-issued state.
    const unknown = await completeOauthCallback(origin, { code: 'irrelevant', state: 'never-issued-state-xyz' });
    assert.equal(unknown.status, 400);
    const unknownBody = await unknown.json();
    assert.match(unknownBody.error, /state/i);

    // Single-use: replaying a consumed state must fail the second time.
    await configureGoogleCredentials(origin);
    const instance = await createGoogleInstance(origin, 'Replay test account');
    restoreFetch = installGoogleTokenExchangeMock();

    const start = await startOauthFlow(origin, { service: 'calendar', instanceId: instance.id });
    const state = stateFromStartRedirect(start);

    const first = await completeOauthCallback(origin, { code: 'first-use', state });
    assert.equal(first.status, 302);
    assert.match(first.headers.get('location'), /connected=calendar/);

    const replay = await completeOauthCallback(origin, { code: 'replayed-use', state });
    assert.equal(replay.status, 400, 'a consumed state must not be usable a second time');
    const replayBody = await replay.json();
    assert.match(replayBody.error, /state/i);
  } finally {
    restoreFetch?.();
    await cleanup(dir, handle);
  }
});
