import { getDb } from '../db/connection.js';

const DEFAULT_LIMITS = Object.freeze({ entities: 40, facts: 80, commitments: 30, events: 60 });
const STOP_WORDS = new Set(['about', 'anything', 'from', 'have', 'into', 'please', 'that', 'the', 'this', 'with', 'what']);

/**
 * Selects bounded, inspectable retrieval candidates before final context
 * assembly. This is deliberately lexical/structural: semantic similarity is
 * added by the ranking layer, while these queries guarantee that a matching
 * fact can surface its entity even when that entity was not already selected.
 */
export function selectMemoryCandidates({ objective = '', ownerEntityId = null, eventTypes = [], limits = {} } = {}) {
  const db = getDb();
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  const terms = significantTerms(objective).slice(0, 8);
  const entityRows = queryEntities(db, terms, bounded.entities);
  const factRows = queryFacts(db, terms, bounded.facts);
  const commitmentRows = ownerEntityId ? queryCommitments(db, ownerEntityId, terms, bounded.commitments) : [];
  const eventRows = eventTypes.length ? queryEvents(db, eventTypes, terms, bounded.events) : [];

  const entities = new Map();
  for (const row of entityRows) addEntityCandidate(entities, row, objective, ['name', 'attributes']);
  for (const row of factRows) addEntityCandidate(entities, row, objective, ['entity_name', 'fact_key', 'fact_value'], row.id);

  return {
    terms,
    entities: [...entities.values()].sort(candidateOrder).slice(0, bounded.entities),
    facts: factRows.map((row) => candidate(row, objective, ['key', 'value', 'source'])).sort(candidateOrder),
    commitments: commitmentRows.map((row) => candidate(row, objective, ['name', 'attributes'])).sort(candidateOrder),
    events: eventRows.map((row) => candidate(row, objective, ['type', 'data'])).sort(candidateOrder),
  };
}

function queryEntities(db, terms, limit) {
  const { clause, params } = likeClause(['name', 'attributes'], terms);
  return db.prepare(`SELECT id, type, name, attributes, classification, updated_at FROM entities WHERE status = 'active' ${clause} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
}

function queryFacts(db, terms, limit) {
  const { clause, params } = likeClause(['f.key', 'f.value', 'f.source', 'e.name'], terms);
  return db.prepare(`SELECT f.id, f.entity_id, f.key, f.value, f.source, f.confidence, f.inferred, f.observed_at, f.classification, e.type AS entity_type, e.name AS entity_name, e.attributes AS entity_attributes, e.classification AS entity_classification, e.updated_at FROM facts f JOIN entities e ON e.id = f.entity_id WHERE f.status = 'current' AND e.status = 'active' ${clause} ORDER BY f.observed_at DESC LIMIT ?`).all(...params, limit);
}

function queryCommitments(db, ownerEntityId, terms, limit) {
  const { clause, params } = likeClause(['e.name', 'e.attributes'], terms);
  return db.prepare(`SELECT e.id, e.name, e.attributes, e.classification, e.created_at, r.id AS relationship_id, r.confidence, r.inferred, r.classification AS relationship_classification FROM relationships r JOIN entities e ON e.id = r.to_entity_id WHERE r.from_entity_id = ? AND r.relation = 'promised' AND e.status = 'active' AND json_extract(e.attributes, '$.status') = 'open' ${clause} ORDER BY e.created_at DESC LIMIT ?`).all(ownerEntityId, ...params, limit);
}

function queryEvents(db, eventTypes, terms, limit) {
  const placeholders = eventTypes.map(() => '?').join(',');
  const { clause, params } = likeClause(['type', 'data'], terms);
  return db.prepare(`SELECT id, type, timestamp, source, subject_type, subject_id, data FROM events WHERE type IN (${placeholders}) ${clause} ORDER BY timestamp DESC LIMIT ?`).all(...eventTypes, ...params, limit);
}

function likeClause(columns, terms) {
  if (!terms.length) return { clause: '', params: [] };
  const groups = [];
  const params = [];
  for (const term of terms) {
    groups.push(`(${columns.map((column) => `${column} LIKE ?`).join(' OR ')})`);
    for (const _column of columns) params.push(`%${term}%`);
  }
  return { clause: `AND (${groups.join(' OR ')})`, params };
}

function addEntityCandidate(target, row, objective, fields, viaFactId = null) {
  const id = row.entity_id || row.id;
  const values = {
    name: row.name,
    attributes: row.attributes,
    entity_name: row.entity_name,
    fact_key: row.key,
    fact_value: row.value,
  };
  const match = matchDetails(objective, values, fields);
  const existing = target.get(id);
  if (existing) {
    existing.match.exactWordMatches = Math.max(existing.match.exactWordMatches, match.exactWordMatches);
    existing.match.matchedFields = [...new Set([...existing.match.matchedFields, ...match.matchedFields])];
    if (viaFactId && !existing.viaFactIds.includes(viaFactId)) existing.viaFactIds.push(viaFactId);
    return;
  }
  target.set(id, {
    id,
    type: row.entity_type || row.type,
    name: row.entity_name || row.name,
    classification: row.entity_classification || row.classification || 'personal',
    updatedAt: row.updated_at,
    viaFactIds: viaFactId ? [viaFactId] : [],
    match,
  });
}

function candidate(row, objective, fields) {
  return { ...row, match: matchDetails(objective, row, fields) };
}

function matchDetails(objective, values, fields) {
  const query = new Set(significantTerms(objective));
  const matchedFields = [];
  const matchedWords = new Set();
  for (const field of fields) {
    const words = new Set(significantTerms(values[field]));
    const overlaps = [...query].filter((word) => words.has(word));
    if (overlaps.length) matchedFields.push(field);
    for (const word of overlaps) matchedWords.add(word);
  }
  return { exactWordMatches: matchedWords.size, matchedFields };
}

function candidateOrder(a, b) {
  return b.match.exactWordMatches - a.match.exactWordMatches || String(b.updatedAt || b.observed_at || b.timestamp || b.created_at || '').localeCompare(String(a.updatedAt || a.observed_at || a.timestamp || a.created_at || ''));
}

function significantTerms(value) {
  return String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}
