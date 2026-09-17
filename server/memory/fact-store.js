import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

/**
 * Records a fact with full provenance. A fact is never silently promoted
 * from inference to stated truth -- `inferred` and `confidence` travel with
 * it permanently (PROMPT.md principle #6).
 */
export function recordFact({
  entityId,
  key,
  value,
  source,
  confidence = 1.0,
  inferred = false,
  observedAt,
  provenance = {},
}) {
  const db = getDb();
  const id = newId('fact');
  const now = new Date().toISOString();
  const observed = observedAt || now;
  db.prepare(
    `INSERT INTO facts (id, entity_id, key, value, source, confidence, inferred, observed_at, last_confirmed_at, provenance, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, entityId, key, JSON.stringify(value), source, confidence, inferred ? 1 : 0, observed, null, JSON.stringify(provenance), now);
  return getFact(id);
}

export function getFact(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
  return row ? rowToFact(row) : null;
}

export function getFacts(entityId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM facts WHERE entity_id = ? ORDER BY created_at DESC').all(entityId);
  return rows.map(rowToFact);
}

export function deleteFact(id) {
  const db = getDb();
  db.prepare('DELETE FROM facts WHERE id = ?').run(id);
}

function rowToFact(row) {
  return {
    ...row,
    value: JSON.parse(row.value),
    inferred: !!row.inferred,
    provenance: JSON.parse(row.provenance || '{}'),
  };
}
