import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { search } from '../server/integrations/brave-search-provider.js';
import { writeEncryptedFile } from '../server/security/vault.js';

const SECRET = 'private-fixture-search-value';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function clock() {
  let callback, cleared = false;
  return { setTimeout(fn, ms) { assert.equal(ms, 10000); callback = fn; return 71; }, clearTimeout(id) { assert.equal(id, 71); cleared = true; }, fire() { callback(); }, get cleared() { return cleared; } };
}
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-search-deadline-'));
  try {
    writeEncryptedFile('selected-search', { apiKey: SECRET }, home);
    writeEncryptedFile('other-search', { apiKey: 'not-selected' }, home);
    const timers = clock(), options = { dataDir: home, instance: { vault_key: 'selected-search' }, timers };
    await operation(options, timers);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
function safeFailure(code) { return (error) => error.code === code && !`${error.message}${error.stack}`.includes(SECRET); }

test('real search preserves selected credentials and successful results; timer is cleared', () => fixture(async (options, timers) => {
  let calls = 0;
  const result = await search({ query: SECRET }, { ...options, fetchImpl: async (url, init) => {
    calls++; assert.equal(new URL(url).searchParams.get('q'), SECRET); assert.equal(init.headers['X-Subscription-Token'], SECRET); assert.equal(init.signal.aborted, false);
    return { ok: true, json: async () => ({ web: { results: [{ title: 'Fixture', url: 'https://example.test/job', description: 'Evidence' }] } }) };
  } });
  assert.equal(calls, 1); assert.equal(timers.cleared, true);
  assert.deepEqual(result, { query: SECRET, results: [{ title: 'Fixture', url: 'https://example.test/job', snippet: 'Evidence' }] });
}));

test('header deadline aborts a non-cooperating fetch without retry; late body is discarded', () => fixture(async (options, timers) => {
  const pending = deferred(); let signal, calls = 0, cancelled = 0, parsed = 0;
  const request = search({ query: SECRET }, { ...options, fetchImpl: (_url, init) => { signal = init.signal; calls++; return pending.promise; } });
  const rejected = assert.rejects(request, safeFailure('SEARCH_TIMEOUT')); timers.fire(); await rejected;
  assert.equal(signal.aborted, true); assert.equal(timers.cleared, true);
  pending.resolve({ ok: true, body: { cancel() { cancelled++; } }, json: async () => { parsed++; return {}; } });
  await new Promise(setImmediate); assert.equal(calls, 1); assert.equal(parsed, 0); assert.equal(cancelled, 1);
}));

test('response parsing is within the same deadline; late results never report success', () => fixture(async (options, timers) => {
  const body = deferred(), reading = deferred(); let signal, cancelled = 0, success = false;
  const request = search({ query: SECRET }, { ...options, fetchImpl: async (_url, init) => {
    signal = init.signal; return { ok: true, body: { cancel() { cancelled++; } }, json() { reading.resolve(); return body.promise; } };
  } });
  request.then(() => { success = true; }, () => {});
  const rejected = assert.rejects(request, safeFailure('SEARCH_TIMEOUT')); await reading.promise; timers.fire(); await rejected;
  body.resolve({ web: { results: [{ title: SECRET }] } }); await new Promise(setImmediate);
  assert.equal(success, false); assert.equal(signal.aborted, true); assert.ok(cancelled >= 1); assert.equal(timers.cleared, true);
}));

test('native fetch aborts an isolated HTTP response whose JSON body never finishes', () => fixture(async (options, timers) => {
  const reading = deferred();
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"web":'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = search({ query: SECRET }, { ...options, fetchImpl: async (_url, init) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/fixture`, init);
      return { ok: response.ok, body: response.body, json() { const pending = response.json(); reading.resolve(); return pending; } };
    } });
    const rejected = assert.rejects(request, safeFailure('SEARCH_TIMEOUT'));
    await reading.promise; timers.fire(); await rejected; assert.equal(timers.cleared, true);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}));

for (const [status, code] of [[401,'SEARCH_AUTHORIZATION'],[403,'SEARCH_AUTHORIZATION'],[429,'SEARCH_RATE_LIMIT'],[503,'SEARCH_UNAVAILABLE']]) {
  test(`HTTP ${status} is actionable, sanitized, body-discarded and never retried`, () => fixture(async (options, timers) => {
    let calls = 0, cancelled = 0;
    await assert.rejects(search({ query: SECRET }, { ...options, fetchImpl: async () => {
      calls++; return { ok: false, status, body: { cancel() { cancelled++; } }, json() { throw new Error(SECRET); } };
    } }), (error) => safeFailure(code)(error) && error.status === status);
    assert.equal(calls, 1); assert.ok(cancelled >= 1); assert.equal(timers.cleared, true);
  }));
}

for (const kind of ['transport','parser','malformed','spoofed error']) {
  test(`${kind} failure cannot leak upstream text or impersonate sanitized errors`, () => fixture(async (options, timers) => {
    let signal;
    await assert.rejects(search({ query: SECRET }, { ...options, fetchImpl: async (_url, init) => {
      signal = init.signal;
      if (kind === 'transport' || kind === 'spoofed error') { const error = new Error(SECRET); if (kind === 'spoofed error') error.code = 'SEARCH_UNAVAILABLE'; throw error; }
      return { ok: true, json: async () => { if (kind === 'parser') throw new Error(SECRET); return null; } };
    } }), safeFailure('SEARCH_UNAVAILABLE'));
    assert.equal(signal.aborted, true); assert.equal(timers.cleared, true);
  }));
}

test('unconfigured selected account cannot borrow another credential or fabricate mock success', () => fixture(async (options) => {
  let calls = 0;
  await assert.rejects(search({ query: SECRET }, { ...options, instance: { vault_key: 'missing-search' }, fetchImpl() { calls++; } }), /not connected/);
  assert.equal(calls, 0);
}));

test('deadline overrides cannot disable or expand the runtime bound', () => fixture(async (options) => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 10001]) {
    let calls = 0;
    await assert.rejects(search({ query: SECRET }, { ...options, timeoutMs, fetchImpl() { calls++; } }), safeFailure('SEARCH_UNAVAILABLE'));
    assert.equal(calls, 0);
  }
}));
