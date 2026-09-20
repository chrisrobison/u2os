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
  finishActionAttempt,
  listActionAttempts,
} from '../server/agent/action-queue-store.js';

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
  const queued = enqueueAction({ actionId: action.id, tool: action.tool, arguments: action.arguments });
  const attempt = beginActionAttempt({ queueId: queued.id, leaseOwner: 'worker-a', now: '2026-09-20T12:01:00.000Z' });
  assert.equal(attempt.attempt_number, 1);
  assert.equal(getQueuedActionByActionId(action.id).status, 'executing');

  const finished = finishActionAttempt(attempt.id, {
    status: 'failed', error: 'timeout', errorClass: 'retryable', now: '2026-09-20T12:01:05.000Z',
  });
  assert.equal(finished.status, 'failed');
  assert.equal(finished.error_class, 'retryable');
  assert.equal(listActionAttempts(queued.id).length, 1);
}));

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
