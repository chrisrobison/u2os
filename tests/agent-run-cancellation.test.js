import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine, getAgentAction, updateAgentAction } from '../server/policy/policy-engine.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { Agent } from '../server/agent/agent.js';
import { enqueueAction, getQueuedActionByActionId, leaseActionByActionId } from '../server/agent/action-queue-store.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';

async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-cancel-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}

function fixture(plan, execute, policies = { fixture: { first: 'autonomous', second: 'autonomous' } }) {
  const registry = new ToolRegistry();
  for (const name of ['first', 'second']) registry.register({
    name: `fixture.${name}`, domain: 'fixture', category: 'consequential',
    schema: { properties: { label: { type: 'string' } }, required: ['label'] },
    execute: (args) => execute(name, args),
  });
  const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan },
    policyEngine: new PolicyEngine({ policies }), toolRegistry: registry, eventBus: new EventBus(getDb()) });
  agent.contextAssembler.assemble = async () => ({});
  return agent;
}

const twoSteps = async () => ({ reasoning_summary: 'Two steps', actions: [
  { tool: 'fixture.first', arguments: { label: 'one' } },
  { tool: 'fixture.second', arguments: { label: 'two' }, dependsOn: [0] },
] });

test('cancellation during an external action leaves its outcome authoritative and stops the next step', () => withHome(async () => {
  let began;
  let release;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const effects = [];
  const agent = fixture(twoSteps, async (name) => {
    effects.push(name);
    if (name === 'first') { began(); await held; }
    return { done: name };
  });
  const request = agent.handleMessage({ text: 'Do two things', actorId: 'owner' });
  await started;
  const runId = getDb().prepare('SELECT id FROM agent_runs LIMIT 1').get().id;
  const cancelling = await agent.cancelRun(runId, 'owner');
  assert.equal(cancelling.status, 'cancelling');
  assert.equal(cancelling.cancellationRequested, true);
  assert.equal(cancelling.steps[0].status, 'waiting_for_action');
  release();
  await request;
  assert.deepEqual(effects, ['first']);
  assert.deepEqual(getRun(runId).steps.map((step) => step.status), ['executed', 'cancelled']);
  assert.equal(getRun(runId).status, 'cancelled');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 1);
}));

test('cancellation while the model is planning discards its late proposal', () => withHome(async () => {
  let began;
  let release;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const effects = [];
  const agent = fixture(async () => { began(); await held; return twoSteps(); }, async (name) => { effects.push(name); return {}; });
  const request = agent.handleMessage({ text: 'Do two things' });
  await started;
  const runId = getDb().prepare('SELECT id FROM agent_runs LIMIT 1').get().id;
  await agent.cancelRun(runId, 'owner');
  release();
  await request;
  assert.equal(getRun(runId).status, 'cancelled');
  assert.deepEqual(effects, []);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 0);
}));

test('cancellation revokes a pending approval and survives restart', () => withHome(async () => {
  const effects = [];
  const agent = fixture(twoSteps, async (name) => { effects.push(name); return {}; }, { fixture: { first: 'confirm', second: 'autonomous' } });
  const result = await agent.handleMessage({ text: 'Do two things' });
  assert.equal(result.actions[0].status, 'pending');
  await agent.cancelRun(result.runId, 'owner');
  assert.equal(getAgentAction(result.actions[0].id).status, 'rejected');
  const firstRequestedAt = getRun(result.runId).cancelRequestedAt;
  await agent.cancelRun(result.runId, 'owner');
  assert.equal(getRun(result.runId).cancelRequestedAt, firstRequestedAt);
  await assert.rejects(agent.approveAction(result.actions[0].id, 'owner'), /cancelled/);
  closeAllForTests(); getDb(); reconcileInterruptedRuns();
  assert.equal(getRun(result.runId).status, 'cancelled');
  assert.deepEqual(effects, []);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 1);
}));

test('cancellation atomically removes an unleased action from the queue', () => withHome(async () => {
  const effects = [];
  const agent = fixture(async () => ({ reasoning_summary: 'One step', actions: [
    { tool: 'fixture.first', arguments: { label: 'one' } },
  ] }), async (name) => { effects.push(name); return {}; }, { fixture: { first: 'confirm' } });
  const result = await agent.handleMessage({ text: 'Do one thing' });
  const actionId = result.actions[0].id;
  updateAgentAction(actionId, { status: 'approved' });
  enqueueAction({ actionId, correlationId: result.correlationId, tool: 'fixture.first', arguments: { label: 'one' } });
  await agent.cancelRun(result.runId, 'owner');
  assert.equal(getQueuedActionByActionId(actionId).status, 'cancelled');
  assert.equal(getAgentAction(actionId).status, 'cancelled');
  await agent.actionQueueWorker.processAction(actionId);
  assert.deepEqual(effects, []);
  assert.equal(getRun(result.runId).status, 'cancelled');
}));

test('cancellation never relabels an uncertain provider outcome as safely cancelled', () => withHome(async () => {
  const agent = fixture(async () => ({ reasoning_summary: 'One step', actions: [
    { tool: 'fixture.first', arguments: { label: 'one' } },
  ] }), async () => ({}), { fixture: { first: 'confirm' } });
  const result = await agent.handleMessage({ text: 'Do one thing' });
  const actionId = result.actions[0].id;
  updateAgentAction(actionId, { status: 'approved' });
  const queue = enqueueAction({ actionId, correlationId: result.correlationId, tool: 'fixture.first', arguments: { label: 'one' } });
  const db = getDb();
  db.prepare("UPDATE action_queue SET status = 'failed', error_class = 'owner_attention_required' WHERE id = ?").run(queue.id);
  db.prepare(`INSERT INTO action_attempts (id, queue_id, attempt_number, lease_owner, status, started_at, finished_at, error, error_class)
    VALUES ('attempt_cancel_uncertain', ?, 1, 'expired-worker', 'failed', ?, ?, 'lease expired', 'retryable')`)
    .run(queue.id, new Date().toISOString(), new Date().toISOString());
  const status = await agent.cancelRun(result.runId, 'owner');
  assert.equal(status.cancellationRequested, true);
  assert.equal(status.status, 'needs_attention');
  assert.equal(status.steps[0].status, 'outcome_uncertain');
}));

test('a worker lease acquired just before cancellation cannot start a new provider attempt', () => withHome(async () => {
  const effects = [];
  const agent = fixture(async () => ({ reasoning_summary: 'One step', actions: [
    { tool: 'fixture.first', arguments: { label: 'one' } },
  ] }), async (name) => { effects.push(name); return {}; }, { fixture: { first: 'confirm' } });
  const result = await agent.handleMessage({ text: 'Do one thing' });
  const actionId = result.actions[0].id;
  updateAgentAction(actionId, { status: 'approved' });
  enqueueAction({ actionId, correlationId: result.correlationId, tool: 'fixture.first', arguments: { label: 'one' } });
  const leased = leaseActionByActionId(actionId, { leaseOwner: agent.actionQueueWorker.workerId });
  assert.equal((await agent.cancelRun(result.runId, 'owner')).status, 'cancelling');
  const outcome = await agent.actionQueueWorker._executeLeased(leased);
  assert.equal(outcome.status, 'cancelled');
  assert.deepEqual(effects, []);
  assert.equal(getRun(result.runId).status, 'cancelled');
}));
