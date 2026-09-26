import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { exchangeCodeForTokens, refreshAccessToken, getValidAccessToken, storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { writeEncryptedFile } from '../server/security/vault.js';

const PRIVATE = 'fixture-private-token-code-client-body';
const tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function clock() {
  let callback, cleared = 0;
  return { setTimeout(fn, delay) { assert.equal(delay, 10_000); callback = fn; return 17; }, clearTimeout(id) { assert.equal(id, 17); cleared++; },
    fire() { assert.ok(callback); callback(); }, get cleared() { return cleared; } };
}
const operations = [
  ['code exchange', (fetchImpl, options) => exchangeCodeForTokens({ clientId: PRIVATE, clientSecret: PRIVATE, code: PRIVATE, redirectUri: 'http://localhost/fixture' }, fetchImpl, options)],
  ['refresh', (fetchImpl, options) => refreshAccessToken({ clientId: PRIVATE, clientSecret: PRIVATE, refreshToken: PRIVATE }, fetchImpl, options)],
];
function safe(code) { return (error) => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /fixture-private|Bearer|oauth2\.googleapis/); return true; }; }
const readStarted = (pending, reading) => Promise.race([reading.promise, pending.then(() => { throw new Error('Request completed before the expected fixture body read'); })]);

for (const [name, request] of operations) {
  test(`Google ${name} preserves request/success shape and clears its deadline`, async () => {
    const timers = clock(); let calls = 0, signal;
    const result = await request(async (url, init) => {
      calls++; signal = init.signal; assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const body = new URLSearchParams(init.body); assert.equal(body.get('client_secret'), PRIVATE);
      assert.equal(body.get('grant_type'), name === 'refresh' ? 'refresh_token' : 'authorization_code');
      return { ok: true, json: async () => tokens };
    }, { timers });
    assert.deepEqual(result, name === 'refresh' ? { access_token: tokens.access_token, expires_in: 3600 } : tokens);
    assert.equal(calls, 1); assert.equal(signal.aborted, false); assert.equal(timers.cleared, 1);
  });

  test(`Google ${name} bounds non-cooperating header reads and discards late bodies without retry`, async () => {
    const timers = clock(), headers = deferred(); let calls = 0, parsed = 0, cancelled = 0, signal;
    const pending = request(async (_url, init) => { calls++; signal = init.signal; return headers.promise; }, { timers });
    const rejected = assert.rejects(pending, safe('GOOGLE_OAUTH_TIMEOUT')); timers.fire(); await rejected;
    headers.resolve({ ok: true, body: { cancel() { cancelled++; } }, json() { parsed++; return tokens; } });
    await new Promise(setImmediate);
    assert.equal(calls, 1); assert.equal(parsed, 0); assert.equal(cancelled, 1); assert.equal(signal.aborted, true); assert.equal(timers.cleared, 1);
  });

  test(`Google ${name} includes non-cooperating body parsing in the same deadline`, async () => {
    const timers = clock(), body = deferred(), reading = deferred(); let signal, cancelled = 0, returned = false;
    const pending = request(async (_url, init) => { signal = init.signal; return { ok: true, body: { cancel() { cancelled++; } }, json() { reading.resolve(); return body.promise; } }; }, { timers });
    pending.then(() => { returned = true; }, () => {});
    const rejected = assert.rejects(pending, safe('GOOGLE_OAUTH_TIMEOUT')); await readStarted(pending, reading); timers.fire(); await rejected;
    body.resolve(tokens); await new Promise(setImmediate);
    assert.equal(returned, false); assert.equal(signal.aborted, true); assert.ok(cancelled >= 1); assert.equal(timers.cleared, 1);
  });
}

test('Google token deadline aborts a native isolated HTTP response with a stalled JSON body', async () => {
  const timers = clock(), reading = deferred();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"access_token":'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pending = operations[0][1](async (_url, init) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/fixture`, init);
      return { ok: true, body: response.body, json() { const body = response.json(); reading.resolve(); return body; } };
    }, { timers });
    const rejected = assert.rejects(pending, safe('GOOGLE_OAUTH_TIMEOUT'));
    await readStarted(pending, reading); timers.fire(); await rejected; assert.equal(timers.cleared, 1);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

for (const [status, code] of [[400, 'AUTHORIZATION'], [401, 'AUTHORIZATION'], [403, 'AUTHORIZATION'], [429, 'RATE_LIMIT'], [503, 'UNAVAILABLE']]) {
  test(`Google token HTTP ${status} has sanitized actionable status and discards its body without retry`, async () => {
    for (const [, request] of operations) {
      const timers = clock(); let calls = 0, cancelled = 0;
      await assert.rejects(request(async () => { calls++; return { ok: false, status, body: { cancel() { cancelled++; } }, json() { throw new Error(PRIVATE); } }; }, { timers }),
        (error) => safe(`GOOGLE_OAUTH_${code}`)(error) && error.status === status);
      assert.equal(calls, 1); assert.ok(cancelled >= 1); assert.equal(timers.cleared, 1);
    }
  });
}

for (const kind of ['transport', 'parser', 'forged error']) {
  test(`Google token ${kind} cannot expose upstream text or impersonate a safe failure`, async () => {
    for (const [, request] of operations) {
      const timers = clock(); let signal;
      await assert.rejects(request(async (_url, init) => {
        signal = init.signal;
        const error = new Error(PRIVATE);
        if (kind === 'forged error') error.code = 'GOOGLE_OAUTH_AUTHORIZATION';
        if (kind !== 'parser') throw error;
        return { ok: true, json: async () => { throw error; } };
      }, { timers }), safe('GOOGLE_OAUTH_UNAVAILABLE'));
      assert.equal(signal.aborted, true); assert.equal(timers.cleared, 1);
    }
  });
}

test('Google malformed token shapes cannot appear as successful credentials', async () => {
  for (const [, request] of operations) for (const json of [null, [], {}, { ...tokens, access_token: ' ' }, { ...tokens, refresh_token: null }, { ...tokens, expires_in: '3600' }, { ...tokens, expires_in: -1 }]) {
    const timers = clock();
    await assert.rejects(request(async () => ({ ok: true, json: async () => json }), { timers }), safe('GOOGLE_OAUTH_UNAVAILABLE'));
    assert.equal(timers.cleared, 1);
  }
});

test('timed-out refresh never changes encrypted vault bytes even after its body finishes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-token-timeout-'));
  try {
    writeEncryptedFile('google', { clientId: PRIVATE, clientSecret: PRIVATE }, home);
    storeTokens('google__fixture', 'gmail', { ...tokens, expires_in: -1 }, home);
    const file = path.join(home, 'credentials', 'google__fixture.enc.json'), before = fs.readFileSync(file);
    const timers = clock(), body = deferred(), reading = deferred();
    const pending = getValidAccessToken('google__fixture', 'gmail', { dataDir: home, timers, fetchImpl: async () => ({ ok: true, json() { reading.resolve(); return body.promise; } }) });
    const rejected = assert.rejects(pending, safe('GOOGLE_OAUTH_TIMEOUT')); await readStarted(pending, reading); timers.fire(); await rejected;
    body.resolve({ ...tokens, access_token: 'fixture-late-token' }); await new Promise(setImmediate);
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(timers.cleared, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Google runtime deadline overrides cannot disable or expand the ten-second bound', async () => {
  for (const [, request] of operations) for (const timeoutMs of [0, -1, NaN, Infinity, 10_001]) {
    let calls = 0;
    await assert.rejects(request(() => { calls++; }, { timeoutMs }), safe('GOOGLE_OAUTH_UNAVAILABLE')); assert.equal(calls, 0);
  }
  const result = await operations[0][1](async () => ({ ok: true, json: async () => tokens }), {
    timeoutMs: 1, timers: { setTimeout(_fn, delay) { assert.equal(delay, 1); return 1; }, clearTimeout(id) { assert.equal(id, 1); } },
  });
  assert.deepEqual(result, tokens);
});
