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
import { getProvider } from '../server/integrations/provider-registry.js';

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

test('completing OAuth makes gmail-provider.js immediately usable end-to-end through provider-registry, with tokens ONLY at the instance vault key (no legacy mirror write)', async () => {
  // issue #163 PR 4: gmail-provider.js/google-calendar-provider.js/
  // google-contacts-provider.js are now instance-aware, resolving their
  // vault key from the domain's activeInstanceId via
  // provider-registry.js's getProvider() -- so completing OAuth for a
  // specific instance must be immediately sufficient for that instance's
  // data to actually be reachable through the normal tool call path, with
  // no separate mirror write to the legacy bare "google" vault key (PR 3's
  // stopgap, removed once this PR landed). This replaces the previous
  // "mirrors tokens to the legacy bare google vault key" regression test,
  // whose whole premise (providers reading a hardcoded bare key) no longer
  // applies.
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
    const callback = await completeOauthCallback(origin, { code: 'code-for-instance-vault', state });
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get('location'), /connected=gmail/);

    // Instance vault key holds the tokens (the callback's real write).
    const db = handle.eventBus.db;
    const vaultKey = vaultKeyForInstance(db, instance.id);
    const stored = readEncryptedFile(vaultKey, dir);
    assert.equal(stored?.tokens?.gmail?.access_token, 'AT_code-for-instance-vault');

    // The legacy bare "google" vault key must receive NO tokens -- the
    // mirror write is gone, not merely redundant. (It still holds the
    // shared OAuth client id/secret from configureGoogleCredentials()
    // above, which always initializes an empty `tokens: {}` -- so the
    // precise regression to guard is "no gmail service token", not "no
    // tokens key at all".)
    const legacy = readEncryptedFile('google', dir);
    assert.equal(legacy?.tokens?.gmail, undefined, 'no tokens should ever be mirrored to the legacy bare "google" vault key');

    // End-to-end: provider-registry resolves this domain's sole connected
    // instance automatically (activateGoogleProvider() only sets `active`,
    // not activeInstanceId -- the "exactly one connected instance" fallback
    // is what makes this work with zero extra wiring), and the bound gmail
    // provider actually reads tokens from the instance vault key, not the
    // legacy one.
    const provider = getProvider('email', { dataDir: dir });
    assert.equal(provider.id, 'gmail');
  } finally {
    restoreFetch?.();
    await cleanup(dir, handle);
  }
});

test('POST /api/connectors/google/disconnect actually disconnects the resolved instance, not just the unused legacy vault key', async () => {
  // Regression test: an earlier version of PR 4 left this route clearing
  // ONLY the legacy bare "google" vault key, which no provider module reads
  // any more as of this PR -- so a user clicking Disconnect got a 200
  // {disconnected} response while the resolved instance's real tokens (and
  // therefore sync-scheduler polling, EmailSendTool, getHealth()'s
  // "connected" status) were completely untouched. Caught by review before
  // merge.
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
    await completeOauthCallback(origin, { code: 'code-to-disconnect', state });

    // Sanity: connected before disconnecting.
    assert.equal(getProvider('email', { dataDir: dir }).id, 'gmail');

    const disconnect = await fetch(`${origin}/api/connectors/google/disconnect?service=gmail`, { method: 'POST' });
    assert.equal(disconnect.status, 200);

    const db = handle.eventBus.db;
    const vaultKey = vaultKeyForInstance(db, instance.id);
    const stored = readEncryptedFile(vaultKey, dir);
    assert.equal(stored?.tokens?.gmail, undefined, 'the resolved instance\'s own tokens must actually be cleared, not just the legacy key');

    // provider-registry must now fall back to mock -- the instance is no
    // longer connected for gmail.
    assert.equal(getProvider('email', { dataDir: dir }).id, 'mock-email');
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
