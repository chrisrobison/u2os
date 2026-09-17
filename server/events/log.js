/**
 * listEvents reads directly from the events table -- there is no separate
 * "history" store to keep in sync, per docs/events.md ("Replay").
 *
 * Ordering choice: when `since` is not given, callers want a recent-activity
 * view (dashboard/activity feed), so results are newest-first. When `since`
 * IS given, the caller is almost certainly paginating/polling forward from a
 * known point in the log, so results are returned oldest-first starting just
 * after `since` -- that reads naturally as "what happened next" and lets a
 * client keep advancing `since` to the last id/timestamp it saw.
 */
export function listEvents(db, { type, since, correlationId, limit = 100 } = {}) {
  const clauses = [];
  const params = [];

  if (type) {
    if (type.endsWith('.*')) {
      clauses.push('type LIKE ?');
      params.push(`${type.slice(0, -1)}%`);
    } else {
      clauses.push('type = ?');
      params.push(type);
    }
  }

  if (correlationId) {
    clauses.push('correlation_id = ?');
    params.push(correlationId);
  }

  let order = 'timestamp DESC, id DESC';
  if (since) {
    clauses.push('timestamp > ?');
    params.push(since);
    order = 'timestamp ASC, id ASC';
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM events ${where} ORDER BY ${order} LIMIT ?`;
  params.push(Number(limit) || 100);

  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToEvent);
}

function rowToEvent(row) {
  return {
    id: row.id,
    type: row.type,
    timestamp: row.timestamp,
    source: row.source,
    actor: row.actor_type ? { type: row.actor_type, id: row.actor_id } : null,
    subject: row.subject_type ? { type: row.subject_type, id: row.subject_id } : null,
    data: JSON.parse(row.data || '{}'),
    metadata: JSON.parse(row.metadata || '{}'),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    createdAt: row.created_at,
  };
}
