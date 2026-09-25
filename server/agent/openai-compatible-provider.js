import { ModelProvider } from './model-provider.js';
import { validatePlanWithRepair } from './plan-validator.js';
import { PLANNER_SYSTEM_PROMPT, buildPlanRequestPayload } from './prompt-payload.js';
import { classifyProviderDestination } from './provider-destination.js';
import { parseReportedUsage } from './model-usage.js';

export class OpenAICompatibleProvider extends ModelProvider {
  constructor({ baseUrl, model, apiKey = null, timeoutMs = 30000, fetchImpl = fetch, destination = null }) {
    super();
    if (!baseUrl || !model) throw new Error('OpenAI-compatible provider requires baseUrl and model');
    this.id = `openai-compatible:${model}`;
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.model = model; this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl;
    // 'local_model' for loopback/private-network endpoints (Ollama,
    // llama.cpp, LM Studio running on this machine or the LAN), else
    // 'configured_remote_model' -- see provider-destination.js. Pass an
    // explicit `destination` to override the heuristic (e.g. a
    // self-hosted server reachable via a public hostname the owner still
    // considers "local" for privacy purposes).
    this.destination = classifyProviderDestination(this.baseUrl, destination);
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
      const payload = await response.json();
      const usage = parseReportedUsage(payload?.usage, 'prompt_tokens', 'completion_tokens');
      if (usage) context.onUsage?.({ ...usage, providerId: this.id });
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Model provider returned no plan content');
      let parsed; try { parsed = JSON.parse(content); } catch { throw new Error('Model provider returned invalid JSON'); }
      return validatePlanWithRepair(parsed, context.toolRegistry);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Model provider timed out');
      throw err;
    } finally { clearTimeout(timer); }
  }
}
