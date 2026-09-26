import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { searchContacts, syncChanges } from '../server/integrations/google-contacts-provider.js';
import { safeSyncError } from '../server/integrations/provider-registry.js';

const PRIVATE = 'fixture-private-contact-token-body';
const person = (resourceName = 'people/c123', displayName = 'Fixture Ada') => ({ resourceName,
  names: [{ displayName }], emailAddresses: [{ value: 'ada@example.test' }], phoneNumbers: [{ value: '+15555550123' }] });
const response = (connections) => ({ ok: true, json: async () => ({ connections }) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const ready = (pending, reached) => Promise.race([reached.promise, pending.then(() => { throw new Error('Read completed before fixture stage'); })]);
const safe = (code) => (error) => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/); return true; };
function clock() {
  let callback, cleared = 0;
  return { setTimeout(fn, delay) { assert.equal(delay, 30_000); callback = fn; return 7; }, clearTimeout(id) { assert.equal(id, 7); cleared++; },
    fire() { assert.ok(callback); callback(); }, get cleared() { return cleared; } };
}
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-contacts-deadline-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), instance = { id: 'fixture_account', vault_key: 'google__fixture_account', metadata: '{}' }, events = [];
    storeTokens(instance.vault_key, 'contacts', { access_token: 'fixture-contacts-access', refresh_token: 'fixture-contacts-refresh', expires_in: 3600 }, home);
    await operation({ home, db, instance, events, options: { dataDir: home, instance, correlationId: 'fixture-sync', eventBus: { publish: (event) => events.push(event) } } });
  } finally {
    closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const snapshot = (db) => ({ entities: db.prepare('SELECT * FROM entities ORDER BY id').all(), facts: db.prepare('SELECT * FROM facts ORDER BY id').all() });
const operations = [['search', (options) => searchContacts({ query: 'ada' }, options)], ['sync', (options) => syncChanges(options)]];

for (const [name, run] of operations) for (const stage of ['headers', 'body']) {
  test(`Contacts ${name} ${stage} timeout discards late entities, facts and sync events`, () => fixture(async (f) => {
    await searchContacts({}, { ...f.options, fetchImpl: async () => response([person()]) });
    const before = snapshot(f.db), timers = clock(), reached = deferred(), late = deferred(); let signal, calls = 0, parsed = 0, cancelled = 0;
    const reply = { ok: true, body: { cancel() { cancelled++; } }, json() { parsed++; reached.resolve(); return stage === 'body' ? late.promise : Promise.resolve({ connections: [person('people/late')] }); } };
    const pending = run({ ...f.options, timers, fetchImpl: async (_url, init) => {
      calls++; signal = init.signal; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-contacts-access');
      if (stage === 'headers') { reached.resolve(); return late.promise; } return reply;
    } });
    const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
    late.resolve(stage === 'headers' ? reply : { connections: [person('people/late')] }); await new Promise(setImmediate);
    assert.equal(calls, 1); if (stage === 'headers') assert.equal(parsed, 0);
    assert.equal(signal.aborted, true); assert.ok(cancelled >= 1); assert.equal(timers.cleared, 1);
    assert.deepEqual(snapshot(f.db), before); assert.deepEqual(f.events, []);
  }));
}

test('Contacts search filters fetched names, preserves scoped identities/facts and sync provenance', () => fixture(async (f) => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++; assert.equal(new URL(url).hostname, 'people.googleapis.com'); assert.equal(init.method || 'GET', 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-contacts-access');
    return response([person(), person('people/grace', 'Fixture Grace'), { resourceName: 'people/unnamed' }]);
  };
  const rows = await searchContacts({ query: 'ADA' }, { ...f.options, fetchImpl });
  assert.deepEqual(rows.map((row) => row.id), ['gc_fixture_account_people_c123']);
  assert.equal(rows[0].attributes.resourceName, 'people/c123');
  const facts = f.db.prepare('SELECT * FROM facts WHERE entity_id = ? ORDER BY key').all(rows[0].id);
  assert.deepEqual(facts.map((fact) => [fact.key, JSON.parse(fact.value), fact.source, fact.inferred, fact.confidence]),
    [['email', 'ada@example.test', 'google-contacts', 0, 1], ['phone', '+15555550123', 'google-contacts', 0, 1]]);
  assert.deepEqual(await syncChanges({ ...f.options, fetchImpl }), { synced: 3 });
  assert.equal(calls, 2); assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0], { type: 'contacts.synced', source: 'google-contacts', data: { count: 3 }, metadata: { correlationId: 'fixture-sync', provenance: 'sync:google-contacts' } });
  assert.deepEqual(f.db.prepare('SELECT id FROM facts WHERE entity_id = ? ORDER BY key').all(rows[0].id).map((fact) => fact.id), facts.map((fact) => fact.id));
}));

test('Contacts legacy IDs and independent accounts remain unchanged across repeated imports', () => fixture(async (f) => {
  const legacy = { ...f.instance, metadata: JSON.stringify({ migratedFrom: 'legacy-single-file' }) };
  const other = { id: 'other_account', vault_key: 'google__other', metadata: '{}' };
  storeTokens(other.vault_key, 'contacts', { access_token: 'fixture-other', refresh_token: 'fixture-other-refresh', expires_in: 3600 }, f.home);
  const fetchImpl = async () => response([person()]);
  const old = await searchContacts({}, { ...f.options, instance: legacy, fetchImpl });
  assert.equal(old[0].id, 'gc_people_c123');
  const oldFacts = f.db.prepare('SELECT id FROM facts WHERE entity_id = ? ORDER BY id').all(old[0].id);
  await searchContacts({}, { ...f.options, instance: legacy, fetchImpl });
  assert.deepEqual(f.db.prepare('SELECT id FROM facts WHERE entity_id = ? ORDER BY id').all(old[0].id), oldFacts);
  await searchContacts({}, { ...f.options, fetchImpl });
  const before = snapshot(f.db);
  const rows = await searchContacts({}, { ...f.options, instance: other, fetchImpl });
  assert.equal(rows[0].id, 'gc_other_account_people_c123');
  for (const entity of before.entities) assert.deepEqual(f.db.prepare('SELECT * FROM entities WHERE id = ?').get(entity.id), entity);
  for (const fact of before.facts) assert.deepEqual(f.db.prepare('SELECT * FROM facts WHERE id = ?').get(fact.id), fact);
}));

for (const status of [401, 403, 404, 429, 503]) {
  test(`Contacts status ${status} fails without importing/reading private error text and retains actionable health`, () => fixture(async (f) => {
    let calls = 0;
    const error = await syncChanges({ ...f.options, fetchImpl: async () => { calls++; return { ok: false, status, json() { throw new Error(PRIVATE); } }; } }).then(() => assert.fail('expected failure'), (error) => error);
    safe([401, 403].includes(status) ? 'GOOGLE_READ_AUTHORIZATION' : status === 429 ? 'GOOGLE_READ_RATE_LIMIT' : 'GOOGLE_READ_UNAVAILABLE')(error);
    assert.equal(error.status, status); assert.doesNotMatch(safeSyncError(error), /fixture-private/);
    assert.match(safeSyncError(error), new RegExp(`status ${status}`));
    assert.deepEqual(snapshot(f.db), { entities: [], facts: [] }); assert.deepEqual(f.events, []); assert.equal(calls, 1);
  }));
}

for (const [name, json] of [
  ['null page', null], ['array page', []], ['null connections', { connections: null }], ['invalid connections', { connections: {} }],
  ['missing identity', { connections: [person(), { names: [{ displayName: 'No identity' }] }] }],
  ['blank identity', { connections: [person('  ')] }], ['numeric identity', { connections: [person(123)] }],
  ['invalid names', { connections: [{ ...person(), names: [{ displayName: {} }] }] }],
  ['primitive name', { connections: [{ ...person(), names: ['not a name object'] }] }],
  ['invalid phone', { connections: [{ ...person(), phoneNumbers: [{ value: ' ' }] }] }],
  ['invalid fact', { connections: [person(), { ...person('people/bad'), emailAddresses: [{ value: {} }] }] }],
]) {
  test(`Contacts rejects ${name} before creating any personal entities or facts`, () => fixture(async (f) => {
    await assert.rejects(syncChanges({ ...f.options, fetchImpl: async () => ({ ok: true, json: async () => json }) }), safe('GOOGLE_READ_UNAVAILABLE'));
    assert.deepEqual(snapshot(f.db), { entities: [], facts: [] }); assert.deepEqual(f.events, []);
  }));
}

test('Contacts empty page is a valid empty observation, not invented evidence', () => fixture(async (f) => {
  assert.deepEqual(await searchContacts({}, { ...f.options, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), []);
  assert.deepEqual(snapshot(f.db), { entities: [], facts: [] });
}));

for (const stage of ['transport', 'parser']) {
  test(`Contacts ${stage} exception text/codes cannot forge an actionable failure or leak private data`, () => fixture(async (f) => {
    const error = Object.assign(new Error(PRIVATE), { code: 'GOOGLE_READ_AUTHORIZATION', status: 401 });
    await assert.rejects(searchContacts({}, { ...f.options, fetchImpl: async () => {
      if (stage === 'transport') throw error;
      return { ok: true, json() { throw error; } };
    } }), safe('GOOGLE_READ_UNAVAILABLE'));
    assert.deepEqual(snapshot(f.db), { entities: [], facts: [] });
  }));
}

test('Contacts operation timeout during OAuth refresh cannot persist late credentials or import contacts', () => fixture(async (f) => {
  writeEncryptedFile('google', { clientId: PRIVATE, clientSecret: PRIVATE }, f.home);
  storeTokens(f.instance.vault_key, 'contacts', { access_token: 'fixture-expired', refresh_token: 'fixture-refresh', expires_in: -1 }, f.home);
  const file = path.join(f.home, 'credentials', `${f.instance.vault_key}.enc.json`);
  const before = fs.readFileSync(file), timers = clock(), reached = deferred(), late = deferred(); let calls = 0;
  const pending = syncChanges({ ...f.options, timers, fetchImpl: async (url) => {
    calls++; assert.equal(url, 'https://oauth2.googleapis.com/token'); return { ok: true, json() { reached.resolve(); return late.promise; } };
  } });
  const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
  late.resolve({ access_token: 'fixture-late-access', expires_in: 3600 }); await new Promise(setImmediate);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(calls, 1); assert.equal(timers.cleared, 1);
  assert.deepEqual(snapshot(f.db), { entities: [], facts: [] }); assert.deepEqual(f.events, []);
}));

test('Contacts missing selected credentials cannot borrow another account; bounded overrides cannot disable deadline', () => fixture(async (f) => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 30_001]) {
    let calls = 0; await assert.rejects(searchContacts({}, { ...f.options, timeoutMs, fetchImpl() { calls++; } }), safe('GOOGLE_READ_UNAVAILABLE')); assert.equal(calls, 0);
  }
  let calls = 0;
  await assert.rejects(searchContacts({}, { ...f.options, instance: { ...f.instance, vault_key: 'fixture-missing' }, fetchImpl() { calls++; } }), safe('GOOGLE_READ_UNAVAILABLE'));
  assert.equal(calls, 0); assert.deepEqual(snapshot(f.db), { entities: [], facts: [] });
}));

test('Contacts native isolated HTTP stalled body aborts without personal imports or successful sync', () => fixture(async (f) => {
  const timers = clock(), reached = deferred();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"connections":'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pending = syncChanges({ ...f.options, timers, fetchImpl: async (_url, init) => {
      const reply = await fetch(`http://127.0.0.1:${server.address().port}/fixture`, init);
      return { ok: true, body: reply.body, json() { const body = reply.json(); reached.resolve(); return body; } };
    } });
    const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
    assert.equal(timers.cleared, 1); assert.deepEqual(snapshot(f.db), { entities: [], facts: [] }); assert.deepEqual(f.events, []);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}));

test('Contacts deadline before startup cannot perform provider work or import personal records', () => fixture(async (f) => {
  const timers = clock(); let calls = 0;
  const pending = syncChanges({ ...f.options, timers, fetchImpl() { calls++; } });
  const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); timers.fire(); await rejected; await new Promise(setImmediate);
  assert.equal(calls, 0); assert.equal(timers.cleared, 1); assert.deepEqual(snapshot(f.db), { entities: [], facts: [] }); assert.deepEqual(f.events, []);
}));
