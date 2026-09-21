// Hybrid ranking over structured memory (PLAN.md Phase 5). Structured
// entities/facts/relationships remain authoritative; this module adds
// semantic similarity as ONE additional ranking signal, combined with
// recency, confidence, explicit-vs-inferred status, and exact-word overlap
// -- a purely vector-similarity result is explicitly called out in PLAN.md
// as insufficient on its own. Every result keeps the ids it was derived
// from so a caller can explain "why was this included."
import { getEmbedding, setEmbedding, cosineSimilarity } from './embedding-store.js';

const DEFAULT_WEIGHTS = {
  semantic: 0.45,
  recency: 0.2,
  confidence: 0.2,
  exactMatch: 0.15,
  inferredPenalty: 0.05,
};

const CANDIDATE_WEIGHTS = Object.freeze({
  semantic: 0.3,
  exactMatch: 0.18,
  recency: 0.12,
  confidence: 0.12,
  explicitAuthority: 0.08,
  entityRelevance: 0.08,
  relationshipProximity: 0.04,
  openCommitment: 0.05,
  currentProject: 0.02,
  interactionFrequency: 0.01,
});

/**
 * Computes a semantic-similarity score (roughly 0..1, cosine similarity can
 * stray slightly outside that range) between `query` and each candidate's
 * `text`, embedding + caching each candidate's vector by
 * (candidate.subjectType, candidate.id, model) so repeated retrieval over
 * the same facts doesn't re-embed them every time. Returns a
 * Map<candidateId, similarity>; empty if no embeddingProvider is
 * configured (semantic ranking is opt-in, never required).
 */
export async function semanticSimilarityScores({ query, candidates, embeddingProvider, model, candidateFilter = null }) {
  const scores = new Map();
  const eligible = candidateFilter ? candidates.filter(candidateFilter) : candidates;
  if (!embeddingProvider || !query || !eligible?.length) return scores;

  const resolvedModel = model || embeddingProvider.id || 'default';
  const queryVector = await embeddingProvider.embed(query);

  for (const candidate of eligible) {
    let vector = getEmbedding(candidate.subjectType, candidate.id, resolvedModel);
    if (!vector) {
      vector = await embeddingProvider.embed(candidate.text);
      setEmbedding(candidate.subjectType, candidate.id, resolvedModel, vector);
    }
    scores.set(candidate.id, cosineSimilarity(queryVector, vector));
  }
  return scores;
}

/**
 * Ranks facts (each `{ id, subjectType: 'fact', text, confidence, inferred,
 * observedAt }`) against `query` by a hybrid score combining:
 *   - semantic similarity (0 if no embeddingProvider configured)
 *   - recency (more recent observedAt scores higher)
 *   - confidence (as recorded on the fact)
 *   - exact/near-exact word overlap with the query (a cheap, always-on
 *     signal independent of whether embeddings are configured -- catches
 *     literal name/keyword matches a crude mock embedding might miss)
 *   - an inferred-fact penalty (explicit facts rank slightly ahead of
 *     inferred ones, all else equal -- never hidden, always visible via
 *     `inferred` on the returned item)
 *
 * Returns the input facts annotated with `_relevance` (the score breakdown,
 * for explainability) and sorted by total score descending. This is async
 * only because semantic scoring may call an embedding provider; with no
 * embeddingProvider configured it still returns synchronously-equivalent
 * results (semantic weight simply contributes 0 to every item).
 */
export async function rankFactsHybrid({ facts, query, embeddingProvider, model, weights = {}, semanticFilter = null } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const candidates = facts.map((f) => ({ id: f.id, subjectType: 'fact', text: factText(f) }));
  const semanticScores = await semanticSimilarityScores({ query, candidates, embeddingProvider, model, candidateFilter: semanticFilter ? (candidate) => semanticFilter(facts.find((fact) => fact.id === candidate.id)) : null });

  const now = Date.now();
  const queryWords = wordsOf(query);

  return facts
    .map((fact) => {
      const semantic = semanticScores.get(fact.id) || 0;
      const recency = recencyScore(fact.observedAt, now);
      const confidence = clamp01(fact.confidence ?? 1);
      const exactMatch = queryWords.some((word) => wordsOf(factText(fact)).includes(word)) ? 1 : 0;
      const inferredPenalty = fact.inferred ? 1 : 0;

      const total = semantic * w.semantic + recency * w.recency + confidence * w.confidence + exactMatch * w.exactMatch - inferredPenalty * w.inferredPenalty;

      return { ...fact, _relevance: { semantic, recency, confidence, exactMatch, inferredPenalty, total } };
    })
    .sort((a, b) => b._relevance.total - a._relevance.total);
}

/**
 * Generic cross-type ranking. Callers provide normalized candidates while
 * structured stores remain authoritative. Every signal is returned in the
 * `_relevance` breakdown; there is no opaque rank or model-decided trust.
 */
export async function rankCandidatesHybrid({ candidates = [], query = '', embeddingProvider = null, model, weights = {}, semanticFilter = null } = {}) {
  const w = { ...CANDIDATE_WEIGHTS, ...weights };
  const semanticScores = await semanticSimilarityScores({ query, candidates, embeddingProvider, model, candidateFilter: semanticFilter });
  const queryWords = wordsOf(query);
  const now = Date.now();

  return candidates.map((item) => {
    const textWords = new Set(wordsOf(item.text));
    const matchedWords = [...new Set(queryWords)].filter((word) => textWords.has(word));
    const semantic = semanticScores.get(item.id) || 0;
    const exactMatch = Math.min(1, matchedWords.length / Math.max(1, Math.min(3, new Set(queryWords).size)));
    const recency = recencyScore(item.observedAt, now);
    const confidence = clamp01(item.confidence ?? 1);
    const explicitAuthority = item.inferred ? 0 : 1;
    const entityRelevance = clamp01(item.entityRelevance || 0);
    const relationshipProximity = item.relationshipDistance == null ? 0 : 1 / (1 + Math.max(0, item.relationshipDistance));
    const openCommitment = item.openCommitment ? 1 : 0;
    const currentProject = item.currentProject ? 1 : 0;
    const interactionFrequency = clamp01(item.interactionFrequency || 0);
    const total = semantic * w.semantic + exactMatch * w.exactMatch + recency * w.recency + confidence * w.confidence + explicitAuthority * w.explicitAuthority + entityRelevance * w.entityRelevance + relationshipProximity * w.relationshipProximity + openCommitment * w.openCommitment + currentProject * w.currentProject + interactionFrequency * w.interactionFrequency;
    return {
      ...item,
      _relevance: { semantic, exactMatch, matchedWords, recency, confidence, explicitAuthority, entityRelevance, relationshipProximity, openCommitment, currentProject, interactionFrequency, total },
    };
  }).sort((a, b) => b._relevance.total - a._relevance.total || String(a.id).localeCompare(String(b.id)));
}

function factText(fact) {
  const value = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value ?? '');
  return `${fact.key || ''} ${value}`.trim();
}

function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
}

function recencyScore(isoTimestamp, nowMs) {
  if (!isoTimestamp) return 0;
  const ageDays = Math.max(0, (nowMs - new Date(isoTimestamp).getTime()) / 86_400_000);
  return 1 / (1 + ageDays); // 1.0 same day, ~0.5 at 1 day, decaying toward 0
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
