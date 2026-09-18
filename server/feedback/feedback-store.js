// Phase 7 / docs/feedback.md: storage for feedback_events. Feedback is data
// like everything else in U2OS -- every row written here is also published
// as a `user.feedback` event on the normal event bus (a reserved type per
// docs/events.md), never a side channel.
//
// HARD CONSTRAINT (stated explicitly in docs/feedback.md and PROMPT.md):
// this module NEVER writes to policies.yaml, NEVER changes an autonomy
// level, and NEVER constructs or touches a PolicyEngine. It only ever
// records rows in feedback_events for server/feedback/prioritizer.js to read
// back for *prioritization* -- what gets surfaced, how urgently, in what
// order. Nothing in this file imports server/policy/policy-engine.js.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

export const VALID_SUBJECT_TYPES = ['agent_action', 'recommendation', 'dashboard_card', 'notification'];
export const VALID_OUTCOMES = ['accepted', 'rejected', 'edited', 'ignored', 'postponed', 'dismissed', 'marked_useful'];

/**
 * recordFeedback({ subjectType, subjectId, outcome, detail, correlationId, eventBus, actor })
 * Validates and inserts one feedback_events row, then (best-effort, never
 * blocking the write) publishes it as `user.feedback` on the event bus if
 * one was passed in.
 */
export function recordFeedback({
  subjectType,
  subjectId,
  outcome,
  detail = {},
  correlationId = null,
  eventBus = null,
  actor = null,
} = {}) {
  if (!VALID_SUBJECT_TYPES.includes(subjectType)) {
    throw new Error(`Invalid subjectType "${subjectType}" -- must be one of ${VALID_SUBJECT_TYPES.join(', ')}`);
  }
  if (!subjectId) {
    throw new Error('subjectId is required');
  }
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid outcome "${outcome}" -- must be one of ${VALID_OUTCOMES.join(', ')}`);
  }

  const db = getDb();
  const id = newId('fb');
  const now = new Date().toISOString();
  const detailJson = JSON.stringify(detail ?? {});

  db.prepare(
    `INSERT INTO feedback_events (id, subject_type, subject_id, outcome, detail, correlation_id, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, subjectType, subjectId, outcome, detailJson, correlationId, now);

  const row = getFeedbackEvent(id);

  if (eventBus) {
    try {
      eventBus.publish({
        type: 'user.feedback',
        source: 'feedback',
        actor: actor || { type: 'user', id: 'user' },
        subject: { type: subjectType, id: subjectId },
        data: { outcome, detail: detail ?? {} },
        metadata: { correlationId, provenance: 'feedback:record' },
      });
    } catch (err) {
      // Publishing is a best-effort side channel to the activity feed; a
      // failure here must never lose the feedback row that was already
      // durably written above.
      console.error('[feedback] failed to publish user.feedback event', err);
    }
  }

  return row;
}

export function getFeedbackEvent(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM feedback_events WHERE id = ?').get(id);
  return row ? rowToFeedback(row) : null;
}

/** listFeedback({ subjectType, subjectId, limit }) -- filterable, newest first. */
export function listFeedback({ subjectType, subjectId, limit = 100 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (subjectType) {
    clauses.push('subject_type = ?');
    params.push(subjectType);
  }
  if (subjectId) {
    clauses.push('subject_id = ?');
    params.push(subjectId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM feedback_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit);
  return rows.map(rowToFeedback);
}

function rowToFeedback(row) {
  let detail = {};
  try {
    detail = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    detail = {};
  }
  return { ...row, detail };
}
