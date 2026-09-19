/**
 * Provider-agnostic interface for turning text into a fixed-length numeric
 * vector for semantic-similarity ranking (PLAN.md Phase 5). Deliberately
 * separate from ModelProvider (plan/respond/summarize/...): an embedding
 * model is a different capability with a different interface.
 * ModelRouter.resolve('embeddings') can return either kind of provider --
 * it just instantiates whatever `type` a role's provider config declares
 * and hands it back; it doesn't care which interface the result exposes.
 */
export class EmbeddingProvider {
  id = 'embedding-provider';

  /** @returns {Promise<number[]>} */
  async embed(_text) {
    throw new Error('embed() not implemented');
  }

  /** Default batch implementation: sequential embed() calls. Real providers
   * that support a batched API should override this for efficiency. */
  async embedBatch(texts) {
    const vectors = [];
    for (const text of texts) vectors.push(await this.embed(text));
    return vectors;
  }
}
