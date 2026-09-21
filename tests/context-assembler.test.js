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
import { MockEmbeddingProvider } from '../server/agent/embeddings/mock-embedding-provider.js';
import { receiveEmail } from '../server/integrations/mock-email-provider.js';
import { createEvent as createCalendarEvent } from '../server/integrations/mock-calendar-provider.js';
import { createTask } from '../server/integrations/mock-tasks-provider.js';

// Test-only helper: sets a row's classification directly via SQL, since none
// of the store creation functions expose a `classification` argument (this
// issue is purely additive/read-side -- see server/agent/context-assembler.js).
function setClassification(db, table, id, classification) {
  db.prepare(`UPDATE ${table} SET classification = ? WHERE id = ?`).run(classification, id);
}

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

test('a person named in the objective ranks ahead of one who is not, and carries a "why included" reason', async () => {
  const dir = tempHome();
  try {
    setup();
    const sarah = createEntity({ type: 'Person', name: 'Sarah Chen' });
    const bob = createEntity({ type: 'Person', name: 'Bob Nguyen' });
    recordFact({ entityId: sarah.id, key: 'note', value: 'prefers mornings', source: 'user', confidence: 0.9 });
    recordFact({ entityId: bob.id, key: 'note', value: 'unrelated', source: 'user', confidence: 0.9 });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null });
    const context = await assembler.assemblePersonalContext('Set up my follow-up with Sarah.');

    const names = context.relevantPeople.map((p) => p.name);
    assert.ok(names.includes('Sarah Chen'));
    const sarahEntry = context.relevantPeople.find((p) => p.name === 'Sarah Chen');
    assert.equal(sarahEntry.matchedOn, 'objective mentions this name');
    assert.equal(names.indexOf('Sarah Chen') < names.indexOf('Bob Nguyen') || !names.includes('Bob Nguyen'), true);
  } finally {
    cleanup(dir);
  }
});

test('every included fact carries provenance (factId/source/confidence/inferred), and provenanceRefs references it', async () => {
  const dir = tempHome();
  try {
    setup();
    const sarah = createEntity({ type: 'Person', name: 'Sarah' });
    const fact = recordFact({ entityId: sarah.id, key: 'preference', value: 'morning meetings', source: 'user:message', confidence: 0.8, inferred: true });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null });
    const context = await assembler.assemblePersonalContext('Tell me about Sarah');

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

test('only OPEN commitments made by the owner are included, ranked by relevance to the objective', async () => {
  const dir = tempHome();
  try {
    const { ownerEntityId } = setup();
    const openCommitment = createEntity({ type: 'Commitment', name: 'Send the draft', attributes: { description: 'send Sarah the draft', status: 'open' } });
    const closedCommitment = createEntity({ type: 'Commitment', name: 'Old thing', attributes: { description: 'already done thing', status: 'done' } });
    recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: openCommitment.id, source: 'test', inferred: true, confidence: 0.8 });
    recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: closedCommitment.id, source: 'test', inferred: true, confidence: 0.8 });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null, ownerEntityId });
    const context = await assembler.assemblePersonalContext('Set up my follow-up with Sarah about the draft.');

    const descriptions = context.commitments.map((c) => c.description);
    assert.ok(descriptions.includes('send Sarah the draft'));
    assert.ok(!descriptions.includes('already done thing'), 'a done commitment must not be surfaced as an open one');
  } finally {
    cleanup(dir);
  }
});

test('with no ownerEntityId, commitments is an empty array rather than throwing', async () => {
  const dir = tempHome();
  try {
    setup();
    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null, ownerEntityId: null });
    const context = await assembler.assemblePersonalContext('anything');
    assert.deepEqual(context.commitments, []);
  } finally {
    cleanup(dir);
  }
});

test('recentEvents only include the documented context-worthy event types, each with a short bounded summary', async () => {
  const dir = tempHome();
  try {
    const { eventBus } = setup();
    eventBus.publish({ type: 'email.received', source: 'test', data: { from: 'sarah@example.com', subject: 'Draft' } });
    eventBus.publish({ type: 'agent.action.proposed', source: 'test', data: { tool: 'internal.noise' } });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus });
    const context = await assembler.assemblePersonalContext('anything');

    assert.ok(context.recentEvents.some((e) => e.type === 'email.received' && e.summary.includes('Draft')));
    assert.ok(!context.recentEvents.some((e) => e.type === 'agent.action.proposed'), 'internal agent bookkeeping events must not leak into model context');
  } finally {
    cleanup(dir);
  }
});

test('the assembled context stays within the configured character budget by dropping whole items, never truncating serialized JSON mid-string', async () => {
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
    const context = await assembler.assemblePersonalContext('anything');

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

test('with no embeddingProvider configured, facts carry no relevance breakdown (Phase 4 behavior, unchanged)', async () => {
  const dir = tempHome();
  try {
    setup();
    const sarah = createEntity({ type: 'Person', name: 'Sarah' });
    recordFact({ entityId: sarah.id, key: 'note', value: 'prefers mornings', source: 'user', confidence: 0.9 });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null });
    const context = await assembler.assemblePersonalContext('Sarah');
    const entry = context.relevantPeople.find((p) => p.name === 'Sarah');
    assert.equal(entry.facts[0].relevance, undefined);
  } finally {
    cleanup(dir);
  }
});

test('with an embeddingProvider configured, facts are ranked with a semantic component and carry a relevance breakdown', async () => {
  const dir = tempHome();
  try {
    setup();
    const sarah = createEntity({ type: 'Person', name: 'Sarah' });
    recordFact({ entityId: sarah.id, key: 'unrelated', value: 'the quarterly budget spreadsheet needs review', source: 'user', confidence: 0.95 });
    recordFact({ entityId: sarah.id, key: 'preference', value: 'prefers morning meetings over afternoon ones', source: 'user', confidence: 0.5 });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null, embeddingProvider: new MockEmbeddingProvider() });
    const context = await assembler.assemblePersonalContext('set up a morning meeting with Sarah');
    const entry = context.relevantPeople.find((p) => p.name === 'Sarah');

    assert.ok(entry.facts[0].relevance, 'facts should carry a relevance score breakdown when semantic ranking is active');
    assert.equal(entry.facts[0].key, 'preference', 'the semantically/lexically closer fact should rank first despite lower confidence');
  } finally {
    cleanup(dir);
  }
});

// --- classification (issue #3: additive-only, no filtering behavior) ------

test('a person entry carries classification sourced from entities.classification, not silently defaulted', async () => {
  const dir = tempHome();
  try {
    const { db } = setup();
    const sarah = createEntity({ type: 'Person', name: 'Sarah Chen' });
    setClassification(db, 'entities', sarah.id, 'sensitive');

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null });
    const context = await assembler.assemblePersonalContext('Tell me about Sarah');

    const entry = context.relevantPeople.find((p) => p.id === sarah.id);
    assert.ok(entry);
    assert.equal(entry.classification, 'sensitive');
  } finally {
    cleanup(dir);
  }
});

test('a person entry defaults to "personal" classification when the entity row carries the default', async () => {
  const dir = tempHome();
  try {
    setup();
    const bob = createEntity({ type: 'Person', name: 'Bob Nguyen' });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null });
    const context = await assembler.assemblePersonalContext('Tell me about Bob');

    const entry = context.relevantPeople.find((p) => p.id === bob.id);
    assert.ok(entry);
    assert.equal(entry.classification, 'personal');
  } finally {
    cleanup(dir);
  }
});

test('a commitment entry carries classification sourced from the relationships row, not silently defaulted', async () => {
  const dir = tempHome();
  try {
    const { db, ownerEntityId } = setup();
    const commitment = createEntity({ type: 'Commitment', name: 'Send the draft', attributes: { description: 'send Sarah the draft', status: 'open' } });
    const rel = recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: commitment.id, source: 'test', inferred: true, confidence: 0.8 });
    setClassification(db, 'relationships', rel.id, 'private');

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus: null, ownerEntityId });
    const context = await assembler.assemblePersonalContext('Set up my follow-up about the draft.');

    const entry = context.commitments.find((c) => c.id === commitment.id);
    assert.ok(entry);
    assert.equal(entry.classification, 'private');
  } finally {
    cleanup(dir);
  }
});

test('an event summarizing an email carries classification sourced from emails.classification via the event subject, not silently defaulted', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus } = setup();
    const email = receiveEmail({ from: 'sarah@example.com', subject: 'Draft', body: 'body' });
    setClassification(db, 'emails', email.id, 'sensitive');
    // No `data.after` embedded -- forces the fallback lookup-by-subject-id
    // path, proving classification isn't just echoed back from data already
    // in the event, but actually read from the stored row.
    eventBus.publish({ type: 'email.received', source: 'test', subject: { type: 'email', id: email.id }, data: { from: email.from_addr, subject: email.subject } });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus });
    const context = await assembler.assemblePersonalContext('anything');

    const entry = context.recentEvents.find((e) => e.type === 'email.received');
    assert.ok(entry);
    assert.equal(entry.classification, 'sensitive');
  } finally {
    cleanup(dir);
  }
});

test('an event summarizing a calendar item carries classification sourced from calendar_events.classification via the event subject, not silently defaulted', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus } = setup();
    const event = createCalendarEvent({ title: 'Sync with Sarah', startAt: new Date().toISOString(), endAt: new Date().toISOString() });
    setClassification(db, 'calendar_events', event.id, 'private');
    // No `data.after` embedded -- forces the fallback lookup-by-subject-id path.
    eventBus.publish({ type: 'calendar.event_approaching', source: 'test', subject: { type: 'calendar_event', id: event.id }, data: { minutesUntil: 10 } });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus });
    const context = await assembler.assemblePersonalContext('anything');

    const entry = context.recentEvents.find((e) => e.type === 'calendar.event_approaching');
    assert.ok(entry);
    assert.equal(entry.classification, 'private');
  } finally {
    cleanup(dir);
  }
});

test('an event summarizing a task carries classification sourced from tasks.classification via the event subject, not silently defaulted', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus } = setup();
    const task = createTask({ title: 'Review contract' });
    setClassification(db, 'tasks', task.id, 'sensitive');
    // No `data.after` embedded -- forces the fallback lookup-by-subject-id path.
    eventBus.publish({ type: 'task.overdue', source: 'test', subject: { type: 'task', id: task.id }, data: { taskId: task.id, title: task.title } });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus });
    const context = await assembler.assemblePersonalContext('anything');

    const entry = context.recentEvents.find((e) => e.type === 'task.overdue');
    assert.ok(entry);
    assert.equal(entry.classification, 'sensitive');
  } finally {
    cleanup(dir);
  }
});

test('an event carrying the full underlying row already (data.after) uses that row\'s classification directly, without a redundant lookup', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus } = setup();
    const task = createTask({ title: 'Ship the release' });
    setClassification(db, 'tasks', task.id, 'private');
    const freshTask = { ...task, classification: 'private' };
    eventBus.publish({ type: 'task.created', source: 'test', subject: { type: 'task', id: task.id }, data: { after: freshTask } });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus });
    const context = await assembler.assemblePersonalContext('anything');

    const entry = context.recentEvents.find((e) => e.type === 'task.created');
    assert.ok(entry);
    assert.equal(entry.classification, 'private');
  } finally {
    cleanup(dir);
  }
});

test('an event with no classified source row (e.g. commitment.made) defaults conservatively to "personal", never "public"', async () => {
  const dir = tempHome();
  try {
    const { eventBus } = setup();
    eventBus.publish({ type: 'commitment.made', source: 'test', subject: { type: 'entity', id: 'ent_whatever' }, data: { description: 'do the thing' } });

    const assembler = new ContextAssembler({ toolRegistry: null, eventBus });
    const context = await assembler.assemblePersonalContext('anything');

    const entry = context.recentEvents.find((e) => e.type === 'commitment.made');
    assert.ok(entry);
    assert.equal(entry.classification, 'personal');
  } finally {
    cleanup(dir);
  }
});

test('assemble() returns the toolRegistry/eventBus/correlationId/actor plumbing alongside personalContext, unchanged shape for providers', async () => {
  const dir = tempHome();
  try {
    setup();
    const fakeRegistry = { list: () => [] };
    const assembler = new ContextAssembler({ toolRegistry: fakeRegistry, eventBus: null });
    const planContext = await assembler.assemble({ correlationId: 'c1', actor: { type: 'user', id: 'u1' }, objective: 'hi' });
    assert.equal(planContext.toolRegistry, fakeRegistry);
    assert.equal(planContext.correlationId, 'c1');
    assert.deepEqual(planContext.actor, { type: 'user', id: 'u1' });
    assert.ok(planContext.personalContext);
    assert.equal(planContext.personalContext.objective, 'hi');
  } finally {
    cleanup(dir);
  }
});

test('ranked facts from non-person entities enter bounded context with relevance and provenance', async () => {
  const dir = tempHome();
  try {
    const { db } = setup();
    const relevantProject = createEntity({ type: 'Project', name: 'Orion' });
    const otherProject = createEntity({ type: 'Project', name: 'Routine work' });
    setClassification(db, 'entities', relevantProject.id, 'private');
    const relevant = recordFact({ entityId: relevantProject.id, key: 'deadline', value: 'Orion launch is Friday', source: 'owner', confidence: 0.8, classification: 'public' });
    recordFact({ entityId: otherProject.id, key: 'note', value: 'Unrelated filing', source: 'owner', confidence: 1 });

    const context = await new ContextAssembler({ maxRelevantFacts: 1 }).assemblePersonalContext('When is the Orion launch?');
    assert.equal(context.relevantFacts.length, 1);
    assert.equal(context.relevantFacts[0].factId, relevant.id);
    assert.equal(context.relevantFacts[0].entityId, relevantProject.id);
    assert.equal(context.relevantFacts[0].classification, 'private', 'derived context inherits the strongest source classification');
    assert.ok(context.relevantFacts[0].relevance.exactMatch > 0);
    assert.ok(context.provenanceRefs.some((ref) => ref.type === 'fact' && ref.id === relevant.id));
    assert.ok(context.provenanceRefs.some((ref) => ref.type === 'entity' && ref.id === relevantProject.id));
  } finally { cleanup(dir); }
});

test('commitments and events use hybrid relevance before their context limits', async () => {
  const dir = tempHome();
  try {
    const { ownerEntityId, eventBus } = setup();
    const relevant = createEntity({ type: 'Commitment', name: 'Send Orion launch brief', attributes: { status: 'open', description: 'Send Orion launch brief' } });
    const unrelated = createEntity({ type: 'Commitment', name: 'Buy groceries', attributes: { status: 'open', description: 'Buy groceries' } });
    recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: relevant.id, source: 'owner' });
    recordRelationship({ fromEntityId: ownerEntityId, relation: 'promised', toEntityId: unrelated.id, source: 'owner' });
    eventBus.publish({ type: 'email.received', source: 'test', data: { subject: 'Orion launch brief' } });
    eventBus.publish({ type: 'email.received', source: 'test', data: { subject: 'Grocery coupon' } });

    const context = await new ContextAssembler({ ownerEntityId, maxCommitments: 1, maxRecentEvents: 1 }).assemblePersonalContext('Orion launch brief');
    assert.deepEqual(context.commitments.map((item) => item.id), [relevant.id]);
    assert.match(context.recentEvents[0].summary, /Orion launch brief/);
    assert.ok(context.commitments[0].relevance.total > 0);
    assert.ok(context.recentEvents[0].relevance.total > 0);
  } finally { cleanup(dir); }
});
