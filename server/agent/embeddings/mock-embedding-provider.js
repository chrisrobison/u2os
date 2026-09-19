import { EmbeddingProvider } from './embedding-provider.js';

const DIM = 64;

/**
 * MOCK / DETERMINISTIC embedding provider -- NOT a real semantic model,
 * same honesty rule as MockModelProvider (docs/architecture.md). It hashes
 * words into a fixed-size vector (a crude bag-of-words sketch): two texts
 * that share more words score more similar, and the same text always
 * produces the same vector. That's enough to prove the retrieval plumbing
 * (storage, cosine similarity, hybrid ranking) end to end without a real
 * embedding model, network access, or a paid API -- it is NOT a claim of
 * real semantic understanding (it cannot tell "car" and "automobile" are
 * related, for example). This is the offline default for the `embeddings`
 * role.
 */
export class MockEmbeddingProvider extends EmbeddingProvider {
  id = 'mock-embedding-provider';

  async embed(text) {
    const vector = new Array(DIM).fill(0);
    const words = String(text || '')
      .toLowerCase()
      .split(/\W+/)
      .filter(Boolean);
    for (const word of words) {
      vector[hashString(word) % DIM] += 1;
    }
    return normalize(vector);
  }
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}
