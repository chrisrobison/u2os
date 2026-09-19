import { EmbeddingProvider } from './embedding-provider.js';

/**
 * Real embedding provider using the common OpenAI-compatible
 * `POST <baseUrl>/v1/embeddings` shape -- the same family of endpoint the
 * planning OpenAICompatibleProvider targets (hosted OpenAI-compatible
 * APIs, Ollama, llama.cpp servers, LM Studio, ...), so an owner who
 * already runs one of those for planning can often point the `embeddings`
 * role at the same server with a different model name.
 */
export class OpenAICompatibleEmbeddingProvider extends EmbeddingProvider {
  constructor({ baseUrl, model, apiKey = null, timeoutMs = 30000, fetchImpl = fetch }) {
    super();
    if (!baseUrl || !model) throw new Error('OpenAI-compatible embedding provider requires baseUrl and model');
    this.id = `embedding-openai-compatible:${model}`;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async embed(text) {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!response.ok) throw new Error(`Embedding provider unavailable (HTTP ${response.status})`);
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) throw new Error('Embedding provider returned no data');
      return payload.data.map((entry) => entry.embedding);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Embedding provider timed out');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
