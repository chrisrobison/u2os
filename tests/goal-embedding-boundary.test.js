import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { createEntity } from '../server/memory/entity-store.js';
import { recordFact } from '../server/memory/fact-store.js';
import { EventBus } from '../server/events/event-bus.js';
import { Agent } from '../server/agent/agent.js';
import { ContextAssembler } from '../server/agent/context-assembler.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { PolicyEngine, recordAudit } from '../server/policy/policy-engine.js';
import { createGoalDraft, getGoalDraft } from '../server/agent/goal-store.js';
import { getRun, createRun, beginModelCall, recordRunPlan, beginRunStep, recordRunStepOutcome, finishRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';

const objective = 'Research remote roles with Fixture Recruiter';
const draft = { objective, completionCriteria: ['Report sourced findings'], constraints: ['Remote only'], permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 3, maxModelCalls: 3, maxTokens: 5000 } };
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-goal-embedding-')), previous = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    ensureInstallationMode('personal');
    const person = createEntity({ type: 'Person', name: 'Fixture Recruiter' });
    const fact = recordFact({ entityId: person.id, key: 'preferences', value: 'Research remote roles', source: 'fixture:owner', confidence: 1 });
    await operation({ home, person, fact });
  } finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); }
}
function build(embeddingProvider, plan, { destination = 'local_model', ownerEntityId = null } = {}) {
  const registry = new ToolRegistry();
  registry.register({ name: 'web.search', domain: 'web', category: 'read', schema: { properties: { query: { type: 'string' } }, required: ['query'] }, execute: async () => [{ title: 'Fixture role', url: 'https://example.test/role', snippet: 'Remote role' }] });
  return new Agent({ modelProvider: { id: 'fixture-planner', destination, plan }, embeddingProvider, ownerEntityId, toolRegistry: registry, eventBus: new EventBus(getDb()), policyEngine: new PolicyEngine({ policies: { web: { search: 'autonomous' } } }) });
}
const finish = { reasoning_summary: 'Read-only research finished', actions: [], response: 'No objective completion verified.' };
const searchRound = { reasoning_summary: 'One bounded search', continue: true, actions: [{ tool: 'web.search', arguments: { query: 'remote roles' } }] };

test('goal initial/continuation retrieval keeps useful facts and provenance with zero auxiliary calls/cache writes', () => fixture(async ({ person, fact }) => {
  let embeddings = 0, plans = 0;
  const provider = { id: 'fixture-embedding', destination: 'local_model', embed() { embeddings++; throw new Error('Unmetered model must not run'); } };
  const agent = build(provider, async (context) => {
    plans++;
    assert.ok(context.personalContext.relevantPeople.some((item) => item.id === person.id && item.facts.some((item) => item.factId === fact.id)));
    assert.ok(context.personalContext.provenanceRefs.some((item) => item.id === fact.id));
    return plans === 1 ? searchRound : finish;
  }, { ownerEntityId: person.id });
  const goal = createGoalDraft('owner', draft);
  const result = await agent.handleMessage({ text: objective, actorId: 'owner', goalId: goal.id });
  assert.equal(plans, 2); assert.equal(embeddings, 0); assert.equal(getDb().prepare('SELECT count(*) n FROM embeddings').get().n, 0);
  assert.equal(getRun(result.runId).modelCalls, 2); assert.equal(getGoalDraft(goal.id, 'owner').spent.modelCalls, 2);
  assert.equal(agent.contextAssembler.embeddingProvider, provider); assert.equal(getRun(result.runId).objectiveStatus, 'unverified');
}));

test('ordinary chat and standalone context keep configured semantic retrieval', () => fixture(async () => {
  let calls = 0;
  const provider = { id: 'fixture-embedding', destination: 'local_model', async embed() { calls++; return [1, 0, 0]; } };
  const agent = build(provider, async () => finish);
  await agent.handleMessage({ text: objective, actorId: 'owner' });
  assert.ok(calls > 0); const prior = calls;
  await agent.contextAssembler.assemble({ objective }); assert.ok(calls > prior);
  assert.equal(agent.contextAssembler.embeddingProvider, provider);
}));

test('overlapping lexical/semantic requests cannot mutate shared provider, owner link or bounds', () => fixture(async ({ person, fact }) => {
  recordFact({ entityId: person.id, key: 'second', value: 'Lower ranked fact', source: 'fixture:owner', confidence: 0.5 });
  const entered = deferred(), release = deferred(); let calls = 0;
  const provider = { id: 'fixture-embedding', destination: 'local_model', async embed() { calls++; entered.resolve(); await release.promise; return [1, 0, 0]; } };
  const assembler = new ContextAssembler({ embeddingProvider: provider, ownerEntityId: person.id, maxFactsPerPerson: 1 });
  const ordinary = assembler.assemble({ objective, actor: { type: 'user', id: 'owner' } });
  await entered.promise; const before = calls;
  try {
    const goal = await assembler.assemble({ objective, allowEmbeddings: false, actor: { type: 'user', id: 'owner' } });
    assert.equal(calls, before); assert.equal(assembler.embeddingProvider, provider); assert.equal(assembler.ownerEntityId, person.id);
    const selected = goal.personalContext.relevantPeople.find((item) => item.id === person.id);
    assert.equal(selected.facts.length, 1); assert.equal(selected.facts[0].factId, fact.id);
  } finally { release.resolve(); await ordinary; }
  assert.ok(calls > before);
}));

test('lexical goal context is still filtered for the actual planner destination', () => fixture(async ({ fact }) => {
  getDb().prepare("UPDATE facts SET classification='sensitive',value=? WHERE id=?").run(JSON.stringify('never-send-this-fixture'), fact.id);
  let calls = 0;
  const provider = { id: 'fixture-embedding', destination: 'local_model', embed() { calls++; throw new Error('not authorized by goal budget'); } };
  const agent = build(provider, async (context) => {
    assert.ok(!JSON.stringify(context.personalContext).includes(fact.id));
    assert.ok(!JSON.stringify(context.personalContext).includes('never-send-this-fixture'));
    return finish;
  }, { destination: 'configured_remote_model' });
  const goal = createGoalDraft('owner', draft);
  await agent.handleMessage({ text: objective, actorId: 'owner', goalId: goal.id }); assert.equal(calls, 0);
}));

test('restarted goal runs retain planning budget and never re-enable configured embeddings', () => fixture(async () => {
  let calls = 0;
  const provider = { id: 'fixture-embedding', destination: 'local_model', embed() { calls++; throw new Error('must remain unused'); } };
  const goal = createGoalDraft('owner', { ...draft, budgets: { ...draft.budgets, maxModelCalls: 1 } });
  await build(provider, async () => finish).handleMessage({ text: objective, actorId: 'owner', goalId: goal.id });
  closeAllForTests();
  const restarted = build(provider, async () => { throw new Error('Exhausted budget cannot call planner'); });
  await assert.rejects(restarted.handleMessage({ text: objective, actorId: 'owner', goalId: goal.id }), { status: 409 });
  assert.equal(calls, 0); assert.equal(getGoalDraft(goal.id, 'owner').spent.modelCalls, 1);
}));

for (const maxModelCalls of [3, 1]) {
  test(`persisted goal continuation with ${maxModelCalls} call budget cannot invoke auxiliary embeddings or replay a completed read`, () => fixture(async () => {
    const goal = createGoalDraft('owner', { ...draft, budgets: { ...draft.budgets, maxModelCalls } });
    const runId = createRun({ correlationId: 'fixture_checkpoint', actorId: 'owner', objective, goalId: goal.id });
    beginModelCall(runId); recordRunPlan(runId, searchRound);
    const actionId = beginRunStep(runId, 0);
    recordAudit({ id: actionId, requestedBy: 'owner', tool: 'web.search', arguments: { query: 'remote roles' }, status: 'executed', result: [{ title: 'Fixture role', url: 'https://example.test/role' }] });
    recordRunStepOutcome(runId, 0, 'executed'); finishRun(runId);
    assert.equal(getRun(runId).status, 'ready_to_continue');
    closeAllForTests(); getDb(); reconcileInterruptedRuns();
    let embeddings = 0, plans = 0;
    const agent = build({ id: 'fixture-embedding', destination: 'local_model', embed() { embeddings++; throw new Error('Unmetered auxiliary call'); } }, async (context) => {
      plans++; assert.equal(context.observations[0].items[0].data.title, 'Fixture role'); return finish;
    });
    agent.toolRegistry.get('web.search').execute = async () => { throw new Error('Completed read must not replay'); };
    await Promise.all([agent.resumeRunPlanning(runId), agent.resumeRunPlanning(runId)]);
    assert.equal(embeddings, 0); assert.equal(plans, maxModelCalls === 1 ? 0 : 1);
    assert.equal(getRun(runId).status, maxModelCalls === 1 ? 'budget_exhausted' : 'completed');
    assert.equal(getRun(runId).modelCalls, maxModelCalls === 1 ? 1 : 2);
    assert.equal(getDb().prepare('SELECT count(*) n FROM embeddings').get().n, 0);
    assert.equal(getDb().prepare('SELECT count(*) n FROM agent_actions').get().n, 1);
  }));
}
