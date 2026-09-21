import { getDb } from '../db/connection.js';
import { rankCandidatesHybrid } from './semantic-retrieval.js';

const DEFAULT_LIMITS = Object.freeze({ entities: 200, facts: 500, commitments: 100, events: 200 });
const STOP_WORDS = new Set(['about', 'anything', 'from', 'have', 'into', 'please', 'that', 'the', 'this', 'with', 'what']);

/**
 * Selects bounded, inspectable retrieval candidates before final context
 * assembly. This is deliberately lexical/structural: semantic similarity is
 * added by the ranking layer, while these queries guarantee that a matching
 * fact can surface its entity even when that entity was not already selected.
 */
export function selectMemoryCandidates({ objective = '', ownerEntityId = null, eventTypes = [], limits = {} } = {}) {
  const db = getDb();
  const requested = { ...DEFAULT_LIMITS, ...limits };
  const bounded = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [key, boundLimit(requested[key], fallback)]));
  const terms = significantTerms(objective).slice(0, 8);
  const entityRows = queryEntities(db, bounded.entities);
  const factRows = queryFacts(db, bounded.facts);
  const commitmentRows = ownerEntityId ? queryCommitments(db, ownerEntityId, bounded.commitments) : [];
  const eventRows = eventTypes.length ? queryEvents(db, eventTypes, bounded.events) : [];

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

export async function rankMemoryCandidates({ candidates, objective = '', embeddingProvider = null, model, semanticFilter = null } = {}) {
  const rank = (items, normalize) => rankCandidatesHybrid({ candidates: items.map(normalize), query: objective, embeddingProvider, model, semanticFilter });
  const [entities, facts, commitments, events] = await Promise.all([
    rank(candidates.entities, (item) => ({ ...item, subjectType: 'entity', text: item.retrievalText, observedAt: item.updatedAt, confidence: 1, inferred: false, entityRelevance: item.viaFactIds.length ? 1 : 0 })),
    rank(candidates.facts, (item) => ({ ...item, subjectType: 'fact', text: `${item.key || ''} ${parseText(item.value)}`, observedAt: item.observed_at, entityRelevance: 1, classification: item.classification || 'personal' })),
    rank(candidates.commitments, (item) => ({ ...item, subjectType: 'commitment', text: `${item.name || ''} ${parseText(item.attributes)}`, observedAt: item.created_at, openCommitment: true, relationshipDistance: 1, classification: item.relationship_classification || 'personal' })),
    rank(candidates.events, (item) => ({ ...item, subjectType: 'event', text: `${item.type || ''} ${parseText(item.data)}`, observedAt: item.timestamp, confidence: 0.8, inferred: false, classification: item.classification || 'personal' })),
  ]);
  return { ...candidates, entities, facts, commitments, events };
}

function queryEntities(db, limit) {
  return db.prepare("SELECT id, type, name, attributes, classification, updated_at FROM entities WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?").all(limit);
}

function queryFacts(db, limit) {
  return db.prepare("SELECT f.id, f.entity_id, f.key, f.value, f.source, f.confidence, f.inferred, f.observed_at, f.classification, e.type AS entity_type, e.name AS entity_name, e.attributes AS entity_attributes, e.classification AS entity_classification, e.updated_at FROM facts f JOIN entities e ON e.id = f.entity_id WHERE f.status = 'current' AND e.status = 'active' ORDER BY f.observed_at DESC LIMIT ?").all(limit);
}

function queryCommitments(db, ownerEntityId, limit) {
  return db.prepare("SELECT e.id, e.name, e.attributes, e.classification, e.created_at, r.id AS relationship_id, r.confidence, r.inferred, r.classification AS relationship_classification FROM relationships r JOIN entities e ON e.id = r.to_entity_id WHERE r.from_entity_id = ? AND r.relation = 'promised' AND e.status = 'active' AND json_extract(e.attributes, '$.status') = 'open' ORDER BY e.created_at DESC LIMIT ?").all(ownerEntityId, limit);
}

function queryEvents(db, eventTypes, limit) {
  const placeholders = eventTypes.map(() => '?').join(',');
  return db.prepare(`SELECT id, type, timestamp, source, subject_type, subject_id, data FROM events WHERE type IN (${placeholders}) ORDER BY timestamp DESC LIMIT ?`).all(...eventTypes, limit);
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
  const retrievalText = fields.map((field) => parseText(values[field])).join(' ');
  const existing = target.get(id);
  if (existing) {
    existing.match.exactWordMatches = Math.max(existing.match.exactWordMatches, match.exactWordMatches);
    existing.match.matchedFields = [...new Set([...existing.match.matchedFields, ...match.matchedFields])];
    existing.retrievalText = `${existing.retrievalText} ${retrievalText}`.trim();
    if (viaFactId) existing.classification = maxClassification(existing.classification, row.classification || 'personal');
    if (viaFactId && !existing.viaFactIds.includes(viaFactId)) {
      existing.viaFactIds.push(viaFactId);
      if (match.exactWordMatches) existing.matchedFactIds.push(viaFactId);
    }
    return;
  }
  target.set(id, {
    id,
    type: row.entity_type || row.type,
    name: row.entity_name || row.name,
    classification: viaFactId ? maxClassification(row.entity_classification, row.classification) : (row.entity_classification || row.classification || 'personal'),
    updatedAt: row.updated_at,
    viaFactIds: viaFactId ? [viaFactId] : [],
    matchedFactIds: viaFactId && match.exactWordMatches ? [viaFactId] : [],
    retrievalText,
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

function parseText(value) {
  if (typeof value !== 'string') return JSON.stringify(value ?? '');
  try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
}

function boundLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), 2000)) : fallback;
}

function maxClassification(a = 'personal', b = 'personal') {
  const order = ['public', 'personal', 'private', 'sensitive'];
  const rank = (value) => order.includes(value) ? order.indexOf(value) : 1;
  return order[Math.max(rank(a), rank(b))];
}
