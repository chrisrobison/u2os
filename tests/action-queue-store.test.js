import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDb, getDbPath, closeAllForTests } from '../server/db/connection.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import {
  actionIdempotencyKey,
  enqueueAction,
  getQueuedActionByActionId,
  listQueuedActions,
  beginActionAttempt,
  completeActionAttempt,
  failActionAttempt,
  leaseNextAction,
  listActionAttempts,
  retryDelayMs,
} from '../server/agent/action-queue-store.js';
import { classifyActionError } from '../server/agent/action-error-classifier.js';

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-queue-'));
  process.env.U2OS_HOME = dir;
  try { return fn(dir); } finally {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function auditAction(overrides = {}) {
  return recordAudit({
    requestedBy: 'user',
    tool: 'email.send',
    arguments: { to: 'sarah@example.test', subject: 'Hello' },
    status: 'approved',
    correlationId: 'corr_123',
    policyDomain: 'email',
    policyRule: 'email.send.default:confirm',
    ...overrides,
  });
}

test('enqueueAction persists validated arguments, provenance references, and a stable idempotency key', () => withTempHome(() => {
  const action = auditAction();
  const queued = enqueueAction({
    actionId: action.id,
    correlationId: action.correlation_id,
    tool: action.tool,
    arguments: action.arguments,
    approvalReference: `${action.id}:${action.approved_at || 'autonomous'}`,
    policyDecisionReference: action.policy_rule,
    now: '2026-09-20T12:00:00.000Z',
  });

  assert.equal(queued.status, 'queued');
  assert.equal(queued.action_id, action.id);
  assert.deepEqual(queued.arguments, action.arguments);
  assert.equal(queued.idempotency_key, `email.send:corr_123:${action.id}`);
  assert.equal(queued.policy_decision_reference, 'email.send.default:confirm');
  assert.equal(queued.next_attempt_at, '2026-09-20T12:00:00.000Z');
}));

test('enqueueAction is idempotent and never resets an existing action queue row', () => withTempHome(() => {
  const action = auditAction();
  const first = enqueueAction({ actionId: action.id, correlationId: 'corr_123', tool: action.tool, arguments: action.arguments });
  getDb().prepare("UPDATE action_queue SET status = 'completed', attempt_count = 1 WHERE id = ?").run(first.id);

  const second = enqueueAction({ actionId: action.id, correlationId: 'corr_123', tool: action.tool, arguments: { subject: 'changed' } });
  assert.equal(second.id, first.id);
  assert.equal(second.status, 'completed');
  assert.equal(second.attempt_count, 1);
  assert.equal(second.arguments.subject, 'Hello');
  assert.equal(listQueuedActions().length, 1);
}));

test('attempt history is append-only and numbered from persisted queue state', () => withTempHome(() => {
  const action = auditAction();
  const queued = enqueueAction({
    actionId: action.id,
    tool: action.tool,
    arguments: action.arguments,
    now: '2026-09-20T12:00:00.000Z',
  });
  leaseNextAction({ leaseOwner: 'worker-a', leaseMs: 120_000, now: '2026-09-20T12:00:30.000Z' });
  const attempt = beginActionAttempt({ queueId: queued.id, leaseOwner: 'worker-a', now: '2026-09-20T12:01:00.000Z' });
  assert.equal(attempt.attempt_number, 1);
  assert.equal(getQueuedActionByActionId(action.id).status, 'executing');

  const finished = failActionAttempt(attempt.id, {
    leaseOwner: 'worker-a', error: 'timeout', errorClass: 'retryable', now: '2026-09-20T12:01:05.000Z',
  });
  assert.equal(finished.status, 'retry_wait');
  assert.equal(finished.error_class, 'retryable');
  assert.equal(listActionAttempts(queued.id).length, 1);
}));

test('only one duplicate scheduler tick can atomically lease a due action', () => withTempHome(() => {
  const action = auditAction();
  enqueueAction({ actionId: action.id, tool: action.tool, now: '2026-09-20T12:00:00.000Z' });
  const first = leaseNextAction({ leaseOwner: 'worker-a', now: '2026-09-20T12:00:01.000Z' });
  const duplicate = leaseNextAction({ leaseOwner: 'worker-b', now: '2026-09-20T12:00:01.000Z' });
  assert.equal(first.action_id, action.id);
  assert.equal(first.lease_owner, 'worker-a');
  assert.equal(duplicate, null);
}));

test('an expired lease is recoverable after restart and its abandoned attempt is closed', () => withTempHome(() => {
  const action = auditAction();
  const queued = enqueueAction({ actionId: action.id, tool: action.tool, now: '2026-09-20T12:00:00.000Z' });
  leaseNextAction({ leaseOwner: 'old-process', leaseMs: 1_000, now: '2026-09-20T12:00:01.000Z' });
  beginActionAttempt({ queueId: queued.id, leaseOwner: 'old-process', now: '2026-09-20T12:00:01.500Z' });

  const recovered = leaseNextAction({ leaseOwner: 'new-process', now: '2026-09-20T12:00:03.000Z' });
  assert.equal(recovered.id, queued.id);
  assert.equal(recovered.lease_owner, 'new-process');
  assert.equal(listActionAttempts(queued.id)[0].error, 'lease expired');
}));

test('retries use bounded exponential backoff and become dead letters when exhausted', () => withTempHome(() => {
  const action = auditAction();
  const queued = enqueueAction({ actionId: action.id, tool: action.tool, now: '2026-09-20T12:00:00.000Z' });
  leaseNextAction({ leaseOwner: 'worker-a', now: '2026-09-20T12:00:01.000Z' });
  const first = beginActionAttempt({ queueId: queued.id, leaseOwner: 'worker-a', now: '2026-09-20T12:00:02.000Z' });
  const retry = failActionAttempt(first.id, { leaseOwner: 'worker-a', error: 'timeout', errorClass: 'retryable', maxAttempts: 2, now: '2026-09-20T12:00:03.000Z' });
  assert.equal(retry.next_attempt_at, '2026-09-20T12:00:04.000Z');
  assert.equal(leaseNextAction({ leaseOwner: 'too-early', now: '2026-09-20T12:00:03.999Z' }), null);

  leaseNextAction({ leaseOwner: 'worker-b', now: '2026-09-20T12:00:04.000Z' });
  const second = beginActionAttempt({ queueId: queued.id, leaseOwner: 'worker-b', now: '2026-09-20T12:00:04.100Z' });
  const dead = failActionAttempt(second.id, { leaseOwner: 'worker-b', error: 'timeout again', errorClass: 'retryable', maxAttempts: 2, now: '2026-09-20T12:00:05.000Z' });
  assert.equal(dead.status, 'dead_letter');
  assert.equal(dead.lease_owner, null);
}));

test('completion and terminal failures clear leases and cannot be settled twice', () => withTempHome(() => {
  const action = auditAction();
  const queued = enqueueAction({ actionId: action.id, tool: action.tool, now: '2026-09-20T12:00:00.000Z' });
  leaseNextAction({ leaseOwner: 'worker-a', now: '2026-09-20T12:00:01.000Z' });
  const attempt = beginActionAttempt({ queueId: queued.id, leaseOwner: 'worker-a', now: '2026-09-20T12:00:02.000Z' });
  assert.equal(completeActionAttempt(attempt.id, { leaseOwner: 'worker-a' }).status, 'completed');
  assert.throws(() => completeActionAttempt(attempt.id, { leaseOwner: 'worker-a' }), /not executing/);
  assert.equal(leaseNextAction({ leaseOwner: 'worker-b', now: '2030-01-01T00:00:00.000Z' }), null);
}));

test('error classification and backoff are deterministic and fail closed', () => {
  assert.equal(classifyActionError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 'retryable');
  assert.equal(classifyActionError({ status: 401 }), 'authentication_required');
  assert.equal(classifyActionError({ ownerAttentionRequired: true }), 'owner_attention_required');
  assert.equal(classifyActionError(new Error('unknown provider failure')), 'non_retryable');
  assert.equal(retryDelayMs(1), 1_000);
  assert.equal(retryDelayMs(20), 60_000);
  assert.throws(() => retryDelayMs(1, { baseDelayMs: 0 }), /positive/);
});

test('existing installations gain queue tables without altering their agent action rows', () => withTempHome(() => {
  const dbPath = getDbPath();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE agent_actions (
      id TEXT PRIMARY KEY, requested_by TEXT NOT NULL, request_text TEXT,
      model TEXT, tool TEXT NOT NULL, arguments TEXT NOT NULL DEFAULT '{}',
      reasoning_summary TEXT, policy_domain TEXT, policy_rule TEXT,
      autonomy_level INTEGER, requires_approval INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending', approved_by TEXT, approved_at TEXT,
      result TEXT, correlation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO agent_actions
      (id, requested_by, tool, arguments, status, created_at, updated_at)
    VALUES ('act_existing', 'user', 'email.send', '{}', 'executed', 'old', 'old');
  `);
  legacy.close();

  const db = getDb();
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_queue'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_attempts'").get());
  assert.equal(db.prepare("SELECT status FROM agent_actions WHERE id='act_existing'").get().status, 'executed');
}));

test('actionIdempotencyKey requires durable action identity and does not depend on arguments', () => {
  assert.equal(actionIdempotencyKey({ tool: 'calendar.create', correlationId: 'corr_x', actionId: 'act_y' }), 'calendar.create:corr_x:act_y');
  assert.throws(() => actionIdempotencyKey({ tool: 'email.send' }), /required/);
});
