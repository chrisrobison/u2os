import { getDb, withTransaction } from '../db/connection.js';
import { EventBus } from './event-bus.js';
import { applyCalendarEventProjection, projectCalendarEventChanged } from '../memory/projector.js';

const REPLAY_PROJECTORS = new Map([
  ['calendar.event_changed', {
    project: projectCalendarEventChanged,
    apply: applyCalendarEventProjection,
    clear(db) {
      return db.prepare("DELETE FROM facts WHERE source = 'system:projector' AND key = 'last_meeting_change'").run().changes;
    },
  }],
]);

export function checkEventLogIntegrity(db = getDb()) {
  const quickCheck = db.prepare('PRAGMA quick_check').get();
  const malformed = db.prepare(`SELECT count(*) AS count FROM events
    WHERE id IS NULL OR type IS NULL OR timestamp IS NULL OR source IS NULL`).get().count;
  const duplicateIds = db.prepare('SELECT count(*) AS count FROM (SELECT id FROM events GROUP BY id HAVING count(*) > 1)').get().count;
  return { ok: quickCheck.quick_check === 'ok' && malformed === 0 && duplicateIds === 0, sqlite: quickCheck.quick_check, malformed, duplicateIds, eventCount: db.prepare('SELECT count(*) AS count FROM events').get().count };
}

export function pruneEvents({ retentionDays, apply = false, db = getDb() } = {}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 1) throw new Error('retentionDays must be at least 1');
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const eligible = db.prepare('SELECT count(*) AS count FROM events WHERE timestamp < ?').get(cutoff).count;
  if (!apply) return { applied: false, cutoff, eligible };
  const bus = new EventBus(db);
  bus.publish({ type: 'system.event_retention_applied', source: 'maintenance', data: { cutoff, eligible, retentionDays: days }, metadata: { provenance: 'cli:event-maintenance' } });
  const removed = db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff).changes;
  return { applied: true, cutoff, eligible, removed };
}

export function replayDerivedProjections({ apply = false, db = getDb() } = {}) {
  const types = [...REPLAY_PROJECTORS.keys()];
  const events = db.prepare(`SELECT * FROM events WHERE type IN (${types.map(() => '?').join(',')})
    ORDER BY rowid`).all(...types).map(rowToEvent);
  const projected = events.flatMap((event) => REPLAY_PROJECTORS.get(event.type).project(event));
  const result = {
    applied: false,
    eventCount: events.length,
    projectionCount: projected.length,
    eventTypes: Object.fromEntries(types.map((type) => [type, events.filter((event) => event.type === type).length])),
  };
  if (!apply) return result;

  return withTransaction(db, () => {
    let removed = 0;
    for (const projector of REPLAY_PROJECTORS.values()) removed += projector.clear(db);
    for (const event of events) REPLAY_PROJECTORS.get(event.type).apply(event);
    new EventBus(db).publish({
      type: 'system.projections_replayed',
      source: 'maintenance',
      data: { eventCount: events.length, projectionCount: projected.length, removed },
      metadata: { provenance: 'cli:event-maintenance' },
    });
    return { ...result, applied: true, removed };
  });
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
