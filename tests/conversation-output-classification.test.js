import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { Agent } from '../server/agent/agent.js';
import { Planner } from '../server/agent/planner.js';
import { ModelRouter } from '../server/agent/model-router.js';
import { createRun, recordOutputClassification, getOutputClassification } from '../server/agent/run-store.js';
import { createConversation, appendTurn, getPriorTurnsForModel } from '../server/agent/conversation-store.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { EventBus } from '../server/events/event-bus.js';
import { DataProcessingPolicy } from '../server/policy/data-processing-policy.js';

async function home(operation) {
  const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-output-classification-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = taskHome;
  try { await operation(); } finally {
    closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(taskHome, { recursive: true, force: true });
  }
}
const policy = () => new DataProcessingPolicy({ policies: Object.fromEntries(['public', 'personal', 'private', 'sensitive'].map(c => [c, { local_models: 'allow', remote_models: c === 'sensitive' ? 'never' : 'allow' }])) });
const plan = (response = 'Fixture response') => ({ reasoning_summary: 'Fixture only', actions: [], response });
function agent(provider, dataPolicy, router) {
  const registry = new ToolRegistry();
  const instance = new Agent({ modelProvider: provider, modelRouter: router, policyEngine: new PolicyEngine(), toolRegistry: registry, eventBus: new EventBus(getDb()), dataProcessingPolicy: dataPolicy });
  instance.contextAssembler.assemble = async () => ({ toolRegistry: registry });
  return instance;
}

for (const summary of [false, true]) for (const fallback of [false, true]) {
  test(`sensitive derived ${summary ? 'summary' : 'history'} cannot reach remote ${fallback ? 'fallback' : 'planner'} after restart`, () => home(async () => {
    const dataPolicy = policy(), conversationId = createConversation('owner'), marker = 'fixture-sensitive-derived-marker';
    const local = agent({ id: 'local', destination: 'local_model', plan: async context => {
      assert.equal(context.personalContext.relevantFacts[0].value, marker); return plan(marker);
    } }, dataPolicy);
    local.contextAssembler.assemble = async () => ({ personalContext: { relevantFacts: [{ factId: 'fixture-sensitive', classification: 'sensitive', value: marker }] } });
    const first = await local.handleMessage({ text: 'Read fixture fact', actorId: 'owner', conversationId });
    assert.equal(getOutputClassification(first.runId), 'sensitive');
    assert.equal(getDb().prepare("SELECT classification FROM conversation_messages WHERE run_id=? AND role='assistant'").get(first.runId).classification, 'sensitive');
    if (summary) for (let i = 0; i < 6; i++) appendTurn({ conversationId, ownerId: 'owner', role: 'user', content: `Filler ${i}`, runId: `filler_${i}` });
    closeAllForTests(); getDb();
    const received = [], remoteProvider = { id: 'remote', destination: 'configured_remote_model', plan: async context => {
      received.push(context); assert.doesNotMatch(JSON.stringify(context), /fixture-sensitive-derived-marker/); return plan();
    } };
    const router = fallback ? new ModelRouter({ providers: { local: { type: 'mock', tag: 'local' }, remote: { type: 'mock', tag: 'remote' } }, roles: { planner: 'local' }, fallback: 'remote' }, {
      createProvider: config => config.tag === 'remote' ? remoteProvider : { id: 'local', destination: 'local_model', plan: async () => { throw new Error('fixture outage'); } },
    }) : undefined;
    const remote = agent(fallback ? undefined : remoteProvider, dataPolicy, router);
    await remote.handleMessage({ text: 'Follow up', actorId: 'owner', conversationId });
    assert.equal(received.length, 1);
    assert.ok(JSON.stringify(getDb().prepare('SELECT content FROM conversation_messages').all()).includes(marker), 'restriction must not delete owner transcript');
  }));
}

test('ordinary known-private model output remains reusable under owner policy after restart', () => home(async () => {
  const dataPolicy = policy(), conversationId = createConversation('owner');
  const local = agent({ id: 'local', destination: 'local_model', plan: async () => plan('fixture-safe-private-response') }, dataPolicy);
  const first = await local.handleMessage({ text: 'Ordinary fixture question', actorId: 'owner', conversationId });
  assert.equal(getOutputClassification(first.runId), 'private'); closeAllForTests(); getDb();
  let seen = false;
  const remote = agent({ id: 'remote', destination: 'configured_remote_model', plan: async context => { seen = JSON.stringify(context.conversationHistory).includes('fixture-safe-private-response'); return plan(); } }, dataPolicy);
  await remote.handleMessage({ text: 'Continue', actorId: 'owner', conversationId }); assert.equal(seen, true);
}));

test('exact-call classification is immutable across overlapping calls and provider mutation', async () => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const reused = plan(); reused.outputClassification = 'private';
  const planner = new Planner({ dataProcessingPolicy: policy(), modelProvider: { id: 'local', destination: 'local_model', plan: async context => {
    context.personalContext.relevantFacts[0].classification = 'public'; entered(); await gate; return reused;
  } } });
  const pending = planner.plan({ personalContext: { relevantFacts: [{ classification: 'sensitive', value: 'fixture' }] } }, 'First'); await started;
  planner.modelProvider = { id: 'remote', destination: 'configured_remote_model', plan: async () => reused };
  const second = await planner.plan({}, 'Second'); assert.equal(planner.getPlanContext(second).outputClassification, 'private');
  release(); const first = await pending;
  assert.equal(planner.getPlanContext(first).outputClassification, 'sensitive'); assert.equal(planner.getPlanContext(first).providerId, 'local');
  assert.notEqual(first, second); assert.equal(first.outputClassification, 'private', 'model JSON cannot override runtime metadata');
});

test('run output floor persists monotonically and protects assistant retrieval even when turn label is weaker', () => home(async () => {
  const conversationId = createConversation('owner'), runId = createRun({ correlationId: 'fixture', actorId: 'owner', objective: 'Fixture', conversationId });
  appendTurn({ conversationId, ownerId: 'owner', role: 'assistant', content: 'Sensitive fixture output', runId });
  recordOutputClassification(runId, 'sensitive'); recordOutputClassification(runId, 'private'); closeAllForTests(); getDb();
  assert.equal(getOutputClassification(runId), 'sensitive'); assert.equal(getPriorTurnsForModel(conversationId, 'owner', 'next')[0].classification, 'sensitive');
  recordOutputClassification(runId, 'public'); assert.equal(getOutputClassification(runId), 'sensitive');
  const other = createRun({ correlationId: 'other', actorId: 'owner', objective: 'Fixture' }); recordOutputClassification(other, undefined);
  assert.equal(getOutputClassification(other), 'sensitive'); assert.equal(getOutputClassification('missing'), 'sensitive');
}));

test('a later less-restricted bounded round cannot downgrade the actual saved response', () => home(async () => {
  const dataPolicy = policy(), registry = new ToolRegistry(), conversationId = createConversation('owner'), labels = [];
  registry.register({ name: 'fixture.read', domain: 'fixture', category: 'read', schema: { properties: {}, required: [] }, execute: async () => {
    dataPolicy.policies.sensitive.local_models = 'never'; return { id: 'fixture-read-result' };
  } });
  let calls = 0;
  const instance = new Agent({ modelProvider: { id: 'local', destination: 'local_model', plan: async context => {
    calls++;
    assert.equal(context.personalContext.relevantFacts.length, calls === 1 ? 1 : 0);
    return calls === 1 ? { reasoning_summary: 'Read fixture', continue: true, actions: [{ tool: 'fixture.read', arguments: {} }] } : plan('A later safe-looking response');
  } }, policyEngine: new PolicyEngine({ policies: { fixture: { read: 'autonomous' } } }), toolRegistry: registry, eventBus: new EventBus(getDb()), dataProcessingPolicy: dataPolicy });
  instance.contextAssembler.assemble = async () => ({ toolRegistry: registry, personalContext: { relevantFacts: [{ factId: 'sensitive-source', classification: 'sensitive', value: 'fixture-only source' }] } });
  const original = instance.planner.getPlanContext.bind(instance.planner);
  instance.planner.getPlanContext = proposed => { const metadata = original(proposed); labels.push(metadata.outputClassification); return metadata; };
  const result = await instance.handleMessage({ text: 'Bounded fixture task', actorId: 'owner', conversationId });
  assert.equal(calls, 2); assert.deepEqual(labels, ['sensitive', 'private']); assert.equal(getOutputClassification(result.runId), 'sensitive');
  assert.equal(getDb().prepare("SELECT classification FROM conversation_messages WHERE run_id=? AND role='assistant'").get(result.runId).classification, 'sensitive');
}));

test('legacy linked/orphaned assistant transcripts migrate restrictively without altering data or run state', () => home(async () => {
  const conversationId = createConversation('owner'), runId = createRun({ correlationId: 'old', actorId: 'owner', objective: 'Preserve original objective', conversationId });
  getDb().prepare("UPDATE agent_runs SET status='needs_attention', input_tokens=123, model_call_count=2 WHERE id=?").run(runId);
  appendTurn({ conversationId, ownerId: 'owner', role: 'user', content: 'Existing owner text', runId });
  appendTurn({ conversationId, ownerId: 'owner', role: 'assistant', content: 'Existing derived text', runId });
  appendTurn({ conversationId, ownerId: 'owner', role: 'assistant', content: 'Existing orphan text', runId: 'old-orphan' });
  const before = getDb().prepare('SELECT * FROM conversation_messages ORDER BY rowid').all();
  getDb().exec('ALTER TABLE agent_runs DROP COLUMN output_classification');
  const oldRun = getDb().prepare('SELECT * FROM agent_runs WHERE id=?').get(runId); closeAllForTests(); getDb();
  const migrated = getDb().prepare('SELECT * FROM agent_runs WHERE id=?').get(runId);
  const { output_classification, ...preserved } = migrated; assert.equal(output_classification, 'sensitive'); assert.deepEqual(preserved, { ...oldRun });
  assert.deepEqual(getDb().prepare('SELECT * FROM conversation_messages ORDER BY rowid').all(), before);
  assert.deepEqual(getPriorTurnsForModel(conversationId, 'owner', 'next').map(turn => turn.classification), ['private', 'sensitive', 'sensitive']);
  closeAllForTests(); getDb(); assert.deepEqual(getDb().prepare('SELECT * FROM agent_runs WHERE id=?').get(runId), migrated);
  assert.throws(() => appendTurn({ conversationId, ownerId: 'owner', role: 'assistant', content: 'Invalid label', classification: 'public' }));
}));
