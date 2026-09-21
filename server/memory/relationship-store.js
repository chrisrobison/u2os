import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

export function recordRelationship({
  fromEntityId,
  relation,
  toEntityId = null,
  attributes = {},
  source,
  confidence = 1.0,
  inferred = false,
  observedAt,
}) {
  const db = getDb();
  const id = newId('rel');
  const now = new Date().toISOString();
  const observed = observedAt || now;
  db.prepare(
    `INSERT INTO relationships (id, from_entity_id, relation, to_entity_id, attributes, source, confidence, inferred, observed_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, fromEntityId, relation, toEntityId, JSON.stringify(attributes), source, confidence, inferred ? 1 : 0, observed, now);
  return getRelationship(id);
}

export function getRelationship(id, { includeDeleted = false } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM relationships WHERE id = ?').get(id);
  if (!row || (!includeDeleted && row.status === 'deleted')) return null;
  return rowToRelationship(row);
}

export function getRelationships(entityId) {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM relationships r
      WHERE r.status != 'deleted'
        AND (r.from_entity_id = ? OR r.to_entity_id = ?)
        AND EXISTS (SELECT 1 FROM entities e WHERE e.id = r.from_entity_id AND COALESCE(e.status, 'active') != 'deleted')
        AND (r.to_entity_id IS NULL OR EXISTS (SELECT 1 FROM entities e WHERE e.id = r.to_entity_id AND COALESCE(e.status, 'active') != 'deleted'))
      ORDER BY r.created_at DESC`)
    .all(entityId, entityId);
  return rows.map(rowToRelationship);
}

export function deleteRelationship(id) {
  const existing = getRelationship(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  getDb().prepare("UPDATE relationships SET status = 'deleted', deleted_at = ? WHERE id = ? AND status != 'deleted'").run(now, id);
  return getRelationship(id, { includeDeleted: true });
}

function rowToRelationship(row) {
  return { ...row, attributes: JSON.parse(row.attributes || '{}'), inferred: !!row.inferred };
}
