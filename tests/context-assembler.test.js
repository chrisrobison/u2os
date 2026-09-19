import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { runSeed } from '../server/seed/seed.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact } from '../server/memory/fact-store.js';
import { recordRelationship } from '../server/memory/relationship-store.js';
import { ContextAssembler } from '../server/agent/context-assembler.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-context-assembler-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function setup() {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  return { db, eventBus, ownerEntityId };
}

test('a person named in the objective ranks ahead of one who is not, and carries a "why included" reason', () => {
  const dir = tempHome();
  try {
    setup();
    const sarah = createEntity({ type: 'Person', name: 'Sarah Chen' });
    const bob = createEntity({ type: 'Person', name: 'Bob Nguyen' });
    recordFact({ entityId: sarah.id, key: 'note', value: 'prefers mornings', source: 'user', confidence: 0.9 });
    recordFact({ entityId: bob.id, key: 'note', value: 'unrelated', source: 'user', confidence: 0.9 });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null });
    const context = assembler.assemblePersonalContext('Set up my follow-up with Sarah.');

    const names = context.relevantPeople.map((p) => p.name);
    assert.ok(names.includes('Sarah Chen'));
    const sarahEntry = context.relevantPeople.find((p) => p.name === 'Sarah Chen');
    assert.equal(sarahEntry.matchedOn, 'objective mentions this name');
    assert.equal(names.indexOf('Sarah Chen') < names.indexOf('Bob Nguyen') || !names.includes('Bob Nguyen'), true);
  } finally {
    cleanup(dir);
  }
});

test('every included fact carries provenance (factId/source/confidence/inferred), and provenanceRefs references it', () => {
  const dir = tempHome();
  try {
    setup();
    const sarah = createEntity({ type: 'Person', name: 'Sarah' });
    const fact = recordFact({ entityId: sarah.id, key: 'preference', value: 'morning meetings', source: 'user:message', confidence: 0.8, inferred: true });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null });
    const context = assembler.assemblePersonalContext('Tell me about Sarah');

    const entry = context.relevantPeople.find((p) => p.name === 'Sarah');
    assert.ok(entry);
    const factEntry = entry.facts.find((f) => f.factId === fact.id);
    assert.ok(factEntry);
    assert.equal(factEntry.source, 'user:message');
    assert.equal(factEntry.inferred, true);
    assert.equal(factEntry.confidence, 0.8);
    assert.ok(context.provenanceRefs.some((r) => r.type === 'fact' && r.id === fact.id));
    assert.ok(context.provenanceRefs.some((r) => r.type === 'entity' && r.id === sarah.id));
  } finally {
    cleanup(dir);
  }
});

test('only OPEN commitments made by the owner are included, ranked by relevance to the objective', () => {
  const dir = tempHome();
  try {
    const { ownerEntityId } = setup();
    const openCommitment = createEntity({ type: 'Commitment', name: 'Send the draft', attributes: { description: 'send Sarah the draft', status: 'open' } });
    const closedCommitment = createEntity({ type: 'Commitment', name: 'Old thing', attributes: { description: 'already done thing', status: 'done' } });
    recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: openCommitment.id, source: 'test', inferred: true, confidence: 0.8 });
    recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: closedCommitment.id, source: 'test', inferred: true, confidence: 0.8 });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null, ownerEntityId });
    const context = assembler.assemblePersonalContext('Set up my follow-up with Sarah about the draft.');

    const descriptions = context.commitments.map((c) => c.description);
    assert.ok(descriptions.includes('send Sarah the draft'));
    assert.ok(!descriptions.includes('already done thing'), 'a done commitment must not be surfaced as an open one');
  } finally {
    cleanup(dir);
  }
});

test('with no ownerEntityId, commitments is an empty array rather than throwing', () => {
  const dir = tempHome();
  try {
    setup();
    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null, ownerEntityId: null });
    const context = assembler.assemblePersonalContext('anything');
    assert.deepEqual(context.commitments, []);
  } finally {
    cleanup(dir);
  }
});

test('recentEvents only include the documented context-worthy event types, each with a short bounded summary', () => {
  const dir = tempHome();
  try {
    const { eventBus } = setup();
    eventBus.publish({ type: 'email.received', source: 'test', data: { from: 'sarah@example.com', subject: 'Draft' } });
    eventBus.publish({ type: 'agent.action.proposed', source: 'test', data: { tool: 'internal.noise' } });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus });
    const context = assembler.assemblePersonalContext('anything');

    assert.ok(context.recentEvents.some((e) => e.type === 'email.received' && e.summary.includes('Draft')));
    assert.ok(!context.recentEvents.some((e) => e.type === 'agent.action.proposed'), 'internal agent bookkeeping events must not leak into model context');
  } finally {
    cleanup(dir);
  }
});

test('the assembled context stays within the configured character budget by dropping whole items, never truncating serialized JSON mid-string', () => {
  const dir = tempHome();
  try {
    setup();
    for (let i = 0; i < 20; i++) {
      const person = createEntity({ type: 'Person', name: `Person ${i}` });
      for (let j = 0; j < 8; j++) {
        recordFact({ entityId: person.id, key: `fact_${j}`, value: `This is a moderately long fact value number ${j} for person ${i}, used to inflate size.`, source: 'test', confidence: 0.5 + j * 0.01 });
      }
    }

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null, maxChars: 2000, maxPeople: 20, maxFactsPerPerson: 8 });
    const context = assembler.assemblePersonalContext('anything');

    assert.ok(JSON.stringify(context).length <= 2000 + 200, 'budget should be respected within a small slack for the truncated/metadata fields themselves');
    assert.equal(context.truncated, true);
    // Every remaining item must still be a whole, valid, parseable object --
    // nothing was string-truncated mid-value.
    for (const person of context.relevantPeople) {
      assert.equal(typeof person.name, 'string');
      for (const fact of person.facts) assert.equal(typeof fact.value, 'string');
    }
  } finally {
    cleanup(dir);
  }
});

test('assemble() returns the toolRegistry/eventBus/correlationId/actor plumbing alongside personalContext, unchanged shape for providers', () => {
  const dir = tempHome();
  try {
    setup();
    const fakeRegistry = { list: () => [] };
    const assembler = new ContextAssembler({ toolRegistry: fakeRegistry, eventBus: null });
    const planContext = assembler.assemble({ correlationId: 'c1', actor: { type: 'user', id: 'u1' }, objective: 'hi' });
    assert.equal(planContext.toolRegistry, fakeRegistry);
    assert.equal(planContext.correlationId, 'c1');
    assert.deepEqual(planContext.actor, { type: 'user', id: 'u1' });
    assert.ok(planContext.personalContext);
    assert.equal(planContext.personalContext.objective, 'hi');
  } finally {
    cleanup(dir);
  }
});
