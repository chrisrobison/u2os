import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { listEvents, getEvent, syncChanges } from '../server/integrations/google-calendar-provider.js';
import { safeSyncError } from '../server/integrations/provider-registry.js';
import { googleReadFailureMetadata } from '../server/integrations/google-read-deadline.js';

const PRIVATE = 'fixture-private-calendar-body-token';
const event = { id: 'source_event', summary: 'Fixture meeting', start: { dateTime: '2026-09-26T10:00:00Z' }, end: { dateTime: '2026-09-26T11:00:00Z' }, attendees: [{ email: 'person@example.test' }] };
const safe = (error) => { assert.equal(error.code, 'GOOGLE_READ_UNAVAILABLE'); assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/);
  assert.equal(googleReadFailureMetadata(error).kind, 'unavailable'); assert.match(safeSyncError(error), /Sync failed; check account/); assert.doesNotMatch(safeSyncError(error), /fixture-private/); return true; };
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-calendar-read-validation-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), events = [];
    const add = (label, legacy = false) => {
      const created = createConnectionInstance(db, { connectorId: 'google', label, status: 'connected', dataDir: home });
      if (legacy) db.prepare('UPDATE connection_instances SET metadata=? WHERE id=?').run(JSON.stringify({ migratedFrom: 'legacy-single-file' }), created.id);
      const instance = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(created.id);
      storeTokens(instance.vault_key, 'calendar', { access_token: `fixture-access-${instance.id}`, refresh_token: 'fixture-refresh', expires_in: 3600 }, home);
      return instance;
    };
    const instance = add('Selected fixture account');
    const options = { dataDir: home, instance, db, correlationId: 'fixture-read', eventBus: { publish: (value) => events.push(value) } };
    const reply = (json, account = instance) => async (url, init) => {
      assert.equal(new URL(url).origin, 'https://www.googleapis.com'); assert.equal(init.method || 'GET', 'GET');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer fixture-access-${account.id}`);
      return { ok: true, status: 200, json: async () => json };
    };
    await listEvents({}, { ...options, fetchImpl: reply({ items: [event] }) });
    const before = db.prepare('SELECT * FROM calendar_events ORDER BY id').all();
    await operation({ db, instance, events, options, reply, before, add });
  } finally {
    closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const operations = [
  ['list', (options) => listEvents({}, options)], ['sync', (options) => syncChanges(options)],
];
for (const [name, run] of operations) {
  test(`Calendar ${name} cannot append an earlier valid new event when a later identity is missing`, () => fixture(async (f) => {
    await assert.rejects(run({ ...f.options, fetchImpl: f.reply({ items: [{ ...event, id: 'new_event' }, { ...event, id: undefined }] }) }), safe);
    assert.deepEqual(f.db.prepare('SELECT * FROM calendar_events ORDER BY id').all(), f.before); assert.deepEqual(f.events, []);
  }));
  for (const [shape, page] of [['null', null], ['array', []], ['primitive', PRIVATE], ['object items', { items: { private: PRIVATE } }]]) {
    test(`Calendar ${name} rejects ${shape} page without cache/event changes or private error text`, () => fixture(async (f) => {
      await assert.rejects(run({ ...f.options, fetchImpl: f.reply(page) }), safe);
      assert.deepEqual(f.db.prepare('SELECT * FROM calendar_events ORDER BY id').all(), f.before); assert.deepEqual(f.events, []);
    }));
  }
  for (const [shape, invalid] of [
    ['missing ID', { ...event, id: undefined }], ['empty ID', { ...event, id: '' }], ['blank ID', { ...event, id: ' ' }],
    ['numeric ID', { ...event, id: 42 }], ['object ID', { ...event, id: { private: PRIVATE } }], ['array event', []],
    ['missing start', { ...event, start: {} }], ['unusable start', { ...event, start: { dateTime: PRIVATE } }],
    ['missing end', { ...event, end: {} }], ['unusable end', { ...event, end: { dateTime: PRIVATE } }],
    ['nonexistent timed day', { ...event, start: { dateTime: '2026-02-30T10:00:00Z' } }],
    ['nonexistent all-day date', { ...event, start: { date: '2026-02-30' }, end: { date: '2026-03-04' } }],
    ['end before start', { ...event, end: { dateTime: '2026-09-26T09:00:00Z' } }],
    ['object title', { ...event, summary: { private: PRIVATE } }], ['object location', { ...event, location: { private: PRIVATE } }],
    ['object status', { ...event, status: { private: PRIVATE } }], ['unknown status', { ...event, status: PRIVATE }], ['object attendees', { ...event, attendees: {} }],
    ['primitive attendee', { ...event, attendees: [PRIVATE] }], ['object attendee name', { ...event, attendees: [{ displayName: { private: PRIVATE } }] }],
  ]) {
    test(`Calendar ${name} validates later ${shape} before writing earlier page evidence`, () => fixture(async (f) => {
      const page = { items: [{ ...event, summary: 'Unaccepted changed fixture title' }, invalid] };
      await assert.rejects(run({ ...f.options, fetchImpl: f.reply(page) }), safe);
      assert.deepEqual(f.db.prepare('SELECT * FROM calendar_events ORDER BY id').all(), f.before); assert.deepEqual(f.events, []);
    }));
  }
}

for (const [shape, invalid] of [['different ID', { ...event, id: 'other_event' }], ['missing ID', { ...event, id: undefined }], ['object ID', { ...event, id: {} }], ['null', null]]) {
  test(`Calendar get rejects ${shape} rather than substituting requested identity or importing another event`, () => fixture(async (f) => {
    await assert.rejects(getEvent(`gcal_${f.instance.id}_source_event`, { ...f.options, fetchImpl: f.reply(invalid) }), safe);
    assert.deepEqual(f.db.prepare('SELECT * FROM calendar_events ORDER BY id').all(), f.before); assert.deepEqual(f.events, []);
  }));
}

test('Calendar timed/all-day/cancelled reads retain source values, independent account IDs and grandfathered identity', () => fixture(async (f) => {
  const instances = [f.instance, f.add('Other fixture account'), f.add('Legacy fixture account', true)];
  const source = [event, { ...event, id: 'all_day', summary: '', start: { date: '2026-09-27' }, end: { date: '2026-09-28' }, attendees: [] },
    { ...event, id: 'cancelled', status: 'cancelled', location: 'Fixture location', attendees: [{ displayName: 'Fixture person', email: 'person@example.test' }] },
    { ...event, id: 'zero_duration', end: event.start },
    { ...event, id: 'different_zones', start: { dateTime: '2026-09-26T14:00:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-09-26T10:00:00', timeZone: 'America/New_York' } }];
  for (const [index, instance] of instances.entries()) {
    const options = { ...f.options, instance, fetchImpl: f.reply({ items: source }, instance) };
    const rows = await listEvents({}, options), prefix = index === 2 ? 'gcal_' : `gcal_${instance.id}_`;
    assert.deepEqual(rows.map((row) => row.id), source.map((item) => `${prefix}${item.id}`));
    assert.equal(rows[0].start_at, event.start.dateTime); assert.equal(rows[1].start_at, '2026-09-27'); assert.equal(rows[1].end_at, '2026-09-28');
    assert.equal(rows[1].title, '(untitled)'); assert.equal(rows[2].status, 'cancelled'); assert.deepEqual(rows[2].attendees, ['Fixture person']);
    assert.equal(rows[3].start_at, rows[3].end_at); assert.equal(rows[4].start_at, source[4].start.dateTime); assert.equal(rows[4].end_at, source[4].end.dateTime);
    const fetched = await getEvent(`${prefix}source_event`, { ...options, fetchImpl: f.reply(event, instance) }); assert.equal(fetched.id, `${prefix}source_event`);
    await syncChanges({ ...options, fetchImpl: f.reply({ items: [{ ...event, start: { dateTime: '2026-09-26T12:00:00Z' }, end: { dateTime: '2026-09-26T13:00:00Z' } }] }, instance) });
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM calendar_events').get().n, 15);
  assert.equal(f.events.length, 3); assert.ok(f.events.every((value) => value.type === 'calendar.event_changed' && value.metadata.provenance === 'sync:google-calendar'));
}));

test('Calendar empty valid pages and get-404 retain prior evidence without inventing deletion or freshness coverage', () => fixture(async (f) => {
  assert.deepEqual(await listEvents({}, { ...f.options, fetchImpl: f.reply({}) }), []);
  assert.deepEqual(await syncChanges({ ...f.options, fetchImpl: f.reply({ items: [] }) }), { synced: 0 });
  let cancelled = 0;
  assert.equal(await getEvent(`gcal_${f.instance.id}_source_event`, { ...f.options, fetchImpl: async () => ({ ok: false, status: 404,
    body: { cancel() { cancelled++; } }, json() { throw new Error(PRIVATE); } }) }), null);
  assert.ok(cancelled >= 1); assert.deepEqual(f.db.prepare('SELECT * FROM calendar_events ORDER BY id').all(), f.before); assert.deepEqual(f.events, []);
}));

test('Calendar minimal cancelled tombstone fails honestly without inventing dates or mutating an existing confirmed event', () => fixture(async (f) => {
  await assert.rejects(syncChanges({ ...f.options, fetchImpl: f.reply({ items: [{ id: event.id, status: 'cancelled' }] }) }), safe);
  assert.deepEqual(f.db.prepare('SELECT * FROM calendar_events ORDER BY id').all(), f.before); assert.deepEqual(f.events, []);
}));
