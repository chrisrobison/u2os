/**
 * Planner: turns an objective plus assembled context into a structured
 * candidate plan. It may call a model provider; it must never execute
 * anything and never touches the tool registry beyond what the provider
 * itself reads while planning (e.g. MockModelProvider's calendar lookups).
 *
 * Accepts either a single `modelProvider` (legacy/simple construction,
 * still used by most tests and the default single-provider config) or a
 * `modelRouter` that resolves a provider for `role` (default: 'planner').
 * When a router is given and the resolved provider's plan() call throws,
 * Planner retries once against the router's configured fallback provider
 * for that role (if any) before propagating the error -- "provider failure
 * degrades to an explicit unavailable/fallback state" per PLAN.md, not a
 * silent retry storm or an autonomous provider-selection system.
 */
export class Planner {
  constructor({ modelProvider, modelRouter, role = 'planner' } = {}) {
    this.modelProvider = modelProvider;
    this.modelRouter = modelRouter;
    this.role = role;
    // Set after each plan() call when routed through a ModelRouter, so
    // callers (Agent's audit trail) can record which provider actually
    // produced the plan without re-resolving the router themselves.
    this.lastProviderId = modelProvider?.id ?? null;
  }

  /**
   * @returns {Promise<{reasoning_summary: string, actions: Array<{tool: string, arguments: object}>}>}
   */
  async plan(context, objective) {
    if (!this.modelRouter) {
      return this.modelProvider.plan(context, objective);
    }

    const provider = this.modelRouter.resolve(this.role);
    try {
      const plan = await provider.plan(context, objective);
      this.lastProviderId = provider.id;
      return plan;
    } catch (err) {
      const fallback = this.modelRouter.resolveFallback(this.role);
      if (!fallback) throw err;
      console.error(`[planner] role "${this.role}" provider (${provider.id}) failed (${err.message}); retrying with fallback provider (${fallback.id})`);
      const plan = await fallback.plan(context, objective);
      this.lastProviderId = fallback.id;
      return plan;
    }
  }
}
