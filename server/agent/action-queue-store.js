import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';

export const ACTION_QUEUE_STATUSES = Object.freeze([
  'queued',
  'leased',
  'executing',
  'retry_wait',
  'completed',
  'failed',
  'dead_letter',
  'cancelled',
]);

export function actionIdempotencyKey({ tool, correlationId, actionId }) {
  if (!tool || !actionId) throw new TypeError('tool and actionId are required for an idempotency key');
  return `${tool}:${correlationId || actionId}:${actionId}`;
}

/**
 * Persist an executable action exactly once. Re-enqueueing the same action
 * returns its existing row and never resets its operational state.
 */
export function enqueueAction({
  actionId,
  correlationId = null,
  tool,
  arguments: args = {},
  idempotencyKey,
  approvalReference = null,
  policyDecisionReference = null,
  actor = null,
  now = new Date().toISOString(),
}) {
  if (!actionId || !tool) throw new TypeError('actionId and tool are required');
  const key = idempotencyKey || actionIdempotencyKey({ tool, correlationId, actionId });
  const db = getDb();
  db.prepare(`
    INSERT INTO action_queue (
      id, action_id, correlation_id, tool, arguments, idempotency_key,
      status, attempt_count, next_attempt_at, approval_reference,
      policy_decision_reference, actor, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(action_id) DO NOTHING
  `).run(
    newId('queue'), actionId, correlationId, tool, JSON.stringify(args), key,
    now, approvalReference, policyDecisionReference, actor ? JSON.stringify(actor) : null, now, now,
  );
  return getQueuedActionByActionId(actionId);
}

export function getQueuedAction(id) {
  return rowToQueuedAction(getDb().prepare('SELECT * FROM action_queue WHERE id = ?').get(id));
}

export function getQueuedActionByActionId(actionId) {
  return rowToQueuedAction(getDb().prepare('SELECT * FROM action_queue WHERE action_id = ?').get(actionId));
}

/** Cancellation only wins before a worker leases an action. A leased or
 * executing provider call remains authoritative and must finish or reconcile. */
export function cancelUnstartedAction(actionId) {
  const now = new Date().toISOString();
  return withTransaction(getDb(), () => {
    const db = getDb();
    const row = db.prepare(`UPDATE action_queue SET status = 'cancelled', last_error = 'Run cancelled before attempt',
      error_class = 'non_retryable', updated_at = ?
      WHERE action_id = ? AND status IN ('queued', 'retry_wait')
      AND EXISTS (SELECT 1 FROM agent_actions WHERE id = ? AND status != 'executed') RETURNING *`).get(now, actionId, actionId);
    if (!row) return null;
    db.prepare("UPDATE agent_actions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, actionId);
    return rowToQueuedAction(row);
  });
}

export function listQueuedActions({ status } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM action_queue WHERE status = ? ORDER BY created_at').all(status)
    : db.prepare('SELECT * FROM action_queue ORDER BY created_at').all();
  return rows.map(rowToQueuedAction);
}

export function stopLeasedAction(queueId, {
  leaseOwner,
  status = 'cancelled',
  error = null,
  errorClass = null,
  now = new Date(),
}) {
  if (!['failed', 'cancelled', 'dead_letter'].includes(status)) throw new TypeError(`Invalid stop status: ${status}`);
  const nowIso = toDate(now).toISOString();
  const result = getDb().prepare(`
    UPDATE action_queue
    SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
        last_error = ?, error_class = ?, updated_at = ?
    WHERE id = ? AND status = 'leased' AND lease_owner = ?
  `).run(status, boundedError(error), errorClass, nowIso, queueId, leaseOwner);
  if (result.changes !== 1) throw new Error(`Queued action ${queueId} is not leased to ${leaseOwner}`);
  return getQueuedAction(queueId);
}

export function requeueAction(queueId, {
  approvalReference = null,
  policyDecisionReference = null,
  now = new Date(),
} = {}) {
  if (getQueuedAction(queueId)?.error_class === 'recovery_review_required') throw new Error('Restored action requires owner review and a fresh proposal; archived authorization cannot be retried');
  if (getQueuedAction(queueId)?.error_class === 'outcome_uncertain') throw new Error('Action delivery outcome is uncertain; reconcile the original outcome before any fresh proposal; this action cannot be requeued');
  const nowIso = toDate(now).toISOString();
  const result = getDb().prepare(`
    UPDATE action_queue
    SET status = 'queued', next_attempt_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, last_error = NULL, error_class = NULL,
        approval_reference = COALESCE(?, approval_reference),
        policy_decision_reference = COALESCE(?, policy_decision_reference),
        updated_at = ?
    WHERE id = ? AND status IN ('failed', 'cancelled')
  `).run(nowIso, approvalReference, policyDecisionReference, nowIso, queueId);
  if (result.changes !== 1) throw new Error(`Queued action ${queueId} cannot be requeued from its current state`);
  return getQueuedAction(queueId);
}

/** Atomically claims one due or expired item. Concurrent ticks cannot both win. */
export function leaseNextAction({ leaseOwner, leaseMs = 30_000, now = new Date() }) {
  if (!leaseOwner) throw new TypeError('leaseOwner is required');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
  const nowDate = toDate(now);
  const nowIso = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const db = getDb();
  const row = db.prepare(`
    UPDATE action_queue
    SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = (
      SELECT id FROM action_queue
      WHERE (
        status IN ('queued', 'retry_wait') AND next_attempt_at <= ?
      ) OR (
        status IN ('leased', 'executing') AND lease_expires_at <= ?
      )
      ORDER BY next_attempt_at, created_at
      LIMIT 1
    )
    AND (
      (status IN ('queued', 'retry_wait') AND next_attempt_at <= ?)
      OR (status IN ('leased', 'executing') AND lease_expires_at <= ?)
    )
    RETURNING *
  `).get(leaseOwner, expiresAt, nowIso, nowIso, nowIso, nowIso, nowIso);
  if (!row) return null;

  // If a process died after recording an attempt, close that historical
  // attempt before the new owner starts another one.
  db.prepare(`
    UPDATE action_attempts
    SET status = 'failed', finished_at = ?, error = 'lease expired', error_class = 'retryable'
    WHERE queue_id = ? AND status = 'executing'
  `).run(nowIso, row.id);
  return rowToQueuedAction(row);
}

export function leaseActionByActionId(actionId, { leaseOwner, leaseMs = 30_000, now = new Date() }) {
  if (!actionId || !leaseOwner) throw new TypeError('actionId and leaseOwner are required');
  const nowDate = toDate(now);
  const nowIso = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const row = getDb().prepare(`
    UPDATE action_queue
    SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
    WHERE action_id = ? AND (
      (status IN ('queued', 'retry_wait') AND next_attempt_at <= ?)
      OR (status IN ('leased', 'executing') AND lease_expires_at <= ?)
    )
    RETURNING *
  `).get(leaseOwner, expiresAt, nowIso, actionId, nowIso, nowIso);
  if (!row) return null;
  getDb().prepare(`
    UPDATE action_attempts
    SET status = 'failed', finished_at = ?, error = 'lease expired', error_class = 'retryable'
    WHERE queue_id = ? AND status = 'executing'
  `).run(nowIso, row.id);
  return rowToQueuedAction(row);
}

export function renewActionLease(queueId, { leaseOwner, leaseMs = 30_000, now = new Date() }) {
  if (!queueId || !leaseOwner) throw new TypeError('queueId and leaseOwner are required');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
  const nowDate = toDate(now);
  const expiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const result = getDb().prepare(`
    UPDATE action_queue
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('leased', 'executing') AND lease_owner = ?
  `).run(expiresAt, nowDate.toISOString(), queueId, leaseOwner);
  return result.changes === 1;
}

export function beginActionAttempt({ queueId, leaseOwner, now = new Date().toISOString() }) {
  if (!queueId || !leaseOwner) throw new TypeError('queueId and leaseOwner are required');
  return withTransaction(getDb(), () => {
    const db = getDb();
    const queue = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(queueId);
    if (!queue) throw new Error(`No such queued action: ${queueId}`);
    const nowIso = toDate(now).toISOString();
    if (queue.status !== 'leased' || queue.lease_owner !== leaseOwner || queue.lease_expires_at <= nowIso) {
      throw new Error(`Queued action ${queueId} is not leased to ${leaseOwner}`);
    }
    const attemptNumber = queue.attempt_count + 1;
    const id = newId('attempt');
    db.prepare(`
      INSERT INTO action_attempts
        (id, queue_id, attempt_number, lease_owner, status, started_at)
      VALUES (?, ?, ?, ?, 'executing', ?)
    `).run(id, queueId, attemptNumber, leaseOwner, nowIso);
    db.prepare(`
      UPDATE action_queue
      SET status = 'executing', attempt_count = ?, updated_at = ?
      WHERE id = ?
    `).run(attemptNumber, nowIso, queueId);
    return getActionAttempt(id);
  });
}

export function completeActionAttempt(id, { leaseOwner, now = new Date() }) {
  return settleAttempt(id, { leaseOwner, queueStatus: 'completed', attemptStatus: 'completed', now });
}

export function failActionAttempt(id, {
  leaseOwner,
  error,
  errorClass,
  maxAttempts = 5,
  baseDelayMs = 1_000,
  maxDelayMs = 60_000,
  now = new Date(),
}) {
  if (!ACTION_ERROR_CLASSES.includes(errorClass)) throw new TypeError(`Unknown action error class: ${errorClass}`);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  const attempt = getActionAttempt(id);
  if (!attempt) throw new Error(`No such action attempt: ${id}`);
  const retryable = errorClass === 'retryable' && attempt.attempt_number < maxAttempts;
  const exhausted = errorClass === 'retryable' && !retryable;
  const queueStatus = retryable ? 'retry_wait' : exhausted ? 'dead_letter' : 'failed';
  const nowDate = toDate(now);
  const nextAttemptAt = retryable
    ? new Date(nowDate.getTime() + retryDelayMs(attempt.attempt_number, { baseDelayMs, maxDelayMs })).toISOString()
    : nowDate.toISOString();
  return settleAttempt(id, {
    leaseOwner,
    queueStatus,
    attemptStatus: 'failed',
    error: boundedError(error),
    errorClass,
    nextAttemptAt,
    now: nowDate,
  });
}

export const ACTION_ERROR_CLASSES = Object.freeze([
  'retryable', 'non_retryable', 'authentication_required', 'owner_attention_required',
  'recovery_review_required', 'outcome_uncertain',
]);

export function retryDelayMs(attemptNumber, { baseDelayMs = 1_000, maxDelayMs = 60_000 } = {}) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new TypeError('attemptNumber must be a positive integer');
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0 || !Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
    throw new TypeError('retry delays must be positive');
  }
  return Math.min(maxDelayMs, baseDelayMs * (2 ** (attemptNumber - 1)));
}

export function getActionAttempt(id) {
  return getDb().prepare('SELECT * FROM action_attempts WHERE id = ?').get(id) || null;
}

export function listActionAttempts(queueId) {
  return getDb().prepare(
    'SELECT * FROM action_attempts WHERE queue_id = ? ORDER BY attempt_number',
  ).all(queueId);
}

function rowToQueuedAction(row) {
  if (!row) return null;
  return {
    ...row,
    arguments: JSON.parse(row.arguments || '{}'),
    actor: row.actor ? JSON.parse(row.actor) : null,
  };
}

function settleAttempt(id, {
  leaseOwner, queueStatus, attemptStatus, error = null, errorClass = null,
  nextAttemptAt = null, now = new Date(),
}) {
  if (!leaseOwner) throw new TypeError('leaseOwner is required');
  return withTransaction(getDb(), () => {
    const db = getDb();
    const attempt = db.prepare('SELECT * FROM action_attempts WHERE id = ?').get(id);
    if (!attempt) throw new Error(`No such action attempt: ${id}`);
    if (attempt.status !== 'executing' || attempt.lease_owner !== leaseOwner) {
      throw new Error(`Action attempt ${id} is not executing for ${leaseOwner}`);
    }
    const nowIso = toDate(now).toISOString();
    const update = db.prepare(`
      UPDATE action_queue
      SET status = ?, next_attempt_at = COALESCE(?, next_attempt_at),
          lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, error_class = ?, updated_at = ?
      WHERE id = ? AND status = 'executing' AND lease_owner = ?
    `).run(queueStatus, nextAttemptAt, error, errorClass, nowIso, attempt.queue_id, leaseOwner);
    if (update.changes !== 1) throw new Error(`Lease for action attempt ${id} is no longer owned by ${leaseOwner}`);
    db.prepare(`
      UPDATE action_attempts
      SET status = ?, finished_at = ?, error = ?, error_class = ?
      WHERE id = ? AND status = 'executing'
    `).run(attemptStatus, nowIso, error, errorClass, id);
    return getQueuedAction(attempt.queue_id);
  });
}

function boundedError(error) {
  const value = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return value.slice(0, 1_000);
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid queue timestamp');
  return date;
}
