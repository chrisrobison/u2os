/**
 * Planner: turns an objective plus assembled context into a structured
 * candidate plan. It may call a model provider; it must never execute
 * anything and never touches the tool registry beyond what the provider
 * itself reads while planning (e.g. MockModelProvider's calendar lookups).
 *
 * This is intentionally a thin wrapper today -- the real behavior lives in
 * the ModelProvider implementations (mock-model-provider.js,
 * openai-compatible-provider.js) -- but gives Agent a stable seam so
 * later work (model roles, ModelRouter, strict plan-schema repair passes)
 * has one call site to change instead of touching Agent directly.
 */
export class Planner {
  constructor({ modelProvider }) {
    this.modelProvider = modelProvider;
  }

  /**
   * @returns {Promise<{reasoning_summary: string, actions: Array<{tool: string, arguments: object}>}>}
   */
  async plan(context, objective) {
    return this.modelProvider.plan(context, objective);
  }
}
