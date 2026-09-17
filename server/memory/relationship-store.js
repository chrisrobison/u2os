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

export function getRelationship(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM relationships WHERE id = ?').get(id);
  return row ? rowToRelationship(row) : null;
}

export function getRelationships(entityId) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM relationships WHERE from_entity_id = ? OR to_entity_id = ? ORDER BY created_at DESC')
    .all(entityId, entityId);
  return rows.map(rowToRelationship);
}

function rowToRelationship(row) {
  return { ...row, attributes: JSON.parse(row.attributes || '{}'), inferred: !!row.inferred };
}
