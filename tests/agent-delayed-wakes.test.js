import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../server/agent/agent.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { PolicyEngine, updateAgentAction } from '../server/policy/policy-engine.js';
import { EventBus } from '../server/events/event-bus.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createRun, getRun, listRunWakeCandidates, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { startServer } from './helpers/authed-server.js';
import { createGoalDraft, controlGoal } from '../server/agent/goal-store.js';

async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-delayed-wakes-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture({ effects = [], views = [], fail = false, depends = false, destination = 'local_model' } = {}) {
  const registry = new ToolRegistry();
  registry.register({ name: 'fixture.prepare', domain: 'fixture', category: 'read',
    schema: { properties: { label: { type: 'string' } }, required: ['label'] }, execute: async () => {
      effects.push('prepare');
      if (fail) throw new Error('fixture outcome unknown');
      return { id: 'artifact_fixture', classification: 'private' };
    } });
  registry.register({ name: 'fixture.inspect', domain: 'fixture', category: 'read',
    schema: { properties: { id: { type: 'string' } }, required: ['id'] }, execute: async ({ id }) => { effects.push(id); return { id }; } });
  const agent = new Agent({ modelProvider: { id: 'fixture', destination, plan: async (context) => {
    views.push(context.observations);
    if (!context.observations.length) return { reasoning_summary: 'Prepare', continue: !depends, actions: [
      { tool: 'fixture.prepare', arguments: { label: 'one' } },
      ...(depends ? [{ tool: 'fixture.inspect', arguments: { id: 'known_owner_id' }, dependsOn: [0] }] : []),
    ] };
    return { reasoning_summary: 'Inspect evidence', response: 'Inspected the observed artifact', actions: [
      { tool: 'fixture.inspect', arguments: { id: '' }, resultRefs: { id: { stepIndex: 0, itemIndex: 0, path: 'id' } } },
    ] };
  } }, policyEngine: new PolicyEngine(), toolRegistry: registry, eventBus: new EventBus(getDb()) });
  agent.contextAssembler.assemble = async ({ actor, correlationId }) => ({ actor, correlationId, eventBus: agent.eventBus });
  return agent;
}
function delayDelivery(agent) {
  const process = agent.actionQueueWorker.processAction.bind(agent.actionQueueWorker);
  agent.actionQueueWorker.processAction = async (id) => agent.actionQueueWorker._currentOutcome(id);
  return () => { agent.actionQueueWorker.processAction = process; };
}

test('delayed delivery resumes the correct checkpoint once, with no model work while pending', () => withHome(async () => {
  const effects = []; const views = []; const agent = fixture({ effects, views });
  const restore = delayDelivery(agent);
  const first = await agent.handleMessage({ text: 'Prepare and inspect', actorId: 'owner' });
  assert.equal(getRun(first.runId).status, 'waiting_for_action');
  for (let tick = 0; tick < 3; tick++) await agent.wakeWaitingRuns();
  assert.equal(views.length, 1); assert.deepEqual(effects, []);
  restore(); await agent.actionQueueWorker.processNext();
  await Promise.all([agent.wakeWaitingRuns(), agent.wakeWaitingRuns()]);
  assert.deepEqual(effects, ['prepare', 'artifact_fixture']);
  assert.equal(views.length, 2);
  assert.equal(views[1][0].items[0].data.id, 'artifact_fixture');
  assert.equal(getRun(first.runId).status, 'completed');
  await agent.wakeWaitingRuns();
  assert.equal(views.length, 2); assert.equal(effects.length, 2);
}));

test('same-plan dependent work waits for delayed delivery and cannot duplicate its claimed step', () => withHome(async () => {
  const effects = []; const views = []; const agent = fixture({ effects, views, depends: true });
  const restore = delayDelivery(agent);
  const first = await agent.handleMessage({ text: 'Prepare known owner artifact', actorId: 'owner' });
  assert.equal(getRun(first.runId).status, 'waiting_for_dependency');
  await agent.wakeWaitingRuns(); assert.deepEqual(effects, []);
  restore(); await agent.actionQueueWorker.processNext();
  await Promise.all([agent.wakeWaitingRuns(), agent.wakeWaitingRuns()]);
  assert.deepEqual(effects, ['prepare', 'known_owner_id']);
  assert.equal(views.length, 1);
  assert.equal(getRun(first.runId).status, 'completed');
}));

test('restart reconciliation resumes confirmed evidence without re-delivering its effect', () => withHome(async () => {
  const effects = []; const views = []; const firstAgent = fixture({ effects, views });
  const restore = delayDelivery(firstAgent);
  const first = await firstAgent.handleMessage({ text: 'Prepare and inspect', actorId: 'owner' });
  restore(); await firstAgent.actionQueueWorker.processNext();
  closeAllForTests(); getDb(); reconcileInterruptedRuns();
  const restarted = fixture({ effects, views });
  await restarted.wakeWaitingRuns();
  assert.deepEqual(effects, ['prepare', 'artifact_fixture']);
  assert.equal(getRun(first.runId).modelCalls, 2);
  assert.equal(getRun(first.runId).status, 'completed');
}));

test('failed/uncertain delivery, cancellation, deadlines and withheld observations never unlock a model effect', () => withHome(async () => {
  for (const mode of ['uncertain', 'rejected', 'cancelled', 'expired', 'budget', 'private']) {
    const effects = []; const views = []; const agent = fixture({ effects, views,
      fail: mode === 'uncertain', destination: mode === 'private' ? 'configured_remote_model' : 'local_model' });
    const restore = delayDelivery(agent);
    const first = await agent.handleMessage({ text: mode, actorId: 'owner' });
    if (mode === 'cancelled') await agent.cancelRun(first.runId, 'owner');
    if (mode === 'rejected') updateAgentAction(first.actions[0].id, { status: 'rejected' });
    if (mode === 'expired') getDb().prepare("UPDATE agent_runs SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(first.runId);
    if (mode === 'budget') getDb().prepare('UPDATE agent_runs SET model_call_count = 3 WHERE id = ?').run(first.runId);
    restore(); await agent.actionQueueWorker.processNext();
    await agent.wakeWaitingRuns(); await agent.wakeWaitingRuns();
    assert.ok(!effects.includes('artifact_fixture'));
    assert.equal(views.length, mode === 'private' ? 2 : 1);
    assert.ok(['needs_attention', 'cancelled', 'budget_exhausted', 'completed', 'failed'].includes(getRun(first.runId).status));
  }
}));

test('a stopped/revised goal cannot unlock old delayed work after resume', () => withHome(async () => {
  const effects = []; const views = []; const agent = fixture({ effects, views });
  agent.toolRegistry.get('fixture.prepare').domain = 'web';
  agent.toolRegistry.get('fixture.inspect').domain = 'web';
  const goal = createGoalDraft('owner', { objective: 'Research', completionCriteria: ['Evidence'], constraints: [],
    permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 10, maxModelCalls: 20, maxTokens: 1000 } });
  const restore = delayDelivery(agent);
  const first = await agent.handleMessage({ text: 'Research', actorId: 'owner', goalId: goal.id });
  controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 1 });
  controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 2 });
  restore(); await agent.actionQueueWorker.processNext(); await agent.wakeWaitingRuns();
  assert.deepEqual(effects, []); assert.equal(views.length, 1);
  assert.notEqual(getRun(first.runId).status, 'ready_to_continue');
}));

test('wake scans are bounded/fair and exclude active/terminal/cancelled runs', () => withHome(async () => {
  const ids = [];
  for (let index = 0; index < 25; index++) {
    const id = createRun({ correlationId: `fair_${index}`, actorId: 'owner', objective: 'Waiting' });
    getDb().prepare("UPDATE agent_runs SET status = 'waiting_for_action' WHERE id = ?").run(id); ids.push(id);
  }
  createRun({ correlationId: 'active', actorId: 'owner', objective: 'Active' });
  for (const status of ['completed', 'failed', 'cancelled']) {
    const id = createRun({ correlationId: status, actorId: 'owner', objective: 'Terminal' });
    getDb().prepare('UPDATE agent_runs SET status = ?, cancel_requested_at = ? WHERE id = ?')
      .run(status, status === 'cancelled' ? new Date().toISOString() : null, id);
  }
  const first = listRunWakeCandidates({ limit: 100 });
  assert.equal(first.length, 20);
  const second = listRunWakeCandidates({ afterId: first.at(-1).id });
  assert.equal(second.length, 5);
  assert.deepEqual(new Set([...first, ...second].map((row) => row.id)), new Set(ids));
  assert.equal(listRunWakeCandidates({ afterId: second.at(-1).id })[0].id, first[0].id);
  const agent = fixture();
  assert.deepEqual(await agent.wakeWaitingRuns({ shouldStop: () => true }), []);
}));

test('server wakes without browser, delivers during slow planning and drains in-flight continuation on stop', () => withHome(async () => {
  const handle = await startServer({ port: 0 });
  const entered = deferred(); const release = deferred(); let stopped;
  const anotherDelivered = deferred();
  let unsubscribe = () => {};
  try {
    const agent = handle.agent;
    const fixtureAgent = fixture();
    agent.planner = fixtureAgent.planner;
    agent.toolRegistry = fixtureAgent.toolRegistry;
    agent.actionEvaluator = fixtureAgent.actionEvaluator;
    agent.actionQueueWorker.actionEvaluator = fixtureAgent.actionEvaluator;
    agent.contextAssembler = fixtureAgent.contextAssembler;
    const originalPlan = agent.planner.modelProvider.plan;
    agent.planner.modelProvider.plan = async (context, objective) => {
      if (context.observations.length) { entered.resolve(); await release.promise; }
      return originalPlan(context, objective);
    };
    const restore = delayDelivery(agent);
    const first = await agent.handleMessage({ text: 'Background continuation', actorId: handle.auth.db.prepare('SELECT id FROM owners').get().id });
    restore();
    await entered.promise;
    const restoreSecond = delayDelivery(agent);
    const second = await agent.evaluateAndMaybeExecute({ tool: 'fixture.prepare', arguments: { label: 'second' }, requestedBy: 'owner' });
    unsubscribe = agent.eventBus.subscribe('agent.action.queue_updated', (event) => {
      if (event.subject?.id === second.id && event.data.status === 'completed') anotherDelivered.resolve();
    });
    restoreSecond();
    // A committed queue transition, not a sleep: the second action finishes
    // while the first continuation is still blocked at its model gate.
    await anotherDelivered.promise;
    let drained = false;
    stopped = handle.stopActionQueue().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    release.resolve(); await stopped;
    assert.equal(getRun(first.runId).status, 'completed');
  } finally {
    release.resolve(); await stopped; await handle.stopActionQueue();
    unsubscribe();
    handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve));
  }
}));
