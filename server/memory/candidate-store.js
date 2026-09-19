import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { recordFact } from './fact-store.js';

export function proposeMemoryCandidate({ content, confidence, correlationId, proposedBy }) {
  const db = getDb(); const id = newId('memc'); const now = new Date().toISOString();
  db.prepare(`INSERT INTO memory_candidates
    (id, content, confidence, status, correlation_id, proposed_by, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, content, confidence || null, correlationId || null, proposedBy || null, now, now);
  return getMemoryCandidate(id);
}

export function getMemoryCandidate(id) {
  return getDb().prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) || null;
}

export function listMemoryCandidates({ status = 'pending', limit = 100 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 100, 500));
  return status
    ? getDb().prepare('SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, bounded)
    : getDb().prepare('SELECT * FROM memory_candidates ORDER BY created_at DESC LIMIT ?').all(bounded);
}

export function acceptMemoryCandidate(id, { entityId, key, value, classification = 'personal', resolvedBy }) {
  const db = getDb(); const candidate = getMemoryCandidate(id);
  if (!candidate) return null;
  if (candidate.status !== 'pending') throw statusError(`Memory candidate is already ${candidate.status}`);
  if (!entityId || !key) throw statusError('entityId and key are required', 400);
  return withTransaction(db, () => {
    const fact = recordFact({ entityId, key, value: value ?? candidate.content, source: 'memory-candidate-confirmation', confidence: confidenceNumber(candidate.confidence), inferred: false, classification, provenance: { memoryCandidateId: id, correlationId: candidate.correlation_id } });
    const now = new Date().toISOString();
    db.prepare(`UPDATE memory_candidates SET status='accepted', resolved_by=?, resolved_at=?, promoted_fact_id=?, updated_at=? WHERE id=?`)
      .run(resolvedBy, now, fact.id, now, id);
    return { candidate: getMemoryCandidate(id), fact };
  });
}

export function rejectMemoryCandidate(id, resolvedBy) {
  const candidate = getMemoryCandidate(id);
  if (!candidate) return null;
  if (candidate.status !== 'pending') throw statusError(`Memory candidate is already ${candidate.status}`);
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE memory_candidates SET status='rejected', resolved_by=?, resolved_at=?, updated_at=? WHERE id=?`).run(resolvedBy, now, now, id);
  return getMemoryCandidate(id);
}

function confidenceNumber(value) { return value === 'high' ? 0.95 : value === 'medium' ? 0.75 : 0.55; }
function statusError(message, status = 409) { const error = new Error(message); error.status = status; return error; }
