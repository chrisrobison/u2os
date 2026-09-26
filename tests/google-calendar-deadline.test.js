import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { storeTokens, getValidAccessToken } from '../server/integrations/oauth/google-oauth.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { listEvents, getEvent, syncChanges } from '../server/integrations/google-calendar-provider.js';
import { withGoogleRead } from '../server/integrations/google-read-deadline.js';

const PRIVATE = 'fixture-private-query-event-token-body';
const event = { id: 'fixture_event', summary: 'Fixture meeting', start: { dateTime: '2026-09-26T10:00:00Z' }, end: { dateTime: '2026-09-26T11:00:00Z' }, attendees: [{ email: 'fixture@example.test' }] };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function clock(expectedDelay = 30_000) {
  let callback, cleared = 0;
  return { setTimeout(fn, delay) { assert.equal(delay, expectedDelay); callback = fn; return 9; }, clearTimeout(id) { assert.equal(id, 9); cleared++; },
    fire() { assert.ok(callback); callback(); }, get cleared() { return cleared; } };
}
const ready = (pending, reached) => Promise.race([reached.promise, pending.then(() => { throw new Error('Read completed before the expected fixture stage'); })]);
const safe = (code) => (error) => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/); return true; };
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-calendar-deadline-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), created = createConnectionInstance(db, { connectorId: 'google', label: 'Fixture calendar account', status: 'connected', dataDir: home });
    const instance = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(created.id);
    storeTokens(instance.vault_key, 'calendar', { access_token: 'fixture-calendar-access', refresh_token: 'fixture-calendar-refresh', expires_in: 3600 }, home);
    const events = [], options = { dataDir: home, instance, db, correlationId: 'fixture-sync', eventBus: { publish: (value) => events.push(value) } };
    await operation({ home, db, instance, events, options });
  } finally {
    closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const operations = [
  ['list', (options) => listEvents({ from: '2026-09-26T00:00:00Z', to: '2026-09-27T00:00:00Z' }, options)],
  ['get', (options) => getEvent(`gcal_${options.instance.id}_fixture_event`, options)],
  ['sync', (options) => syncChanges(options)],
];
for (const [name, run] of operations) for (const stage of ['headers', 'body']) {
  test(`Calendar ${name} bounds stalled ${stage} and late completion writes no cache/events`, () => fixture(async (f) => {
    const timers = clock(), reached = deferred(), late = deferred(); let signal, calls = 0, parsed = 0, cancelled = 0;
    const response = { ok: true, body: { cancel() { cancelled++; } }, json() { parsed++; reached.resolve(); return stage === 'body' ? late.promise : Promise.resolve(name === 'get' ? event : { items: [event] }); } };
    const pending = run({ ...f.options, timers, fetchImpl: async (_url, init) => {
      calls++; signal = init.signal;
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-calendar-access');
      if (stage === 'headers') { reached.resolve(); return late.promise; } return response;
    } });
    const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
    late.resolve(stage === 'headers' ? response : name === 'get' ? event : { items: [event] }); await new Promise(setImmediate);
    assert.equal(calls, 1); if (stage === 'headers') assert.equal(parsed, 0);
    assert.equal(signal.aborted, true); assert.ok(cancelled >= 1); assert.equal(timers.cleared, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0); assert.deepEqual(f.events, []);
  }));
}

test('Calendar successful list/get/sync keep scoped IDs, selected headers, mappings and added/changed provenance', () => fixture(async (f) => {
  let current = event; const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-calendar-access');
    return { ok: true, json: async () => new URL(url).pathname.endsWith('/fixture_event') ? current : { items: [current] } };
  };
  assert.deepEqual(await syncChanges({ ...f.options, fetchImpl }), { synced: 1 });
  const rows = await operations[0][1]({ ...f.options, fetchImpl });
  assert.equal(rows[0].id, `gcal_${f.instance.id}_fixture_event`); assert.deepEqual(rows[0].attendees, ['fixture@example.test']);
  assert.equal((await operations[1][1]({ ...f.options, fetchImpl })).title, 'Fixture meeting');
  current = { ...event, start: { dateTime: '2026-09-26T12:00:00Z' }, end: { dateTime: '2026-09-26T13:00:00Z' } };
  await syncChanges({ ...f.options, fetchImpl });
  assert.deepEqual(f.events.map((item) => item.type), ['calendar.event_added', 'calendar.event_changed']);
  assert.ok(f.events.every((item) => item.metadata.provenance === 'sync:google-calendar' && item.metadata.correlationId === 'fixture-sync'));
  assert.ok(calls.some((url) => new URL(url).searchParams.get('timeMin') === '2026-09-26T00:00:00Z'));
}));

test('Calendar missing event returns null and discards 404 body without parsing it', () => fixture(async (f) => {
  let cancelled = 0;
  assert.equal(await operations[1][1]({ ...f.options, fetchImpl: async () => ({ ok: false, status: 404, body: { cancel() { cancelled++; } }, json() { throw new Error(PRIVATE); } }) }), null);
  assert.ok(cancelled >= 1); assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0);
}));

for (const [status, code] of [[400, 'UNAVAILABLE'], [401, 'AUTHORIZATION'], [403, 'AUTHORIZATION'], [429, 'RATE_LIMIT'], [503, 'UNAVAILABLE']]) {
  test(`Calendar HTTP ${status} fails safely without error-body parsing, cache/events or retries`, () => fixture(async (f) => {
    for (const [, run] of operations) {
      const timers = clock(); let calls = 0, cancelled = 0;
      await assert.rejects(run({ ...f.options, timers, fetchImpl: async () => { calls++; return { ok: false, status, body: { cancel() { cancelled++; } }, json() { throw new Error(PRIVATE); } }; } }),
        (error) => safe(`GOOGLE_READ_${code}`)(error) && error.status === status);
      assert.equal(calls, 1); assert.ok(cancelled >= 1); assert.equal(timers.cleared, 1);
    }
    assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0); assert.deepEqual(f.events, []);
  }));
}

for (const kind of ['transport', 'parser', 'forged error']) {
  test(`Calendar ${kind} cannot leak private upstream text or impersonate safe failures`, () => fixture(async (f) => {
    for (const [, run] of operations) {
      const timers = clock(); let signal;
      await assert.rejects(run({ ...f.options, timers, fetchImpl: async (_url, init) => {
        signal = init.signal; const error = new Error(PRIVATE); if (kind === 'forged error') error.code = 'GOOGLE_OAUTH_TIMEOUT';
        if (kind !== 'parser') throw error; return { ok: true, json: async () => { throw error; } };
      } }), safe('GOOGLE_READ_UNAVAILABLE'));
      assert.equal(signal.aborted, true); assert.equal(timers.cleared, 1);
    }
    assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0); assert.deepEqual(f.events, []);
  }));
}

test('Calendar operation timeout also blocks late refreshed credential persistence', () => fixture(async (f) => {
  writeEncryptedFile('google', { clientId: PRIVATE, clientSecret: PRIVATE }, f.home);
  storeTokens(f.instance.vault_key, 'calendar', { access_token: 'fixture-expired', refresh_token: 'fixture-refresh', expires_in: -1 }, f.home);
  const file = path.join(f.home, 'credentials', `${f.instance.vault_key}.enc.json`), before = fs.readFileSync(file);
  const timers = clock(), reached = deferred(), late = deferred(); let calls = 0;
  const pending = operations[0][1]({ ...f.options, timers, fetchImpl: async (url) => {
    calls++; assert.equal(url, 'https://oauth2.googleapis.com/token');
    return { ok: true, json() { reached.resolve(); return late.promise; } };
  } });
  const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
  late.resolve({ access_token: 'fixture-late-token', expires_in: 3600 }); await new Promise(setImmediate);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(calls, 1); assert.equal(timers.cleared, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0);
}));

test('containing Google read preserves a verified inner token timeout without trusting forged OAuth codes', () => fixture(async (f) => {
  writeEncryptedFile('google', { clientId: PRIVATE, clientSecret: PRIVATE }, f.home);
  storeTokens(f.instance.vault_key, 'calendar', { access_token: 'fixture-expired', refresh_token: 'fixture-refresh', expires_in: -1 }, f.home);
  const outer = clock(), inner = clock(10_000), reached = deferred(), late = deferred();
  const file = path.join(f.home, 'credentials', `${f.instance.vault_key}.enc.json`), before = fs.readFileSync(file);
  const pending = withGoogleRead({ timers: outer, fetchImpl: async () => ({ ok: true, json() { reached.resolve(); return late.promise; } }) },
    ({ fetchImpl }) => getValidAccessToken(f.instance.vault_key, 'calendar', { dataDir: f.home, fetchImpl, timers: inner }));
  const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); inner.fire(); await rejected;
  late.resolve({ access_token: 'fixture-late-access', expires_in: 3600 }); await new Promise(setImmediate);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(outer.cleared, 1); assert.equal(inner.cleared, 1);
}));

test('Calendar operation deadline interrupts native isolated HTTP body parsing', () => fixture(async (f) => {
  const timers = clock(), reached = deferred();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"items":'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pending = listEvents({}, { ...f.options, timers, fetchImpl: async (_url, init) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/fixture`, init);
      return { ok: true, body: response.body, json() { const body = response.json(); reached.resolve(); return body; } };
    } });
    const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
    assert.equal(timers.cleared, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}));

test('Calendar runtime deadlines cannot disable/expand the bound and may shorten it', () => fixture(async (f) => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 30_001]) {
    let calls = 0;
    await assert.rejects(listEvents({}, { ...f.options, timeoutMs, fetchImpl() { calls++; } }), safe('GOOGLE_READ_UNAVAILABLE')); assert.equal(calls, 0);
  }
  assert.deepEqual(await listEvents({}, { ...f.options, timeoutMs: 1, timers: { setTimeout(_fn, delay) { assert.equal(delay, 1); return 1; }, clearTimeout(id) { assert.equal(id, 1); } }, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }) }), []);
}));

test('Google read boundary refuses consequential/arbitrary POST before invoking transport', async () => {
  for (const [url, method] of [['https://www.googleapis.com/calendar/v3/calendars/primary/events', 'POST'], ['https://gmail.googleapis.com/gmail/v1/users/me/messages/send', 'POST'], ['https://example.test', 'POST'], ['https://oauth2.googleapis.com/token', 'DELETE']]) {
    let calls = 0;
    await assert.rejects(withGoogleRead({ fetchImpl() { calls++; } }, ({ fetchImpl }) => fetchImpl(url, { method })), safe('GOOGLE_READ_UNAVAILABLE')); assert.equal(calls, 0);
  }
});

test('failed Calendar refresh/read retains existing cached event evidence rather than mock substitution', () => fixture(async (f) => {
  await listEvents({}, { ...f.options, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [event] }) }) });
  const before = f.db.prepare('SELECT * FROM calendar_events').all();
  await assert.rejects(syncChanges({ ...f.options, fetchImpl: async () => ({ ok: false, status: 503 }) }), safe('GOOGLE_READ_UNAVAILABLE'));
  assert.deepEqual(f.db.prepare('SELECT * FROM calendar_events').all(), before); assert.deepEqual(f.events, []);
}));

test('operation deadline fired before startup performs no transport or cache work', () => fixture(async (f) => {
  const timers = clock(); let calls = 0;
  const pending = listEvents({}, { ...f.options, timers, fetchImpl() { calls++; } });
  const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); timers.fire(); await rejected; await new Promise(setImmediate);
  assert.equal(calls, 0); assert.equal(timers.cleared, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0);
}));

test('unconfigured selected Calendar account cannot borrow credentials or fall back to fake success', () => fixture(async (f) => {
  let calls = 0;
  await assert.rejects(listEvents({}, { ...f.options, instance: { ...f.instance, vault_key: 'missing-fixture-account' }, fetchImpl() { calls++; } }), safe('GOOGLE_READ_UNAVAILABLE'));
  assert.equal(calls, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 0);
}));
