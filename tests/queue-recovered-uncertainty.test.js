import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { Agent } from '../server/agent/agent.js';
import { PolicyEngine, getAgentAction, updateAgentAction } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { EventBus } from '../server/events/event-bus.js';
import { enqueueAction, leaseActionByActionId, beginActionAttempt, getQueuedActionByActionId, listActionAttempts, requeueAction } from '../server/agent/action-queue-store.js';
import { getRun, getRunResult, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { buildOperationsResponse } from '../server/api/routes/actions.js';

async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-queue-recovered-uncertainty-')), previous = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  let calls = 0, modelCalls = 0;
  const agent = () => {
    const registry = createToolRegistry(); registry.register({ name: 'fixture.deliver', domain: 'fixture', category: 'consequential', supportsIdempotency: false,
      schema: { type: 'object', properties: { payload: { type: 'string' } }, required: ['payload'] }, execute: async () => { calls++; return { id: 'fixture_receipt' }; } });
    const instance = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => { modelCalls++; return { reasoning_summary: 'Fixture delivery then dependent task', continue: true, actions: [
      { tool: 'fixture.deliver', arguments: { payload: 'fixture-private-payload' } },
      { tool: 'tasks.create', arguments: { title: 'Dependent fixture task' }, dependsOn: [0] },
    ] }; } }, toolRegistry: registry, policyEngine: new PolicyEngine({ policies: { fixture: { deliver: 'confirm' }, tasks: { create: 'autonomous' } } }), eventBus: new EventBus(getDb()) });
    instance.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return instance;
  };
  try {
    const first = agent(), run = await first.handleMessage({ text: 'Fixture persisted delivery', actorId: 'owner' }), actionId = run.actions[0].id;
    assert.equal(run.actions[0].status, 'pending');
    // Isolated persisted-checkpoint fixture, not a process-kill/live proof.
    // Model the state after owner approval and before/after executor handoff.
    const approvedAt = new Date().toISOString(), account = { providerId: 'fixture-provider', instanceId: 'fixture-account', label: 'Original fixture account' };
    getDb().prepare("UPDATE agent_actions SET status='approved',approved_by='owner',approved_at=?,account_binding=? WHERE id=?").run(approvedAt, JSON.stringify({ ...account, vaultKey: 'fixture-private-vault' }), actionId);
    const action = getAgentAction(actionId), queue = enqueueAction({ actionId, tool: action.tool, arguments: action.arguments, correlationId: action.correlation_id,
      actor: { type: 'user', id: 'owner' }, approvalReference: approvedAt });
    leaseActionByActionId(actionId, { leaseOwner: 'fixture-dead-worker', leaseMs: 30_000 });
    await operation({ run, actionId, queue, account, agent, first, calls: () => calls, modelCalls: () => modelCalls });
  } finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); }
}
const expireAndRestart = (f) => {
  getDb().prepare("UPDATE action_queue SET lease_expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(f.queue.id);
  closeAllForTests(); getDb(); reconcileInterruptedRuns(); return f.agent();
};
for (const route of ['action', 'next']) test(`recovered attempted ${route} lease reports uncertainty in queue/Operations/run without requeue, effects or planning`, () => fixture(async (f) => {
  beginActionAttempt({ queueId: f.queue.id, leaseOwner: 'fixture-dead-worker' });
  const restarted = expireAndRestart(f), outcome = route === 'action' ? await restarted.actionQueueWorker.processAction(f.actionId) : await restarted.actionQueueWorker.processNext();
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'outcome_uncertain'); assert.match(outcome.error, /originally bound provider\/account.*no automatic retry/);
  const queued = getQueuedActionByActionId(f.actionId); assert.equal(queued.error_class, 'outcome_uncertain'); assert.equal(queued.attempt_count, 1);
  const attempts = listActionAttempts(f.queue.id); assert.equal(attempts.length, 1); assert.equal(attempts[0].error, 'lease expired'); assert.equal(attempts[0].error_class, 'retryable', 'historical attempt metadata is not rewritten');
  const operations = buildOperationsResponse(), item = operations.items.find((value) => value.actionId === f.actionId);
  assert.equal(item.errorClass, 'outcome_uncertain'); assert.deepEqual(item.account, f.account); assert.doesNotMatch(JSON.stringify(operations), /fixture-private/);
  assert.equal(getAgentAction(f.actionId).status, 'failed'); assert.match(getAgentAction(f.actionId).result.error, /outcome is uncertain/);
  assert.throws(() => requeueAction(f.queue.id), /cannot be requeued/); await assert.rejects(restarted.approveAction(f.actionId, 'owner'), /not pending/);
  await restarted.resumeRunDependents(f.run.runId); await restarted.resumeRunPlanning(f.run.runId);
  assert.deepEqual(getRun(f.run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']); assert.equal(getRun(f.run.runId).status, 'needs_attention'); assert.equal(getRun(f.run.runId).objectiveStatus, 'unverified');
  assert.match(getRunResult(f.run.runId).response, /outcome uncertain/);
  closeAllForTests(); getDb(); reconcileInterruptedRuns(); const again = f.agent();
  assert.equal(await again.actionQueueWorker.processNext(), null); await again.resumeRunDependents(f.run.runId); await again.resumeRunPlanning(f.run.runId);
  assert.equal(f.calls(), 0); assert.equal(f.modelCalls(), 1); assert.equal(listActionAttempts(f.queue.id).length, 1);
  assert.equal(getDb().prepare('SELECT count(*) n FROM tasks').get().n, 0); assert.equal(getDb().prepare("SELECT count(*) n FROM events WHERE type='agent.action.completed'").get().n, 0);
  const transition = getDb().prepare("SELECT data FROM events WHERE type='agent.action.queue_updated' AND subject_id=? ORDER BY id DESC LIMIT 1").get(f.actionId);
  assert.equal(JSON.parse(transition.data).errorClass, 'outcome_uncertain');
}));
test('recovered unattempted non-idempotent lease may execute once rather than inventing uncertainty', () => fixture(async (f) => {
  const restarted = expireAndRestart(f), outcome = await restarted.actionQueueWorker.processNext();
  assert.equal(outcome.status, 'executed'); assert.equal(f.calls(), 1); assert.equal(listActionAttempts(f.queue.id).length, 1);
  assert.equal(getQueuedActionByActionId(f.actionId).error_class, null); assert.equal(await restarted.actionQueueWorker.processNext(), null); assert.equal(f.calls(), 1);
}));
test('authoritative completed action with expired unfinished queue checkpoint does not replay or become uncertain', () => fixture(async (f) => {
  beginActionAttempt({ queueId: f.queue.id, leaseOwner: 'fixture-dead-worker' });
  updateAgentAction(f.actionId, { status: 'executed', result: { id: 'fixture_observed_receipt' } });
  const restarted = expireAndRestart(f), outcome = await restarted.actionQueueWorker.processNext();
  assert.equal(outcome.status, 'executed'); assert.equal(f.calls(), 0); assert.equal(getQueuedActionByActionId(f.actionId).status, 'completed'); assert.equal(getQueuedActionByActionId(f.actionId).error_class, null);
  assert.deepEqual(getAgentAction(f.actionId).result, { id: 'fixture_observed_receipt' }); assert.equal(await restarted.actionQueueWorker.processNext(), null); assert.equal(f.calls(), 0);
}));
