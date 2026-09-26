import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine, recordAudit, getAgentAction } from '../server/policy/policy-engine.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { ActionEvaluator } from '../server/agent/action-evaluator.js';
import { ActionExecutor } from '../server/agent/action-executor.js';
import { ActionQueueWorker } from '../server/agent/action-queue-worker.js';
import {
  beginActionAttempt,
  enqueueAction,
  getQueuedActionByActionId,
  leaseActionByActionId,
  leaseNextAction,
  requeueAction,
  listActionAttempts,
} from '../server/agent/action-queue-store.js';

function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-worker-'));
  process.env.U2OS_HOME = dir;
  return Promise.resolve().then(fn).finally(() => {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function setup({ execute, supportsIdempotency = false, policy = 'autonomous', maxActionAgeMs, leaseMs, leaseRenewalIntervalMs } = {}) {
  const eventBus = new EventBus(getDb());
  const tool = {
    name: 'delivery.send', domain: 'delivery', category: 'consequential', supportsIdempotency,
    execute: execute || (async () => ({ ok: true })),
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const policyEngine = new PolicyEngine({ policies: { delivery: { send: policy } } });
  const evaluator = new ActionEvaluator({ toolRegistry: registry, policyEngine });
  const executor = new ActionExecutor({ eventBus });
  const worker = new ActionQueueWorker({ actionEvaluator: evaluator, actionExecutor: executor, eventBus, workerId: 'worker-new', maxActionAgeMs, leaseMs, leaseRenewalIntervalMs });
  return { eventBus, tool, policyEngine, worker };
}

function queueAudit({ status = 'approved', approvedAt = null, actor = { type: 'agent', id: 'agent_default' } } = {}) {
  const action = recordAudit({
    requestedBy: actor.id, tool: 'delivery.send', arguments: { payload: 'hello' },
    status, approvedAt, approvedBy: approvedAt ? actor.id : null,
    correlationId: 'corr_delivery', policyDomain: 'delivery',
    policyRule: 'delivery.send:autonomous', requiresApproval: !!approvedAt,
  });
  enqueueAction({
    actionId: action.id, correlationId: action.correlation_id, tool: action.tool,
    arguments: action.arguments, actor, approvalReference: approvedAt || 'autonomous',
    policyDecisionReference: action.policy_rule,
  });
  return action;
}

test('worker executes a queued action once and passes its durable idempotency key', () => withHome(async () => {
  const calls = [];
  const { worker } = setup({ execute: async (_args, context) => { calls.push(context.idempotencyKey); return { delivered: true }; } });
  const action = queueAudit();
  const outcome = await worker.processAction(action.id);
  assert.equal(outcome.status, 'executed');
  assert.equal(getQueuedActionByActionId(action.id).status, 'completed');
  assert.deepEqual(calls, [`delivery.send:corr_delivery:${action.id}`]);
  const queueEvent = getDb().prepare("SELECT data FROM events WHERE type = 'agent.action.queue_updated' AND subject_id = ?").get(action.id);
  assert.deepEqual(JSON.parse(queueEvent.data), { status: 'completed', attemptCount: 1, errorClass: null });
  await worker.processAction(action.id);
  assert.equal(calls.length, 1, 'a completed action must never execute again');
}));

test('current policy is re-evaluated after enqueue and can block execution', () => withHome(async () => {
  let calls = 0;
  const { worker, policyEngine } = setup({ execute: async () => { calls += 1; } });
  const action = queueAudit();
  policyEngine.policies.delivery.send = 'never';
  const outcome = await worker.processAction(action.id);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(getAgentAction(action.id).status, 'blocked');
  assert.equal(calls, 0);
}));

test('an action older than the freshness limit stops for owner attention', () => withHome(async () => {
  let calls = 0;
  const { worker } = setup({ execute: async () => { calls += 1; }, maxActionAgeMs: 1_000 });
  const action = queueAudit();
  getDb().prepare("UPDATE agent_actions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(action.id);
  const outcome = await worker.processAction(action.id);
  assert.equal(outcome.errorClass, 'owner_attention_required');
  assert.equal(calls, 0);
}));

test('rejected or revoked approval cannot execute queued work', () => withHome(async () => {
  let calls = 0;
  const { worker } = setup({ execute: async () => { calls += 1; }, policy: 'confirm' });
  const action = queueAudit({ status: 'approved', approvedAt: new Date().toISOString(), actor: { type: 'user', id: 'owner' } });
  getDb().prepare("UPDATE agent_actions SET status = 'rejected', rejected_by = 'owner', rejected_at = ? WHERE id = ?")
    .run(new Date().toISOString(), action.id);
  const outcome = await worker.processAction(action.id);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(calls, 0);
}));

test('expired uncertain execution is not replayed without provider idempotency', () => withHome(async () => {
  let calls = 0;
  setup({ execute: async () => { calls += 1; } });
  const action = queueAudit();
  const queue = getQueuedActionByActionId(action.id);
  leaseActionByActionId(action.id, { leaseOwner: 'dead-worker', leaseMs: 60_000 });
  beginActionAttempt({ queueId: queue.id, leaseOwner: 'dead-worker' });
  getDb().prepare("UPDATE action_queue SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(queue.id);
  closeAllForTests();

  const { worker: restartedWorker } = setup({ execute: async () => { calls += 1; } });
  const outcome = await restartedWorker.processAction(action.id);
  assert.equal(outcome.errorClass, 'outcome_uncertain');
  assert.match(outcome.error, /originally bound provider\/account.*no automatic retry/);
  assert.equal(getQueuedActionByActionId(action.id).error_class, 'outcome_uncertain');
  assert.equal(listActionAttempts(queue.id).length, 1);
  assert.throws(() => requeueAction(queue.id), /cannot be requeued/);
  assert.equal(calls, 0, 'an uncertain non-idempotent side effect must not be repeated');
}));

test('an idempotent provider may safely recover an expired execution with the same key', () => withHome(async () => {
  const keys = [];
  setup({ supportsIdempotency: true, execute: async (_args, context) => { keys.push(context.idempotencyKey); return { ok: true }; } });
  const action = queueAudit();
  const queue = getQueuedActionByActionId(action.id);
  leaseActionByActionId(action.id, { leaseOwner: 'dead-worker', leaseMs: 60_000 });
  beginActionAttempt({ queueId: queue.id, leaseOwner: 'dead-worker' });
  getDb().prepare("UPDATE action_queue SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(queue.id);
  closeAllForTests();

  const { worker: restartedWorker } = setup({ supportsIdempotency: true, execute: async (_args, context) => { keys.push(context.idempotencyKey); return { ok: true }; } });
  const outcome = await restartedWorker.processAction(action.id);
  assert.equal(outcome.status, 'executed');
  assert.deepEqual(keys, [`delivery.send:corr_delivery:${action.id}`]);
}));

test('queued work survives a database close and is executed by a new process worker', () => withHome(async () => {
  setup();
  const action = queueAudit();
  closeAllForTests();
  let calls = 0;
  const { worker } = setup({ execute: async () => { calls += 1; return { ok: true }; } });
  const outcome = await worker.processNext();
  assert.equal(outcome.status, 'executed');
  assert.equal(outcome.id, action.id);
  assert.equal(calls, 1);
}));

test('retryable idempotent failures resume when due and duplicate calls do not double execute', () => withHome(async () => {
  let calls = 0;
  const { worker } = setup({
    supportsIdempotency: true,
    execute: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('temporary outage'), { code: 'ETIMEDOUT' });
      return { ok: true };
    },
  });
  const action = queueAudit();
  const failed = await worker.processAction(action.id);
  assert.equal(failed.status, 'retry_wait');
  getDb().prepare("UPDATE action_queue SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE action_id = ?").run(action.id);
  const [completed] = await Promise.all([worker.processAction(action.id), worker.processAction(action.id)]);
  assert.equal(completed.status, 'executed');
  assert.equal(calls, 2);
}));

test('long-running execution renews its lease so another worker cannot reclaim it', () => withHome(async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstSetup = setup({ execute: async () => { await gate; return { ok: true }; }, leaseMs: 60_000, leaseRenewalIntervalMs: 10 });
  const action = queueAudit();
  const running = firstSetup.worker.processAction(action.id);
  try {
    const initialExpiry = getQueuedActionByActionId(action.id).lease_expires_at;
    // Wait for an actual heartbeat, not a guessed amount of wall time. The
    // simulated competing clock is just past the original lease expiry.
    const deadline = Date.now() + 5_000;
    while (getQueuedActionByActionId(action.id).lease_expires_at === initialExpiry && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.notEqual(getQueuedActionByActionId(action.id).lease_expires_at, initialExpiry, 'heartbeat renewed the lease');

    assert.equal(leaseNextAction({ leaseOwner: 'worker-second', leaseMs: 60_000,
      now: new Date(Date.parse(initialExpiry) + 1) }), null);
    assert.equal(getQueuedActionByActionId(action.id).attempt_count, 1);
  } finally { release(); }
  assert.equal((await running).status, 'executed');
}));
