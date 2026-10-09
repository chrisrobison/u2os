import { ModelProvider } from './model-provider.js';

// A local model served by LM Studio, through its native chat API
// (POST /api/v1/chat). The native API has a `reasoning` switch: with it off a
// "thinking" model such as Qwen3 answers directly instead of spending its
// tokens on a chain of thought, which is what makes it fast enough for
// high-volume judgement (job scoring). Text in, text out: like the CLI
// providers it is used through complete(), never to plan tool actions.
//
// The key is read by the caller from the encrypted vault and never appears in
// errors, logs or results.

const MAX_OUTPUT = 4096;

export class LmStudioProvider extends ModelProvider {
  constructor({ baseUrl = 'http://127.0.0.1:1234', model, apiKey = null, reasoning = 'off', maxOutputTokens = 2048, timeoutMs = 120_000, fetchImpl = globalThis.fetch } = {}) {
    super();
    if (!model) throw new Error('lmstudio: a model is required');
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error('lmstudio: baseUrl must be http(s)');
    this.baseUrl = url.origin;
    this.model = model;
    this.apiKey = apiKey;
    this.reasoning = reasoning === 'on' ? 'on' : 'off';
    this.maxOutputTokens = Math.min(Math.max(Number(maxOutputTokens) || 2048, 64), MAX_OUTPUT);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.id = `lmstudio:${model}`;
    this.destination = 'local_model';
  }

  async plan() { throw new Error('lmstudio: this provider answers text prompts only; it does not plan tool actions'); }

  async complete(systemPrompt, userContent) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, system_prompt: String(systemPrompt), input: String(userContent), reasoning: this.reasoning, max_output_tokens: this.maxOutputTokens, temperature: 0, stream: false }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? 'Model provider timed out' : 'Model provider could not be reached');
    } finally { clearTimeout(timer); }
    if (response.status === 401 || response.status === 403) throw new Error('Model provider rejected the credentials');
    if (!response.ok) throw new Error(`Model provider answered ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error('Model provider returned something that is not JSON'); }
    const text = (Array.isArray(body.output) ? body.output : []).filter((item) => item.type === 'message').map((item) => item.content).join('\n')
      // A thinking model may still emit its chain of thought inline: it is never the answer.
      .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!text) throw new Error('Model provider returned no answer');
    return text;
  }

  /** Is the server up and the model loaded? Says nothing about answer quality. */
  async probe() {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, { headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}, signal: AbortSignal.timeout(5000) });
      if (response.status === 401 || response.status === 403) return { available: false, reason: 'the server rejected the credentials' };
      if (!response.ok) return { available: false, reason: `the server answered ${response.status}` };
      const ids = ((await response.json()).data ?? []).map((entry) => entry.id);
      return ids.includes(this.model) ? { available: true } : { available: false, reason: `model ${this.model} is not available on the server` };
    } catch { return { available: false, reason: 'the server could not be reached' }; }
  }
}
