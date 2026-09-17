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
import { getDb } from '../server/db/connection.js';

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
