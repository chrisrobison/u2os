import { ModelProvider } from './model-provider.js';
import { validatePlanWithRepair } from './plan-validator.js';
import { PLANNER_SYSTEM_PROMPT, buildPlanRequestPayload } from './prompt-payload.js';
import { classifyProviderDestination } from './provider-destination.js';
import { parseReportedUsage } from './model-usage.js';

const SYSTEM_PROMPT = `${PLANNER_SYSTEM_PROMPT} Respond with raw JSON only -- no prose, no markdown code fences.`;

/**
 * Second, deliberately non-identical ModelProvider implementation (see
 * PLAN.md's Milestone 2 "at least one separately implemented provider
 * adapter"). Talks to Anthropic's Messages API directly over fetch --
 * different auth header, different request/response envelope, and no
 * `response_format: json_object` guarantee, unlike
 * openai-compatible-provider.js -- proving the ModelProvider abstraction is
 * real rather than a thin reskin of one vendor's shape. No SDK dependency:
 * this is a handful of fields over plain HTTP, which is cheaper and more
 * inspectable than adding a dependency for it.
 */
export class AnthropicProvider extends ModelProvider {
  constructor({ apiKey, model, baseUrl = 'https://api.anthropic.com', timeoutMs = 30000, apiVersion = '2023-06-01', fetchImpl = fetch, destination = null }) {
    super();
    if (!apiKey || !model) throw new Error('Anthropic provider requires apiKey and model');
    this.id = `anthropic:${model}`;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
    // Almost always 'configured_remote_model' (the default baseUrl is
    // Anthropic's hosted API); classified the same way as the
    // OpenAI-compatible provider so a local Anthropic-API-compatible proxy
    // can still be recognized as local. See provider-destination.js.
    this.destination = classifyProviderDestination(this.baseUrl, destination);
  }

  async plan(context, objective) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: JSON.stringify(buildPlanRequestPayload(context, objective)) }],
        }),
      });
      if (!response.ok) throw new Error(`Model provider unavailable (HTTP ${response.status})`);
      const payload = await response.json();
      const usage = parseReportedUsage(payload?.usage, 'input_tokens', 'output_tokens');
      if (usage) context.onUsage?.({ ...usage, providerId: this.id });
      const textBlock = (payload?.content || []).find((block) => block?.type === 'text');
      if (typeof textBlock?.text !== 'string') throw new Error('Model provider returned no plan content');
      let parsed;
      try {
        parsed = JSON.parse(extractJson(textBlock.text));
      } catch {
        throw new Error('Model provider returned invalid JSON');
      }
      return validatePlanWithRepair(parsed, context.toolRegistry);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Model provider timed out');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Anthropic has no guaranteed JSON-only response mode -- unlike the
// OpenAI-compatible provider's response_format:json_object -- so a model
// may still wrap its answer in a markdown fence despite the system prompt
// asking it not to. Strip one bounded fence if present; never eval, never
// attempt to repair anything beyond removing the fence markers themselves.
function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}
