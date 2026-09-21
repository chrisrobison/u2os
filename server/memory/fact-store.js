import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';

const CLASSIFICATIONS = new Set(['public', 'personal', 'private', 'sensitive']);

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
  // Data-processing privacy classification (PLAN.md Phase 6), separate from
  // tool-authorization policy: public | personal | private | sensitive.
  // Defaults to 'personal' -- explicit facts a user states about their own
  // life are personal by default, never silently public or silently
  // sensitive. Callers that know a fact is more sensitive (or more
  // shareable) should say so explicitly.
  classification = 'personal',
}) {
  const db = getDb();
  const id = newId('fact');
  const now = new Date().toISOString();
  const observed = observedAt || now;
  db.prepare(
    `INSERT INTO facts (id, entity_id, key, value, source, confidence, inferred, observed_at, last_confirmed_at, provenance, classification, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, entityId, key, JSON.stringify(value), source, confidence, inferred ? 1 : 0, observed, null, JSON.stringify(provenance), classification, now);
  return getFact(id);
}

export function getFact(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
  return row ? rowToFact(row) : null;
}

export function getFacts(entityId, { includeInactive = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM facts WHERE entity_id = ? ${includeInactive ? '' : "AND status = 'current'"} ORDER BY created_at DESC`).all(entityId);
  return rows.map(rowToFact);
}

export function confirmFact(id, actor = 'owner') {
  return mutateFact(id, 'confirm', actor, (db, before, now) => {
    db.prepare('UPDATE facts SET last_confirmed_at = ? WHERE id = ?').run(now, id);
  });
}

export function reclassifyFact(id, classification, actor = 'owner') {
  if (!CLASSIFICATIONS.has(classification)) throw inputError('classification must be public, personal, private, or sensitive');
  return mutateFact(id, 'reclassify', actor, (db) => db.prepare('UPDATE facts SET classification = ? WHERE id = ?').run(classification, id));
}

export function correctFact(id, { value, key, classification, actor = 'owner' } = {}) {
  const db = getDb(); const before = getFact(id); if (!before) return null;
  if (before.status !== 'current') throw inputError(`Only current facts can be corrected`, 409);
  if (value === undefined) throw inputError('value is required');
  if (classification !== undefined && !CLASSIFICATIONS.has(classification)) throw inputError('classification must be public, personal, private, or sensitive');
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare("UPDATE facts SET status = 'superseded' WHERE id = ?").run(id);
    const replacement = recordFact({ entityId: before.entity_id, key: key || before.key, value, source: `correction:${actor}`, confidence: 1, inferred: false, observedAt: now, classification: classification || before.classification, provenance: { correctedFactId: id } });
    db.prepare('UPDATE facts SET supersedes_fact_id = ?, last_confirmed_at = ? WHERE id = ?').run(id, now, replacement.id);
    recordRevision(db, id, 'correct', before, getFact(id), actor, now);
    recordRevision(db, replacement.id, 'created_by_correction', null, getFact(replacement.id), actor, now);
    return { previous: getFact(id), fact: getFact(replacement.id) };
  });
}

export function deleteFact(id, actor = 'owner') {
  return mutateFact(id, 'delete', actor, (db, _before, now) => db.prepare("UPDATE facts SET status = 'deleted', deleted_at = ? WHERE id = ?").run(now, id));
}

export function getFactRevisions(id) {
  return getDb().prepare('SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY created_at').all(id).map((row) => ({ ...row, before: parse(row.before_state), after: parse(row.after_state) }));
}

function mutateFact(id, operation, actor, update) {
  const db = getDb(); const before = getFact(id); if (!before) return null;
  return withTransaction(db, () => { const now = new Date().toISOString(); update(db, before, now); const after = getFact(id); recordRevision(db, id, operation, before, after, actor, now); return after; });
}

function recordRevision(db, factId, operation, before, after, actor, createdAt) {
  db.prepare('INSERT INTO fact_revisions (id, fact_id, operation, before_state, after_state, actor, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(newId('frev'), factId, operation, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actor, createdAt);
}

function rowToFact(row) {
  return {
    ...row,
    value: JSON.parse(row.value),
    inferred: !!row.inferred,
    provenance: JSON.parse(row.provenance || '{}'),
  };
}

function parse(value) { return value ? JSON.parse(value) : null; }
function inputError(message, status = 400) { const error = new Error(message); error.status = status; return error; }
