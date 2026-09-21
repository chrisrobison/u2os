import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { MockEmbeddingProvider } from '../server/agent/embeddings/mock-embedding-provider.js';
import { setEmbedding, getEmbedding, deleteEmbedding, cosineSimilarity } from '../server/memory/embedding-store.js';
import { semanticSimilarityScores, rankFactsHybrid, rankCandidatesHybrid } from '../server/memory/semantic-retrieval.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-semantic-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- cosineSimilarity --------------------------------------------------

test('cosineSimilarity: identical vectors score 1, orthogonal vectors score 0, mismatched dimensions score 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

// --- MockEmbeddingProvider ------------------------------------------------

test('MockEmbeddingProvider: identical text always embeds to the identical vector; is clearly labeled as not real semantic understanding', async () => {
  const provider = new MockEmbeddingProvider();
  const a = await provider.embed('Sarah prefers morning meetings');
  const b = await provider.embed('Sarah prefers morning meetings');
  assert.deepEqual(a, b);
  assert.equal(provider.id, 'mock-embedding-provider');
});

test('MockEmbeddingProvider: texts sharing more words score more similar than texts sharing none', async () => {
  const provider = new MockEmbeddingProvider();
  const query = await provider.embed('Sarah prefers morning meetings');
  const related = await provider.embed('morning meetings work well for Sarah');
  const unrelated = await provider.embed('the quarterly budget spreadsheet is overdue');
  const simRelated = cosineSimilarity(query, related);
  const simUnrelated = cosineSimilarity(query, unrelated);
  assert.ok(simRelated > simUnrelated, `expected related text to score higher (${simRelated} vs ${simUnrelated})`);
});

// --- embedding-store --------------------------------------------------

test('embedding-store: setEmbedding/getEmbedding round-trip, scoped per (subjectType, subjectId, model)', () => {
  const dir = tempHome();
  try {
    getDb(); // ensure schema exists
    assert.equal(getEmbedding('fact', 'fact_1', 'modelA'), null);
    setEmbedding('fact', 'fact_1', 'modelA', [0.1, 0.2, 0.3]);
    assert.deepEqual(getEmbedding('fact', 'fact_1', 'modelA'), [0.1, 0.2, 0.3]);
    // A different model for the same subject is a distinct row.
    assert.equal(getEmbedding('fact', 'fact_1', 'modelB'), null);
    setEmbedding('fact', 'fact_1', 'modelB', [0.9, 0.9, 0.9]);
    assert.deepEqual(getEmbedding('fact', 'fact_1', 'modelA'), [0.1, 0.2, 0.3]);
    assert.deepEqual(getEmbedding('fact', 'fact_1', 'modelB'), [0.9, 0.9, 0.9]);
  } finally {
    cleanup(dir);
  }
});

test('embedding-store: setEmbedding upserts (re-embedding the same subject+model overwrites, not duplicates)', () => {
  const dir = tempHome();
  try {
    getDb();
    setEmbedding('fact', 'fact_1', 'modelA', [1, 0]);
    setEmbedding('fact', 'fact_1', 'modelA', [0, 1]);
    assert.deepEqual(getEmbedding('fact', 'fact_1', 'modelA'), [0, 1]);
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM embeddings').get().n;
    assert.equal(count, 1);
  } finally {
    cleanup(dir);
  }
});

test('embedding-store: deleteEmbedding removes only the targeted (or all) model rows for a subject', () => {
  const dir = tempHome();
  try {
    getDb();
    setEmbedding('fact', 'fact_1', 'modelA', [1, 0]);
    setEmbedding('fact', 'fact_1', 'modelB', [0, 1]);
    deleteEmbedding('fact', 'fact_1', 'modelA');
    assert.equal(getEmbedding('fact', 'fact_1', 'modelA'), null);
    assert.deepEqual(getEmbedding('fact', 'fact_1', 'modelB'), [0, 1]);
    deleteEmbedding('fact', 'fact_1');
    assert.equal(getEmbedding('fact', 'fact_1', 'modelB'), null);
  } finally {
    cleanup(dir);
  }
});

// --- semanticSimilarityScores: caching behavior ------------------------

test('semanticSimilarityScores returns an empty map when no embeddingProvider is configured -- semantic ranking is opt-in, never required', async () => {
  const scores = await semanticSimilarityScores({ query: 'anything', candidates: [{ id: 'x', subjectType: 'fact', text: 'x' }], embeddingProvider: null });
  assert.equal(scores.size, 0);
});

test('semanticSimilarityScores caches each candidate\'s embedding so re-ranking the same fact does not re-embed it', async () => {
  const dir = tempHome();
  try {
    getDb();
    let embedCalls = 0;
    const provider = new MockEmbeddingProvider();
    const wrapped = { id: 'wrapped', embed: async (text) => { embedCalls += 1; return provider.embed(text); } };
    const candidates = [{ id: 'fact_1', subjectType: 'fact', text: 'Sarah prefers morning meetings' }];

    await semanticSimilarityScores({ query: 'meetings with Sarah', candidates, embeddingProvider: wrapped, model: 'wrapped' });
    const afterFirst = embedCalls;
    await semanticSimilarityScores({ query: 'meetings with Sarah', candidates, embeddingProvider: wrapped, model: 'wrapped' });
    const afterSecond = embedCalls;

    // Second call should only re-embed the QUERY (which isn't cached -- a
    // fresh query every request), not the already-cached candidate.
    assert.equal(afterSecond, afterFirst + 1);
  } finally {
    cleanup(dir);
  }
});

// --- rankFactsHybrid --------------------------------------------------

test('rankFactsHybrid without an embeddingProvider still ranks by confidence/recency/exact-match, with semantic contributing 0', async () => {
  const dir = tempHome();
  try {
    getDb();
    const facts = [
      { id: 'f1', key: 'note', value: 'unrelated fact about weather', confidence: 0.9, inferred: false, observedAt: new Date().toISOString() },
      { id: 'f2', key: 'note', value: 'Sarah prefers morning meetings', confidence: 0.5, inferred: false, observedAt: new Date().toISOString() },
    ];
    const ranked = await rankFactsHybrid({ facts, query: 'Sarah morning meetings', embeddingProvider: null });
    assert.equal(ranked[0].id, 'f2', 'exact word overlap with the query should win even with lower confidence');
    assert.equal(ranked[0]._relevance.semantic, 0);
  } finally {
    cleanup(dir);
  }
});

test('rankFactsHybrid with an embeddingProvider blends semantic similarity in, and every result carries a score breakdown for explainability', async () => {
  const dir = tempHome();
  try {
    getDb();
    const facts = [
      { id: 'f1', key: 'note', value: 'the quarterly budget spreadsheet needs review', confidence: 0.9, inferred: false, observedAt: new Date().toISOString() },
      { id: 'f2', key: 'note', value: 'Sarah prefers morning meetings over afternoon ones', confidence: 0.9, inferred: true, observedAt: new Date().toISOString() },
    ];
    const ranked = await rankFactsHybrid({ facts, query: 'set up a morning meeting with Sarah', embeddingProvider: new MockEmbeddingProvider() });
    assert.equal(ranked[0].id, 'f2');
    for (const fact of ranked) {
      assert.ok(fact._relevance);
      assert.equal(typeof fact._relevance.semantic, 'number');
      assert.equal(typeof fact._relevance.total, 'number');
    }
    // Inferred facts carry a visible penalty signal, never a hidden one.
    assert.ok(ranked.find((f) => f.id === 'f2')._relevance.inferredPenalty > 0);
  } finally {
    cleanup(dir);
  }
});

test('rankFactsHybrid never mutates confidence/inferred/provenance fields -- ranking is additive, structured memory stays authoritative', async () => {
  const dir = tempHome();
  try {
    getDb();
    const facts = [{ id: 'f1', key: 'note', value: 'Sarah likes mornings', confidence: 0.7, inferred: true, observedAt: new Date().toISOString() }];
    const ranked = await rankFactsHybrid({ facts, query: 'Sarah', embeddingProvider: new MockEmbeddingProvider() });
    assert.equal(ranked[0].confidence, 0.7);
    assert.equal(ranked[0].inferred, true);
  } finally {
    cleanup(dir);
  }
});

test('cross-type ranking exposes every deterministic signal and explicit authority can break a tie', async () => {
  const candidates = [
    { id: 'inferred', subjectType: 'fact', text: 'same text', observedAt: null, confidence: 1, inferred: true, entityRelevance: 1, relationshipDistance: 2 },
    { id: 'explicit', subjectType: 'fact', text: 'same text', observedAt: null, confidence: 1, inferred: false, entityRelevance: 1, relationshipDistance: 2 },
  ];
  const ranked = await rankCandidatesHybrid({ candidates, query: 'unmatched', weights: { semantic: 0, exactMatch: 0, recency: 0, confidence: 0, entityRelevance: 0, relationshipProximity: 0, openCommitment: 0, currentProject: 0, interactionFrequency: 0, explicitAuthority: 1 } });
  assert.equal(ranked[0].id, 'explicit');
  for (const key of ['semantic', 'exactMatch', 'matchedWords', 'recency', 'confidence', 'explicitAuthority', 'entityRelevance', 'relationshipProximity', 'openCommitment', 'currentProject', 'interactionFrequency', 'total']) {
    assert.ok(Object.hasOwn(ranked[0]._relevance, key), `missing inspectable ${key} signal`);
  }
});

test('cross-type semantic ranking is optional and can reorder otherwise competing candidates', async () => {
  const dir = tempHome();
  try {
    const provider = {
      id: 'controlled-test-embedding',
      async embed(text) { return String(text).includes('semantic-target') || text === 'find related work' ? [1, 0] : [0, 1]; },
    };
    const candidates = [
      { id: 'unrelated', subjectType: 'entity', text: 'other material', observedAt: null, confidence: 1, inferred: false },
      { id: 'related', subjectType: 'entity', text: 'semantic-target material', observedAt: null, confidence: 1, inferred: false },
    ];
    const without = await rankCandidatesHybrid({ candidates, query: 'find related work' });
    const withSemantic = await rankCandidatesHybrid({ candidates, query: 'find related work', embeddingProvider: provider });
    assert.equal(without.every((item) => item._relevance.semantic === 0), true);
    assert.equal(withSemantic[0].id, 'related');
    assert.ok(withSemantic[0]._relevance.semantic > withSemantic[1]._relevance.semantic);
  } finally { cleanup(dir); }
});
