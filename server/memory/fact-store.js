import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';

const CLASSIFICATIONS = new Set(['public', 'personal', 'private', 'sensitive']);
const EXPLICIT_SOURCES = new Set(['owner', 'user', 'memory-candidate-confirmation']);
const EXPLICIT_SOURCE_PREFIXES = ['user:', 'correction:'];
const DERIVED_SOURCE_PREFIXES = ['system:projector', 'projector:', 'agent:commitment_detection'];

export function classifyFactOrigin({ source = '', inferred = false } = {}) {
  const normalized = String(source).toLowerCase();
  if (EXPLICIT_SOURCES.has(normalized) || EXPLICIT_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'explicit';
  if (inferred && DERIVED_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'derived';
  return inferred ? 'inferred' : 'imported';
}

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
  const write = () => {
    const current = db.prepare("SELECT * FROM facts WHERE entity_id = ? AND key = ? AND status = 'current' ORDER BY created_at DESC").all(entityId, key).map(rowToFact);
    const encodedValue = JSON.stringify(value);
    let status = 'current';
    if (current.length) {
      const sameValue = current.every((fact) => JSON.stringify(fact.value) === encodedValue);
      const hasExplicit = current.some((fact) => !fact.inferred);
      if (inferred && hasExplicit) {
        // A weaker observation cannot replace owner-stated knowledge, even
        // when it merely repeats the same value.
        status = sameValue ? 'superseded' : 'disputed';
      } else if (sameValue || (!inferred && current.every((fact) => fact.inferred))) {
        db.prepare("UPDATE facts SET status = 'superseded' WHERE entity_id = ? AND key = ? AND status = 'current'").run(entityId, key);
      } else {
        db.prepare("UPDATE facts SET status = 'disputed' WHERE entity_id = ? AND key = ? AND status = 'current'").run(entityId, key);
        status = 'disputed';
      }
    }
    db.prepare(
      `INSERT INTO facts (id, entity_id, key, value, source, confidence, inferred, observed_at, last_confirmed_at, provenance, classification, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, entityId, key, encodedValue, source, confidence, inferred ? 1 : 0, observed, null, JSON.stringify(provenance), classification, status, now);
    return getFact(id);
  };
  // correctFact already owns a transaction. Standalone observations need
  // the status transition and insert to commit or roll back together.
  return db.isTransaction ? write() : withTransaction(db, write);
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
    origin: classifyFactOrigin(row),
    provenance: JSON.parse(row.provenance || '{}'),
  };
}

function parse(value) { return value ? JSON.parse(value) : null; }
function inputError(message, status = 400) { const error = new Error(message); error.status = status; return error; }
