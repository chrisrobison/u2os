import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact, deleteFact } from '../server/memory/fact-store.js';
import { recordRelationship } from '../server/memory/relationship-store.js';
import { selectMemoryCandidates } from '../server/memory/candidate-retrieval.js';
import { ContextAssembler } from '../server/agent/context-assembler.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-candidates-'));
  process.env.U2OS_HOME = dir;
  const db = getDb();
  return { dir, db, eventBus: new EventBus(db) };
}

function cleanup(dir) {
  closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
}

test('a current fact match discovers its person before the maxPeople cutoff', async () => {
  const { dir } = fixture();
  try {
    const relevant = createEntity({ type: 'Person', name: 'Older Contact' });
    const fact = recordFact({ entityId: relevant.id, key: 'project_note', value: 'The launch codename is Orion', source: 'owner' });
    for (let i = 0; i < 8; i++) createEntity({ type: 'Person', name: `Newer Contact ${i}` });

    const context = await new ContextAssembler({ maxPeople: 2 }).assemblePersonalContext('What is the Orion launch codename?');
    const person = context.relevantPeople.find((item) => item.id === relevant.id);
    assert.ok(person, 'a matching fact must promote its person before truncating the people list');
    assert.equal(person.matchedOn, 'objective matches a current fact');
    assert.ok(person.facts.some((item) => item.factId === fact.id));
  } finally { cleanup(dir); }
});

test('candidate selection is bounded and excludes inactive facts', () => {
  const { dir } = fixture();
  try {
    const person = createEntity({ type: 'Person', name: 'Taylor' });
    const deleted = recordFact({ entityId: person.id, key: 'archived_topic', value: 'Nebula archive', source: 'owner' });
    deleteFact(deleted.id);
    const current = recordFact({ entityId: person.id, key: 'current_topic', value: 'Nebula launch', source: 'owner' });
    recordFact({ entityId: person.id, key: 'secondary', value: 'Nebula schedule', source: 'owner' });

    const candidates = selectMemoryCandidates({ objective: 'Nebula', limits: { facts: 1, entities: 2 } });
    assert.equal(candidates.facts.length, 1);
    assert.notEqual(candidates.facts[0].id, deleted.id);
    assert.ok([current.id].includes(candidates.facts[0].id) || candidates.facts[0].key === 'secondary');
    assert.ok(candidates.entities.some((item) => item.id === person.id && item.viaFactIds.length === 1));
  } finally { cleanup(dir); }
});

test('candidate selection returns only open owner commitments and allowlisted events', () => {
  const { dir, eventBus } = fixture();
  try {
    const owner = createEntity({ type: 'Person', name: 'Owner' });
    const open = createEntity({ type: 'Commitment', name: 'Send launch brief', attributes: { status: 'open', description: 'Send the launch brief' } });
    const done = createEntity({ type: 'Commitment', name: 'Old launch brief', attributes: { status: 'done', description: 'Old launch brief' } });
    recordRelationship({ fromEntityId: owner.id, relation: 'promised', toEntityId: open.id, source: 'owner' });
    recordRelationship({ fromEntityId: owner.id, relation: 'promised', toEntityId: done.id, source: 'owner' });
    eventBus.publish({ type: 'email.received', source: 'test', data: { subject: 'Launch brief' } });
    eventBus.publish({ type: 'agent.action.proposed', source: 'test', data: { summary: 'Launch brief' } });

    const candidates = selectMemoryCandidates({ objective: 'launch brief', ownerEntityId: owner.id, eventTypes: ['email.received'], limits: { commitments: 5, events: 5 } });
    assert.deepEqual(candidates.commitments.map((item) => item.id), [open.id]);
    assert.deepEqual(candidates.events.map((item) => item.type), ['email.received']);
    assert.ok(candidates.commitments[0].match.matchedFields.length > 0);
    assert.ok(candidates.events[0].match.exactWordMatches > 0);
  } finally { cleanup(dir); }
});
