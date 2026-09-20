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
  now = new Date().toISOString(),
}) {
  if (!actionId || !tool) throw new TypeError('actionId and tool are required');
  const key = idempotencyKey || actionIdempotencyKey({ tool, correlationId, actionId });
  const db = getDb();
  db.prepare(`
    INSERT INTO action_queue (
      id, action_id, correlation_id, tool, arguments, idempotency_key,
      status, attempt_count, next_attempt_at, approval_reference,
      policy_decision_reference, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
    ON CONFLICT(action_id) DO NOTHING
  `).run(
    newId('queue'), actionId, correlationId, tool, JSON.stringify(args), key,
    now, approvalReference, policyDecisionReference, now, now,
  );
  return getQueuedActionByActionId(actionId);
}

export function getQueuedAction(id) {
  return rowToQueuedAction(getDb().prepare('SELECT * FROM action_queue WHERE id = ?').get(id));
}

export function getQueuedActionByActionId(actionId) {
  return rowToQueuedAction(getDb().prepare('SELECT * FROM action_queue WHERE action_id = ?').get(actionId));
}

export function listQueuedActions({ status } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM action_queue WHERE status = ? ORDER BY created_at').all(status)
    : db.prepare('SELECT * FROM action_queue ORDER BY created_at').all();
  return rows.map(rowToQueuedAction);
}

export function beginActionAttempt({ queueId, leaseOwner, now = new Date().toISOString() }) {
  if (!queueId || !leaseOwner) throw new TypeError('queueId and leaseOwner are required');
  return withTransaction(getDb(), () => {
    const db = getDb();
    const queue = db.prepare('SELECT * FROM action_queue WHERE id = ?').get(queueId);
    if (!queue) throw new Error(`No such queued action: ${queueId}`);
    const attemptNumber = queue.attempt_count + 1;
    const id = newId('attempt');
    db.prepare(`
      INSERT INTO action_attempts
        (id, queue_id, attempt_number, lease_owner, status, started_at)
      VALUES (?, ?, ?, ?, 'executing', ?)
    `).run(id, queueId, attemptNumber, leaseOwner, now);
    db.prepare(`
      UPDATE action_queue
      SET status = 'executing', attempt_count = ?, updated_at = ?
      WHERE id = ?
    `).run(attemptNumber, now, queueId);
    return getActionAttempt(id);
  });
}

export function finishActionAttempt(id, { status, error = null, errorClass = null, now = new Date().toISOString() }) {
  if (!['completed', 'failed'].includes(status)) throw new TypeError('attempt status must be completed or failed');
  const db = getDb();
  db.prepare(`
    UPDATE action_attempts
    SET status = ?, finished_at = ?, error = ?, error_class = ?
    WHERE id = ? AND status = 'executing'
  `).run(status, now, error, errorClass, id);
  return getActionAttempt(id);
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
  return { ...row, arguments: JSON.parse(row.arguments || '{}') };
}
