import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  storeTokens,
  clearTokens,
  hasTokens,
  getValidAccessToken,
  buildAuthUrl,
} from '../server/integrations/oauth/google-oauth.js';
import { writeEncryptedFile, readEncryptedFile } from '../server/security/vault.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-oauth-test-'));
}

test('buildAuthUrl builds the accounts.google.com URL with expected params', () => {
  const url = buildAuthUrl({
    clientId: 'test.apps.googleusercontent.com',
    redirectUri: 'http://localhost:4000/api/connectors/google/oauth/callback',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: 'STATE123',
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), 'test.apps.googleusercontent.com');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');
  assert.equal(parsed.searchParams.get('state'), 'STATE123');
});

test('exchangeCodeForTokens posts the right form fields to the right URL', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 }) };
  };

  const result = await exchangeCodeForTokens(
    { clientId: 'cid', clientSecret: 'csec', redirectUri: 'http://localhost/cb', code: 'CODE1' },
    fetchImpl
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get('client_id'), 'cid');
  assert.equal(body.get('client_secret'), 'csec');
  assert.equal(body.get('redirect_uri'), 'http://localhost/cb');
  assert.equal(body.get('code'), 'CODE1');
  assert.equal(body.get('grant_type'), 'authorization_code');

  assert.equal(result.access_token, 'AT1');
  assert.equal(result.refresh_token, 'RT1');
  assert.equal(result.expires_in, 3600);
});

test('refreshAccessToken posts a refresh_token grant to the right URL', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ access_token: 'AT2', expires_in: 1800 }) };
  };

  const result = await refreshAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'RT1' }, fetchImpl);

  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'RT1');
  assert.equal(result.access_token, 'AT2');
  assert.equal(result.expires_in, 1800);
});

test('a refresh_token from a first exchange is preserved across a later refresh that omits one', async () => {
  const dir = tempHome();
  try {
    writeEncryptedFile('google', { clientId: 'cid', clientSecret: 'csec', tokens: {} }, dir);

    // First exchange: stores access + refresh token, already expired so the
    // next getValidAccessToken call is forced through the refresh path.
    storeTokens('google', 'calendar', { access_token: 'AT_OLD', refresh_token: 'RT_ORIG', expires_in: -1000 }, dir);

    const refreshCalls = [];
    const fetchImpl = async (url, opts) => {
      refreshCalls.push({ url, opts });
      // Google's refresh response omits refresh_token on subsequent refreshes.
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT_NEW', expires_in: 3600 }) };
    };

    const token = await getValidAccessToken('google', 'calendar', { dataDir: dir, fetchImpl });
    assert.equal(token, 'AT_NEW');
    assert.equal(refreshCalls.length, 1);
    const body = new URLSearchParams(refreshCalls[0].opts.body);
    assert.equal(body.get('refresh_token'), 'RT_ORIG');

    const stored = readEncryptedFile('google', dir);
    assert.equal(stored.tokens.calendar.access_token, 'AT_NEW');
    assert.equal(stored.tokens.calendar.refresh_token, 'RT_ORIG', 'refresh_token must survive a refresh that did not return a new one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getValidAccessToken throws a clear "not connected" error when no tokens are stored', async () => {
  const dir = tempHome();
  try {
    await assert.rejects(
      () =>
        getValidAccessToken('google', 'gmail', {
          dataDir: dir,
          fetchImpl: async () => { throw new Error('should not be called'); },
        }),
      /not connected/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// issue #163 PR 3: storeTokens/hasTokens/clearTokens/getValidAccessToken all
// take an explicit vaultKey now (the connection instance's vault key, e.g.
// 'google__conn_abc'), rather than always hardcoding the bare 'google' vault
// file -- these tests confirm two different vaultKeys are fully isolated
// from one another at the google-oauth.js level, independent of any
// route/instance-binding behavior (covered separately in
// tests/oauth-instance-binding.test.js).
test('storeTokens/hasTokens/clearTokens are fully isolated per vaultKey', async () => {
  const dir = tempHome();
  try {
    const vaultKeyA = 'google__conn_instanceA';
    const vaultKeyB = 'google__conn_instanceB';

    storeTokens(vaultKeyA, 'calendar', { access_token: 'AT_A', refresh_token: 'RT_A', expires_in: 3600 }, dir);

    assert.equal(hasTokens(vaultKeyA, 'calendar', dir), true);
    assert.equal(hasTokens(vaultKeyB, 'calendar', dir), false, 'a different vaultKey must never see instance A\'s tokens');

    storeTokens(vaultKeyB, 'calendar', { access_token: 'AT_B', refresh_token: 'RT_B', expires_in: 3600 }, dir);
    assert.equal(hasTokens(vaultKeyB, 'calendar', dir), true);

    const tokenA = await getValidAccessToken(vaultKeyA, 'calendar', {
      dataDir: dir,
      fetchImpl: async () => { throw new Error('should not need a refresh'); },
    });
    assert.equal(tokenA, 'AT_A', 'vaultKey A must resolve only to vaultKey A\'s stored token');

    clearTokens(vaultKeyA, 'calendar', dir);
    assert.equal(hasTokens(vaultKeyA, 'calendar', dir), false);
    assert.equal(hasTokens(vaultKeyB, 'calendar', dir), true, 'clearing vaultKey A must never affect vaultKey B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
