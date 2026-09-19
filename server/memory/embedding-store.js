// Semantic memory retrieval (PLAN.md Phase 5): a small index/access
// mechanism OVER the existing structured memory (entities/facts/
// relationships remain authoritative), not a vector database. Personal-
// scale datasets make application-side cosine similarity over vectors
// stored as plain JSON in SQLite entirely sufficient -- see
// docs/architecture.md.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

/** Upserts the embedding for (subjectType, subjectId, model). */
export function setEmbedding(subjectType, subjectId, model, vector) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = newId('emb');
  db.prepare(
    `INSERT INTO embeddings (id, subject_type, subject_id, model, vector, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(subject_type, subject_id, model)
     DO UPDATE SET vector = excluded.vector, created_at = excluded.created_at`
  ).run(id, subjectType, subjectId, model, JSON.stringify(vector), now);
}

/** Returns the stored vector for (subjectType, subjectId, model), or null if not embedded yet. */
export function getEmbedding(subjectType, subjectId, model) {
  const db = getDb();
  const row = db.prepare('SELECT vector FROM embeddings WHERE subject_type = ? AND subject_id = ? AND model = ?').get(subjectType, subjectId, model);
  return row ? JSON.parse(row.vector) : null;
}

/** Deletes the embedding(s) for a subject -- pass `model` to scope to one model, omit to delete all. */
export function deleteEmbedding(subjectType, subjectId, model = null) {
  const db = getDb();
  if (model) {
    db.prepare('DELETE FROM embeddings WHERE subject_type = ? AND subject_id = ? AND model = ?').run(subjectType, subjectId, model);
  } else {
    db.prepare('DELETE FROM embeddings WHERE subject_type = ? AND subject_id = ?').run(subjectType, subjectId);
  }
}

/**
 * Cosine similarity in plain JS -- personal-scale datasets (dozens to a few
 * thousand facts/entities) never need more than this; see PLAN.md's
 * explicit "do not introduce a separate vector database unless measurements
 * show a real need." Returns 0 for mismatched dimensions or zero vectors
 * rather than throwing, since a caller ranking many candidates shouldn't
 * have one malformed vector abort the whole ranking.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
