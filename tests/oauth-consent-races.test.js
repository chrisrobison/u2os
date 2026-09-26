import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { readEncryptedFile } from '../server/security/vault.js';
import { loadConnectorsConfig } from '../server/integrations/connectors-config.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-consent-race-'));
  const oldHome = process.env.U2OS_HOME, nativeFetch = globalThis.fetch;
  process.env.U2OS_HOME = home;
  let handle; const slots = new Map(), callbacks = [], unexpected = [];
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.port}`;
    const setup = await nativeFetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'fixture-only consent owner passphrase' }) });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get('set-cookie').split(';')[0], csrf = (await setup.json()).csrfToken;
    const api = async (route, { body, method = body === undefined ? 'GET' : 'POST', status = 200 } = {}) => {
      const response = await nativeFetch(`${origin}${route}`, { method, redirect: 'manual', headers: { cookie, origin, 'x-u2os-csrf': csrf, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(response.status, status); return response;
    };
    const configure = (suffix = '') => api('/api/connectors/google/credentials', { body: { clientId: `fixture-client${suffix}`, clientSecret: `fixture-secret${suffix}` } });
    await configure();
    const account = await (await api('/api/connectors/google/instances', { body: { label: 'Intended fixture account' }, status: 201 })).json();
    const row = getDb().prepare('SELECT * FROM connection_instances WHERE id=?').get(account.id);
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url !== 'https://oauth2.googleapis.com/token') { unexpected.push(url); throw new Error('Fixture prohibits unexpected external network'); }
      const code = new URLSearchParams(init.body).get('code'), slot = slots.get(code);
      assert.ok(slot, 'only an explicitly prepared fixture exchange is allowed');
      slot.calls++; slot.reached.resolve();
      return slot.reply.promise;
    };
    const start = async (instanceId = account.id) => {
      const response = await api(`/api/connectors/google/oauth/start?service=gmail&instanceId=${instanceId}`, { status: 302 });
      return new URL(response.headers.get('location')).searchParams.get('state');
    };
    const exchange = (state, code = 'fixture-code') => {
      const slot = { reached: deferred(), reply: deferred(), calls: 0 };
      slot.complete = () => slot.reply.resolve({ ok: true, json: async () => ({ access_token: `fixture-access-${code}`, refresh_token: `fixture-refresh-${code}`, expires_in: 3600 }) });
      slots.set(code, slot);
      const response = nativeFetch(`${origin}/api/connectors/google/oauth/callback?state=${state}&code=${code}`, { redirect: 'manual' });
      slot.ready = () => Promise.race([slot.reached.promise, response.then(() => { throw new Error('Callback returned before the expected fixture exchange'); })]);
      callbacks.push(response); slot.response = response; return slot;
    };
    const snapshot = () => {
      const file = path.join(home, 'credentials', `${row.vault_key}.enc.json`);
      return { bytes: fs.existsSync(file) ? fs.readFileSync(file) : null, row: getDb().prepare('SELECT * FROM connection_instances WHERE id=?').get(account.id), config: loadConnectorsConfig(home) };
    };
    await operation({ home, account, row, api, configure, start, exchange, snapshot });
    assert.deepEqual(unexpected, []);
  } finally {
    for (const slot of slots.values()) slot.complete();
    await Promise.allSettled(callbacks);
    if (handle) await handle.shutdown();
    closeAllForTests(); globalThis.fetch = nativeFetch;
    if (oldHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const changes = [
  ['disconnect', (f) => f.api(`/api/connectors/google/instances/${f.account.id}/disconnect?service=gmail`, { body: {} })],
  ['removal', (f) => f.api(`/api/connectors/google/instances/${f.account.id}`, { method: 'DELETE' })],
  ['OAuth client replacement', (f) => f.configure('-replacement')],
  ['held account status', (f) => getDb().prepare("UPDATE connection_instances SET status='error' WHERE id=?").run(f.account.id)],
];
for (const [label, change] of changes) for (const during of [false, true]) {
  test(`OAuth ${label} ${during ? 'during exchange' : 'during consent'} cannot reconnect or change selection`, () => fixture(async (f) => {
    const state = await f.start();
    let exchange;
    if (during) { exchange = f.exchange(state); await exchange.ready(); }
    await change(f); const before = f.snapshot();
    if (!during) exchange = f.exchange(state);
    exchange.complete(); const response = await exchange.response;
    assert.equal(response.status, 302); assert.match(response.headers.get('location'), /error=connect_failed/);
    assert.equal(exchange.calls, during ? 1 : 0);
    assert.deepEqual(f.snapshot(), before, 'late completion must not write vault, row or active selection');
    const replay = await f.api(`/api/connectors/google/oauth/callback?state=${state}&code=fixture-code`, { status: 400 });
    assert.match((await replay.json()).error, /Invalid or expired/);
  }));
}

test('OAuth exchange completing after consent expiry is discarded without writes', (context) => fixture(async (f) => {
  const state = await f.start(), exchange = f.exchange(state);
  await exchange.ready(); const before = f.snapshot(), future = Date.now() + 600_001;
  context.mock.method(Date, 'now', () => future);
  exchange.complete(); const response = await exchange.response;
  assert.match(response.headers.get('location'), /error=connect_failed/); assert.deepEqual(f.snapshot(), before);
}));

test('expired consent is rejected before starting any code exchange', (context) => fixture(async (f) => {
  const state = await f.start(), before = f.snapshot(), future = Date.now() + 600_001;
  context.mock.method(Date, 'now', () => future);
  const exchange = f.exchange(state); exchange.complete();
  assert.equal((await exchange.response).status, 400);
  assert.equal(exchange.calls, 0); assert.deepEqual(f.snapshot(), before);
}));

test('first completed OAuth flow invalidates competing same-account consent before exchange', () => fixture(async (f) => {
  const firstState = await f.start(), secondState = await f.start();
  const first = f.exchange(firstState, 'first'); await first.ready(); first.complete();
  assert.match((await first.response).headers.get('location'), /connected=gmail/);
  const before = f.snapshot(), second = f.exchange(secondState, 'second'); second.complete();
  assert.match((await second.response).headers.get('location'), /error=connect_failed/);
  assert.equal(second.calls, 0); assert.deepEqual(f.snapshot(), before);
}));

test('first completed OAuth flow invalidates a same-account exchange already awaiting Google', () => fixture(async (f) => {
  const firstState = await f.start(), secondState = await f.start();
  const first = f.exchange(firstState, 'first'), second = f.exchange(secondState, 'second');
  await Promise.all([first.ready(), second.ready()]); second.complete();
  assert.match((await second.response).headers.get('location'), /connected=gmail/);
  const before = f.snapshot(); first.complete();
  assert.match((await first.response).headers.get('location'), /error=connect_failed/); assert.deepEqual(f.snapshot(), before);
}));

test('label-only rename and unrelated account removal retain legitimate bound OAuth completion', () => fixture(async (f) => {
  const other = await (await f.api('/api/connectors/google/instances', { body: { label: 'Other fixture account' }, status: 201 })).json();
  const state = await f.start(), exchange = f.exchange(state); await exchange.ready();
  await f.api(`/api/connectors/google/instances/${f.account.id}`, { method: 'PATCH', body: { label: 'Renamed intended account' } });
  await f.api(`/api/connectors/google/instances/${other.id}`, { method: 'DELETE' });
  exchange.complete(); const response = await exchange.response;
  assert.match(response.headers.get('location'), /connected=gmail/);
  assert.equal(readEncryptedFile(f.row.vault_key, f.home).tokens.gmail.access_token, 'fixture-access-fixture-code');
  assert.deepEqual(readEncryptedFile('google', f.home).tokens, {});
  assert.equal(loadConnectorsConfig(f.home).email.activeInstanceId, f.account.id);
}));

test('OAuth callback failure never logs raw private transport exceptions', (context) => fixture(async (f) => {
  const logs = []; context.mock.method(console, 'error', (...args) => logs.push(args));
  const state = await f.start();
  globalThis.fetch = async () => { throw new Error('fixture-private-token-code-client-secret'); };
  const response = await f.exchange(state).response;
  assert.match(response.headers.get('location'), /error=connect_failed/);
  assert.ok(logs.length > 0); assert.doesNotMatch(JSON.stringify(logs), /fixture-private|fixture-secret|fixture-code/);
  assert.equal(f.snapshot().bytes, null);
}));
