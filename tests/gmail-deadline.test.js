import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { listEmails, getEmail, syncChanges } from '../server/integrations/gmail-provider.js';

const PRIVATE = 'fixture-private-mail-query-token-body';
const message = (id) => ({ id, labelIds: ['INBOX', 'UNREAD'], internalDate: '1000', payload: { mimeType: 'text/plain',
  headers: [{ name: 'From', value: 'recruiter@example.test' }, { name: 'Subject', value: `Fixture ${id}` }], body: { data: Buffer.from('Fixture source text').toString('base64url') } } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const ready = (pending, reached) => Promise.race([reached.promise, pending.then(() => { throw new Error('Read completed before expected fixture stage'); })]);
const safe = (code) => (error) => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/); return true; };
function clock() {
  let callback, cleared = 0;
  return { setTimeout(fn, delay) { assert.equal(delay, 30_000); callback = fn; return 7; }, clearTimeout(id) { assert.equal(id, 7); cleared++; },
    fire() { assert.ok(callback); callback(); }, get cleared() { return cleared; } };
}
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-gmail-deadline-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), instance = { id: 'fixture_account', vault_key: 'google__fixture_account', metadata: '{}' }, events = [];
    storeTokens(instance.vault_key, 'gmail', { access_token: 'fixture-gmail-access', refresh_token: 'fixture-gmail-refresh', expires_in: 3600 }, home);
    await operation({ home, db, instance, events, options: { dataDir: home, instance, db, correlationId: 'fixture-sync', eventBus: { publish: (event) => events.push(event) } } });
  } finally {
    closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const operations = [
  ['list', (options) => listEmails({ folder: 'inbox', query: 'from:recruiter@example.test role' }, options)],
  ['get', (options) => getEmail(`gmail_${options.instance.id}_first`, options)],
  ['sync', (options) => syncChanges(options)],
];
const isList = (url) => new URL(url).pathname.endsWith('/messages');
const upstreamId = (url) => decodeURIComponent(new URL(url).pathname.split('/').at(-1));
for (const [name, run] of operations) for (const stage of ['headers', 'body']) {
  test(`Gmail ${name} bounds initial ${stage} stall and discards late cache/events`, () => fixture(async (f) => {
    const timers = clock(), reached = deferred(), late = deferred(); let calls = 0, signal, parsed = 0, cancelled = 0;
    const response = { ok: true, body: { cancel() { cancelled++; } }, json() { parsed++; reached.resolve(); return stage === 'body' ? late.promise : Promise.resolve(name === 'get' ? message('first') : { messages: [{ id: 'first' }] }); } };
    const pending = run({ ...f.options, timers, fetchImpl: async (_url, init) => {
      calls++; signal = init.signal; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-gmail-access');
      if (stage === 'headers') { reached.resolve(); return late.promise; } return response;
    } });
    const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
    late.resolve(stage === 'headers' ? response : name === 'get' ? message('first') : { messages: [{ id: 'first' }] }); await new Promise(setImmediate);
    assert.equal(calls, 1); if (stage === 'headers') assert.equal(parsed, 0);
    assert.equal(signal.aborted, true); assert.ok(cancelled >= 1); assert.equal(timers.cleared, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0); assert.deepEqual(f.events, []);
  }));
}

for (const [name, run] of operations.filter(([name]) => name !== 'get')) for (const stage of ['headers', 'body']) {
  test(`Gmail ${name} mid-message ${stage} timeout retains earlier evidence but never reads/persists later messages`, () => fixture(async (f) => {
    const timers = clock(), reached = deferred(), late = deferred(), calls = []; let signal;
    const pending = run({ ...f.options, timers, fetchImpl: async (url, init) => {
      calls.push(url);
      if (isList(url)) return { ok: true, json: async () => ({ messages: ['first', 'second', 'third'].map((id) => ({ id })) }) };
      if (upstreamId(url) === 'first') return { ok: true, json: async () => message('first') };
      assert.equal(upstreamId(url), 'second'); signal = init.signal;
      if (stage === 'headers') { reached.resolve(); return late.promise; }
      return { ok: true, json() { reached.resolve(); return late.promise; } };
    } });
    const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached);
    const before = f.db.prepare('SELECT * FROM emails').all(); assert.equal(before.length, 1);
    timers.fire(); await rejected;
    late.resolve(stage === 'headers' ? { ok: true, json: async () => message('second') } : message('second')); await new Promise(setImmediate);
    assert.equal(calls.length, 3); assert.equal(signal.aborted, true); assert.equal(timers.cleared, 1);
    assert.deepEqual(f.db.prepare('SELECT * FROM emails').all(), before);
    assert.equal(f.events.length, name === 'sync' ? 1 : 0);
    if (name === 'sync') { assert.equal(f.events[0].subject.id, before[0].id); assert.equal(f.events[0].metadata.provenance, 'sync:gmail'); }
  }));
}

test('Gmail successful reads preserve query/folder enforcement, exact account IDs and sync provenance', () => fixture(async (f) => {
  const queries = [];
  const fetchImpl = async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-gmail-access'); assert.equal(init.method || 'GET', 'GET');
    if (isList(url)) { const query = new URL(url).searchParams.get('q'); queries.push(query); return { ok: true, json: async () => ({ messages: [{ id: 'first' }, { id: query.includes('newer_than') ? 'new' : 'outside' }] }) }; }
    const id = upstreamId(url); return { ok: true, json: async () => id === 'outside' ? { ...message(id), labelIds: ['SENT'] } : message(id) };
  };
  const rows = await operations[0][1]({ ...f.options, fetchImpl });
  assert.deepEqual(rows.map((row) => row.id), ['gmail_fixture_account_first']); assert.equal(rows[0].body, 'Fixture source text');
  assert.equal((await operations[1][1]({ ...f.options, fetchImpl })).subject, 'Fixture first');
  assert.equal(queries[0], 'in:inbox from:recruiter@example.test role');
  await syncChanges({ ...f.options, fetchImpl });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].metadata.provenance, 'sync:gmail'); assert.equal(f.events[0].metadata.correlationId, 'fixture-sync');
  assert.equal(queries[1], 'in:inbox newer_than:1d');
}));

test('Gmail get-404 returns null without reading private error body', () => fixture(async (f) => {
  let cancelled = 0;
  assert.equal(await operations[1][1]({ ...f.options, fetchImpl: async () => ({ ok: false, status: 404, body: { cancel() { cancelled++; } }, json() { throw new Error(PRIVATE); } }) }), null);
  assert.ok(cancelled >= 1); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
}));

test('Gmail sync skips removed 404 messages and records remaining observed mail', () => fixture(async (f) => {
  const result = await syncChanges({ ...f.options, fetchImpl: async (url) => {
    if (isList(url)) return { ok: true, json: async () => ({ messages: [{ id: 'removed' }, { id: 'first' }] }) };
    if (upstreamId(url) === 'removed') return { ok: false, status: 404, json() { throw new Error(PRIVATE); } };
    return { ok: true, json: async () => message('first') };
  } });
  assert.deepEqual(result, { synced: 1 }); assert.equal(f.events.length, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 1);
}));

test('Gmail sync does not announce or cache mail moved out of inbox between listing and reading', () => fixture(async (f) => {
  const result = await syncChanges({ ...f.options, fetchImpl: async (url) => ({ ok: true, json: async () => isList(url) ? { messages: [{ id: 'first' }] } : { ...message('first'), labelIds: ['SENT'] } }) });
  assert.deepEqual(result, { synced: 0 }); assert.deepEqual(f.events, []); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
}));

test('Gmail parser failure after a skipped 404 does not inherit stale provider status', () => fixture(async (f) => {
  await assert.rejects(syncChanges({ ...f.options, fetchImpl: async (url) => {
    if (isList(url)) return { ok: true, json: async () => ({ messages: [{ id: 'removed' }, { id: 'first' }] }) };
    if (upstreamId(url) === 'removed') return { ok: false, status: 404 };
    return { ok: true, json: async () => { throw new Error(PRIVATE); } };
  } }), (error) => safe('GOOGLE_READ_UNAVAILABLE')(error) && error.status === undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0); assert.deepEqual(f.events, []);
}));

for (const [status, code] of [[401, 'AUTHORIZATION'], [403, 'AUTHORIZATION'], [429, 'RATE_LIMIT'], [503, 'UNAVAILABLE']]) {
  test(`Gmail message HTTP ${status} stops incomplete reads/sync rather than claiming success`, () => fixture(async (f) => {
    for (const [, run] of operations) {
      let calls = 0;
      await assert.rejects(run({ ...f.options, fetchImpl: async (url) => {
        calls++; if (isList(url)) return { ok: true, json: async () => ({ messages: [{ id: 'first' }] }) };
        return { ok: false, status, json() { throw new Error(PRIVATE); } };
      } }), (error) => safe(`GOOGLE_READ_${code}`)(error) && error.status === status);
      assert.ok(calls <= 2);
    }
    assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0); assert.deepEqual(f.events, []);
  }));
}

test('Gmail invalid list references cannot invent requests or cache identities', () => fixture(async (f) => {
  for (const [, run] of operations.filter(([name]) => name !== 'get')) for (const json of [null, [], { messages: null }, { messages: PRIVATE }, { messages: [null] }, { messages: [{}] }, { messages: [{ id: '' }] }, { messages: [{ id: 37 }] }]) {
    let calls = 0;
    await assert.rejects(run({ ...f.options, fetchImpl: async () => { calls++; return { ok: true, json: async () => json }; } }), safe('GOOGLE_READ_UNAVAILABLE'));
    assert.equal(calls, 1);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0); assert.deepEqual(f.events, []);
}));

test('Gmail missing/mismatched message IDs fail without fabricated or cross-reference cache entries', () => fixture(async (f) => {
  for (const [, run] of operations) for (const id of [undefined, 'different', ' ', 37]) {
    await assert.rejects(run({ ...f.options, fetchImpl: async (url) => ({ ok: true, json: async () => isList(url) ? { messages: [{ id: 'first' }] } : { ...message('first'), id } }) }), safe('GOOGLE_READ_UNAVAILABLE'));
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0); assert.deepEqual(f.events, []);
}));

test('Gmail sync requests/caches at most fifty messages from one oversized provider page', () => fixture(async (f) => {
  let details = 0;
  const result = await syncChanges({ ...f.options, fetchImpl: async (url) => {
    if (isList(url)) { assert.equal(new URL(url).searchParams.get('maxResults'), '50'); return { ok: true, json: async () => ({ messages: Array.from({ length: 60 }, (_, index) => ({ id: `m${index}` })), nextPageToken: PRIVATE }) }; }
    details++; return { ok: true, json: async () => message(upstreamId(url)) };
  } });
  assert.deepEqual(result, { synced: 50 }); assert.equal(details, 50); assert.equal(f.events.length, 50); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 50);
}));

for (const kind of ['transport', 'parser', 'forged error']) {
  test(`Gmail ${kind} cannot reflect private upstream text or forge OAuth classification`, () => fixture(async (f) => {
    for (const [, run] of operations) await assert.rejects(run({ ...f.options, fetchImpl: async () => {
      const error = new Error(PRIVATE); if (kind === 'forged error') error.code = 'GOOGLE_OAUTH_TIMEOUT';
      if (kind !== 'parser') throw error; return { ok: true, json: async () => { throw error; } };
    } }), safe('GOOGLE_READ_UNAVAILABLE'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0); assert.deepEqual(f.events, []);
  }));
}

test('Gmail native isolated HTTP stalled body is aborted before cache changes', () => fixture(async (f) => {
  const timers = clock(), reached = deferred();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"messages":'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pending = listEmails({}, { ...f.options, timers, fetchImpl: async (_url, init) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/fixture`, init);
      return { ok: true, body: response.body, json() { const body = response.json(); reached.resolve(); return body; } };
    } });
    const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
    assert.equal(timers.cleared, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}));

test('Gmail timeout during OAuth refresh never writes late token or starts mail reads', () => fixture(async (f) => {
  writeEncryptedFile('google', { clientId: PRIVATE, clientSecret: PRIVATE }, f.home);
  storeTokens(f.instance.vault_key, 'gmail', { access_token: 'fixture-old', refresh_token: 'fixture-refresh', expires_in: -1 }, f.home);
  const file = path.join(f.home, 'credentials', `${f.instance.vault_key}.enc.json`), before = fs.readFileSync(file), timers = clock(), reached = deferred(), late = deferred();
  let calls = 0;
  const pending = listEmails({}, { ...f.options, timers, fetchImpl: async (url) => { calls++; assert.equal(url, 'https://oauth2.googleapis.com/token'); return { ok: true, json() { reached.resolve(); return late.promise; } }; } });
  const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); await ready(pending, reached); timers.fire(); await rejected;
  late.resolve({ access_token: 'fixture-late-access', expires_in: 3600 }); await new Promise(setImmediate);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(calls, 1); assert.equal(timers.cleared, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
}));

test('Gmail read runtime overrides cannot disable/expand deadlines or contact another account when unconfigured', () => fixture(async (f) => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 30_001]) {
    let calls = 0; await assert.rejects(listEmails({}, { ...f.options, timeoutMs, fetchImpl() { calls++; } }), safe('GOOGLE_READ_UNAVAILABLE')); assert.equal(calls, 0);
  }
  let calls = 0;
  await assert.rejects(listEmails({}, { ...f.options, instance: { ...f.instance, vault_key: 'missing-fixture' }, fetchImpl() { calls++; } }), safe('GOOGLE_READ_UNAVAILABLE')); assert.equal(calls, 0);
}));

test('Gmail deadline fired before startup performs no provider or cache work', () => fixture(async (f) => {
  const timers = clock(); let calls = 0;
  const pending = listEmails({}, { ...f.options, timers, fetchImpl() { calls++; } });
  const rejected = assert.rejects(pending, safe('GOOGLE_READ_TIMEOUT')); timers.fire(); await rejected; await new Promise(setImmediate);
  assert.equal(calls, 0); assert.equal(timers.cleared, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
}));
