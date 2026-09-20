import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact, getFacts } from '../server/memory/fact-store.js';
import { recordRelationship, getRelationships } from '../server/memory/relationship-store.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { DatabaseSync } from 'node:sqlite';
import { getDb, getDbPath, closeAllForTests } from '../server/db/connection.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('recordFact and recordRelationship store provenance fields correctly', () => {
  const dir = tempHome();
  try {
    const person = createEntity({ type: 'Person', name: 'Test Person' });

    const fact = recordFact({
      entityId: person.id,
      key: 'likes',
      value: 'coffee',
      source: 'user:chris',
      confidence: 0.7,
      inferred: true,
    });
    assert.equal(fact.source, 'user:chris');
    assert.equal(fact.confidence, 0.7);
    assert.equal(fact.inferred, true);
    assert.equal(fact.value, 'coffee');
    assert.deepEqual(getFacts(person.id).map((f) => f.id), [fact.id]);

    const other = createEntity({ type: 'Person', name: 'Other Person' });
    const rel = recordRelationship({
      fromEntityId: person.id,
      relation: 'knows',
      toEntityId: other.id,
      source: 'user:chris',
      confidence: 1.0,
    });
    assert.equal(rel.relation, 'knows');
    assert.equal(rel.source, 'user:chris');
    assert.equal(getRelationships(person.id).length, 1);
    assert.equal(getRelationships(other.id).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('projector turns calendar.event_changed into a fact on the matching person', () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const bus = new EventBus(db);
    initProjector(bus);

    const sarah = createEntity({ type: 'Person', name: 'Sarah' });

    bus.publish({
      type: 'calendar.event_changed',
      source: 'mock-calendar',
      subject: { type: 'calendar_event', id: 'cal_test' },
      data: {
        before: { startAt: '2026-09-17T14:00:00.000Z' },
        after: { startAt: '2026-09-18T14:00:00.000Z', attendees: [{ name: 'Sarah' }] },
        eventId: 'cal_test',
      },
    });

    const facts = getFacts(sarah.id);
    const changeFact = facts.find((f) => f.key === 'last_meeting_change');
    assert.ok(changeFact, 'expected a last_meeting_change fact to be recorded');
    assert.equal(changeFact.inferred, true);
    assert.equal(changeFact.source, 'system:projector');
    assert.equal(changeFact.confidence, 0.9);
    assert.equal(changeFact.value.newStartAt, '2026-09-18T14:00:00.000Z');
  } finally {
    cleanup(dir);
  }
});

test('classification migration: entities/relationships/calendar_events/emails/tasks created before the classification column existed get it added, defaulted, and their pre-existing rows preserved on upgrade', () => {
  const dir = tempHome();
  try {
    const dbPath = getDbPath();

    // Simulate a pre-existing installation: hand-build these five tables in
    // their pre-issue-#2 shape (no `classification` column at all -- this
    // is exactly what schema.sql defined for them before this migration)
    // and seed one row into each, the way a real installation would have
    // real data sitting in it already.
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT,
        attributes TEXT NOT NULL DEFAULT '{}',
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE relationships (
        id TEXT PRIMARY KEY,
        from_entity_id TEXT NOT NULL REFERENCES entities(id),
        relation TEXT NOT NULL,
        to_entity_id TEXT,
        attributes TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        inferred INTEGER NOT NULL DEFAULT 0,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        location TEXT,
        attendees TEXT NOT NULL DEFAULT '[]',
        category TEXT NOT NULL DEFAULT 'personal',
        status TEXT NOT NULL DEFAULT 'confirmed',
        source TEXT NOT NULL DEFAULT 'mock-calendar',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL DEFAULT '[]',
        subject TEXT,
        body TEXT,
        folder TEXT DEFAULT 'inbox',
        is_read INTEGER DEFAULT 0,
        received_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        due_at TEXT,
        related_entity_id TEXT REFERENCES entities(id),
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.prepare(
      `INSERT INTO entities (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('ent_1', 'Person', 'Legacy Person', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacyDb.prepare(
      `INSERT INTO relationships (id, from_entity_id, relation, source, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('rel_1', 'ent_1', 'knows', 'user:chris', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacyDb.prepare(
      `INSERT INTO calendar_events (id, title, start_at, end_at, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('cal_1', 'Legacy Meeting', '2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z', 'business', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacyDb.prepare(
      `INSERT INTO emails (id, from_addr, created_at) VALUES (?, ?, ?)`
    ).run('email_1', 'someone@example.com', '2026-01-01T00:00:00.000Z');
    legacyDb.prepare(
      `INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run('task_1', 'Legacy Task', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacyDb.close();

    // Drive the app's normal startup path against this pre-migration
    // database: getDb() runs the additive ensureColumn() migrations, then
    // schema.sql's idempotent CREATE TABLE/INDEX statements.
    closeAllForTests();
    const db = getDb();

    for (const table of ['entities', 'relationships', 'calendar_events', 'emails', 'tasks']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      const classificationCol = columns.find((c) => c.name === 'classification');
      assert.ok(classificationCol, `${table} should have gained a classification column`);
      assert.equal(classificationCol.notnull, 1, `${table}.classification should be NOT NULL`);
    }

    // Pre-existing rows survive the migration and get the safe default,
    // without error or data loss.
    assert.equal(
      db.prepare('SELECT classification FROM entities WHERE id = ?').get('ent_1').classification,
      'personal'
    );
    assert.equal(
      db.prepare('SELECT classification FROM relationships WHERE id = ?').get('rel_1').classification,
      'personal'
    );
    assert.equal(
      db.prepare('SELECT classification FROM emails WHERE id = ?').get('email_1').classification,
      'personal'
    );
    assert.equal(
      db.prepare('SELECT classification FROM tasks WHERE id = ?').get('task_1').classification,
      'personal'
    );

    // calendar_events must get the new `classification` column WITHOUT
    // touching the pre-existing, unrelated `category` column (policy-engine
    // sub-category for calendar.reschedule autonomy decisions).
    const calRow = db.prepare('SELECT category, classification FROM calendar_events WHERE id = ?').get('cal_1');
    assert.equal(calRow.category, 'business', 'pre-existing category value must be untouched by the migration');
    assert.equal(calRow.classification, 'personal');

    // No rows were lost.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relationships').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  } finally {
    closeAllForTests();
    cleanup(dir);
  }
});
