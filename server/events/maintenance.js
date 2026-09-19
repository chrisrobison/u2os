import { getDb } from '../db/connection.js';
import { EventBus } from './event-bus.js';

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
