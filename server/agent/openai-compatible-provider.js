import { ModelProvider } from './model-provider.js';
import { validatePlanWithRepair } from './plan-validator.js';
import { PLANNER_SYSTEM_PROMPT, buildPlanRequestPayload } from './prompt-payload.js';

export class OpenAICompatibleProvider extends ModelProvider {
  constructor({ baseUrl, model, apiKey = null, timeoutMs = 30000, fetchImpl = fetch }) {
    super();
    if (!baseUrl || !model) throw new Error('OpenAI-compatible provider requires baseUrl and model');
    this.id = `openai-compatible:${model}`;
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.model = model; this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl;
  }
  async plan(context, objective) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.model, temperature: 0,
          messages: [
            { role: 'system', content: PLANNER_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(buildPlanRequestPayload(context, objective)) },
          ], response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) throw new Error(`Model provider unavailable (HTTP ${response.status})`);
      const payload = await response.json(); const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Model provider returned no plan content');
      let parsed; try { parsed = JSON.parse(content); } catch { throw new Error('Model provider returned invalid JSON'); }
      return validatePlanWithRepair(parsed, context.toolRegistry);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Model provider timed out');
      throw err;
    } finally { clearTimeout(timer); }
  }
}
