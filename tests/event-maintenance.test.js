import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { createEntity } from '../server/memory/entity-store.js';
import { getFacts, recordFact } from '../server/memory/fact-store.js';
import { checkEventLogIntegrity, pruneEvents, replayDerivedProjections } from '../server/events/maintenance.js';

test('event maintenance checks integrity and requires explicit apply before pruning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-maintenance-')); process.env.U2OS_HOME = dir;
  try {
    const db = getDb(); const bus = new EventBus(db);
    bus.publish({ type: 'test.old', timestamp: '2000-01-01T00:00:00.000Z' });
    assert.equal(checkEventLogIntegrity(db).ok, true);
    assert.equal(pruneEvents({ retentionDays: 365, db }).eligible, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 1);
    assert.equal(pruneEvents({ retentionDays: 365, apply: true, db }).removed, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='system.event_retention_applied'").get().n, 1);
  } finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('projection replay is dry-run by default and applies registered events in stable order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-replay-')); process.env.U2OS_HOME = dir;
  try {
    const db = getDb(); const bus = new EventBus(db);
    const person = createEntity({ type: 'Person', name: 'Dana' });
    recordFact({ entityId: person.id, key: 'owner_note', value: 'preserve me', source: 'owner' });
    bus.publish({ type: 'calendar.event_changed', timestamp: '2026-09-18T12:00:00.000Z', subject: { type: 'calendar_event', id: 'later' }, data: { after: { start_at: '2026-09-20T12:00:00.000Z', attendees: ['Dana'] } } });
    bus.publish({ type: 'email.sent', timestamp: '2026-09-17T12:00:00.000Z', data: { to: 'outside@example.com' } });
    bus.publish({ type: 'calendar.event_changed', timestamp: '2026-09-17T12:00:00.000Z', subject: { type: 'calendar_event', id: 'earlier' }, data: { after: { start_at: '2026-09-19T12:00:00.000Z', attendees: ['Dana'] } } });
    let liveDispatches = 0;
    bus.subscribe('*', () => { liveDispatches += 1; });

    const before = db.prepare('SELECT count(*) AS count FROM facts').get().count;
    assert.deepEqual(replayDerivedProjections({ db }), { applied: false, eventCount: 2, projectionCount: 2, eventTypes: { 'calendar.event_changed': 2 } });
    assert.equal(db.prepare('SELECT count(*) AS count FROM facts').get().count, before);
    assert.equal(db.prepare("SELECT count(*) AS count FROM events WHERE type = 'system.projections_replayed'").get().count, 0);
    assert.equal(liveDispatches, 0);

    const applied = replayDerivedProjections({ apply: true, db });
    assert.equal(applied.applied, true);
    assert.equal(applied.removed, 0);
    const derived = getFacts(person.id, { includeInactive: true }).filter((fact) => fact.source === 'system:projector');
    assert.deepEqual(normalize(derived), [
      { value: { eventId: 'earlier', newStartAt: '2026-09-19T12:00:00.000Z' }, status: 'disputed', observedAt: '2026-09-17T12:00:00.000Z', sourceEventId: eventId(db, 'earlier') },
      { value: { eventId: 'later', newStartAt: '2026-09-20T12:00:00.000Z' }, status: 'disputed', observedAt: '2026-09-18T12:00:00.000Z', sourceEventId: eventId(db, 'later') },
    ]);
    assert.deepEqual(db.prepare("SELECT json_extract(provenance, '$.sourceEventId') AS source_event_id FROM facts WHERE source = 'system:projector' ORDER BY rowid").all().map((row) => row.source_event_id), [eventId(db, 'later'), eventId(db, 'earlier')]);
    assert.equal(getFacts(person.id, { includeInactive: true }).some((fact) => fact.key === 'owner_note'), true);
    assert.equal(db.prepare("SELECT count(*) AS count FROM events WHERE type = 'system.projections_replayed'").get().count, 1);

    const snapshot = normalize(derived);
    const repeated = replayDerivedProjections({ apply: true, db });
    assert.equal(repeated.removed, 2);
    const rebuilt = getFacts(person.id, { includeInactive: true }).filter((fact) => fact.source === 'system:projector');
    assert.deepEqual(normalize(rebuilt), snapshot);
    assert.equal(db.prepare("SELECT count(*) AS count FROM events WHERE type = 'email.sent'").get().count, 1);
    assert.equal(liveDispatches, 0);
  } finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
});

function normalize(facts) {
  return facts.map((fact) => ({ value: fact.value, status: fact.status, observedAt: fact.observed_at, sourceEventId: fact.provenance.sourceEventId }))
    .sort((a, b) => a.value.eventId.localeCompare(b.value.eventId));
}

function eventId(db, subjectId) { return db.prepare('SELECT id FROM events WHERE subject_id = ?').get(subjectId).id; }
