import { DataProcessingPolicy } from '../policy/data-processing-policy.js';
import { filterPersonalContextForDestination } from './context-privacy-filter.js';

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
 *
 * DATA-PROCESSING PRIVACY (PLAN.md Phase 6): right before calling a
 * resolved provider, Planner filters `context.personalContext` down to
 * what's allowed to reach that SPECIFIC provider's destination
 * (local_model vs configured_remote_model) via DataProcessingPolicy. This
 * happens here, not in ContextAssembler, because the destination is only
 * known once a specific provider is resolved -- and if a fallback provider
 * with a DIFFERENT destination ends up handling the request, filtering is
 * re-applied for that provider too.
 */
export class Planner {
  constructor({ modelProvider, modelRouter, role = 'planner', dataProcessingPolicy } = {}) {
    this.modelProvider = modelProvider;
    this.modelRouter = modelRouter;
    this.role = role;
    this.dataProcessingPolicy = dataProcessingPolicy || new DataProcessingPolicy();
    // Set after each plan() call when routed through a ModelRouter, so
    // callers (Agent's audit trail) can record which provider actually
    // produced the plan without re-resolving the router themselves.
    this.lastProviderId = modelProvider?.id ?? null;
    // Set after each plan() call: what (if anything) was withheld from the
    // provider that actually handled it, for explainability/audit.
    this.lastOmittedContext = [];
    // Set after each plan() call: the retrieved-memory-item ids
    // (facts/entities/relationships/events) that were actually included in
    // the context sent to the provider for THIS plan, after data-processing
    // filtering -- see docs/architecture.md's explainability section. Empty
    // when the context carried no personalContext (e.g. a bare unit-test
    // plan() call with no ContextAssembler involved).
    this.lastProvenanceRefs = [];
  }

  /**
   * @returns {Promise<{reasoning_summary: string, actions: Array<{tool: string, arguments: object}>}>}
   */
  async plan(context, objective) {
    if (!this.modelRouter) {
      return this._planWith(this.modelProvider, context, objective);
    }

    const provider = this.modelRouter.resolve(this.role);
    try {
      const plan = await this._planWith(provider, context, objective);
      this.lastProviderId = provider.id;
      return plan;
    } catch (err) {
      let fallback;
      try { fallback = this.modelRouter.resolveFallback(this.role); }
      catch (fallbackError) { throw this.modelRouter.allowMock === false ? unavailableModel(fallbackError) : fallbackError; }
      if (!fallback) throw this.modelRouter.allowMock === false ? unavailableModel(err) : err;
      console.error(`[planner] role "${this.role}" primary provider failed; retrying configured fallback`);
      let plan;
      try { plan = await this._planWith(fallback, context, objective); }
      catch (fallbackError) { throw this.modelRouter.allowMock === false ? unavailableModel(fallbackError) : fallbackError; }
      this.lastProviderId = fallback.id;
      return plan;
    }
  }

  async _planWith(provider, context, objective) {
    const destination = provider.destination || 'configured_remote_model';
    const { context: filteredPersonalContext, omitted } = filterPersonalContextForDestination(
      context.personalContext,
      destination,
      this.dataProcessingPolicy
    );
    this.lastOmittedContext = omitted;
    this.lastProvenanceRefs = filteredPersonalContext?.provenanceRefs || [];

    if (omitted.length && context.eventBus) {
      context.eventBus.publish({
        type: 'agent.context_restricted',
        source: 'agent',
        actor: context.actor,
        data: { destination, providerId: provider.id, omitted },
        metadata: { correlationId: context.correlationId, provenance: 'planner:data-processing-policy' },
      });
    }

    return provider.plan({ ...context, personalContext: filteredPersonalContext }, objective);
  }
}

function unavailableModel(cause) {
  const error = new Error('Planner unavailable: configured model failed; check its endpoint and credentials, then retry');
  error.code = 'MODEL_UNAVAILABLE';
  error.status = 503;
  error.cause = cause;
  return error;
}
