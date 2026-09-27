import { DataProcessingPolicy } from '../policy/data-processing-policy.js';
import { filterPersonalContextForDestination } from './context-privacy-filter.js';
import { filterObservationsForDestination, classifyObservation } from './observation-filter.js';
import { filterConversationHistoryForDestination, summarizeEarlierTurnsForDestination } from './conversation-history-filter.js';
import { filterPriorArtifactsForDestination } from './prior-artifacts-filter.js';

// Runtime-only association. Model JSON cannot create or overwrite it, and
// overlapping calls cannot replace another returned plan's privacy context.
const planContexts = new WeakMap();

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
    // Set after each plan() call: retrieved memory and conversation-turn IDs
    // actually included for THIS plan after destination-specific filtering.
    // This is "seen by the model" provenance, not a claim it used every item. Empty
    // when the context carried no personalContext (e.g. a bare unit-test
    // plan() call with no ContextAssembler involved).
    this.lastProvenanceRefs = [];
    this.lastOmittedObservations = [];
    this.lastAllowedObservations = [];
    this.lastAllowedHistory = [];
    this.lastAllowedPriorArtifacts = [];
  }

  getPlanContext(plan) {
    return plan && typeof plan === 'object' ? planContexts.get(plan) : undefined;
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
      if (['MODEL_CALL_LIMIT', 'RUN_BUDGET_EXHAUSTED', 'MODEL_USAGE_INVALID', 'MODEL_USAGE_RECORD_FAILED'].includes(err.code)) throw err;
      let fallback;
      try { fallback = this.modelRouter.resolveFallback(this.role); }
      catch (fallbackError) { throw ['MODEL_CALL_LIMIT', 'RUN_BUDGET_EXHAUSTED', 'MODEL_USAGE_INVALID', 'MODEL_USAGE_RECORD_FAILED'].includes(fallbackError.code) ? fallbackError : this.modelRouter.allowMock === false ? unavailableModel(fallbackError) : fallbackError; }
      if (!fallback) throw this.modelRouter.allowMock === false ? unavailableModel(err) : err;
      console.error(`[planner] role "${this.role}" primary provider failed; retrying configured fallback`);
      let plan;
      try { plan = await this._planWith(fallback, context, objective); }
      catch (fallbackError) { throw ['MODEL_CALL_LIMIT', 'RUN_BUDGET_EXHAUSTED', 'MODEL_USAGE_INVALID', 'MODEL_USAGE_RECORD_FAILED'].includes(fallbackError.code) ? fallbackError : this.modelRouter.allowMock === false ? unavailableModel(fallbackError) : fallbackError; }
      this.lastProviderId = fallback.id;
      return plan;
    }
  }

  async _planWith(provider, context, objective) {
    const providerId = provider.id;
    const destination = provider.destination || 'configured_remote_model';
    const { context: filteredPersonalContext, omitted } = filterPersonalContextForDestination(
      context.personalContext,
      destination,
      this.dataProcessingPolicy
    );
    this.lastOmittedContext = omitted;
    const { observations, omitted: omittedObservations } = filterObservationsForDestination(context.observations, destination, this.dataProcessingPolicy);
    const { history, omitted: omittedHistory } = filterConversationHistoryForDestination(context.conversationHistory, destination, this.dataProcessingPolicy);
    const { summary: conversationSummary, omitted: omittedSummary } = summarizeEarlierTurnsForDestination(context.conversationSummarySources, destination, this.dataProcessingPolicy);
    const { artifacts: priorReadArtifacts, omitted: omittedPriorArtifacts } = filterPriorArtifactsForDestination(context.priorReadArtifacts, destination, this.dataProcessingPolicy);
    this.lastOmittedObservations = omittedObservations;
    this.lastAllowedObservations = observations;
    this.lastAllowedHistory = history;
    this.lastAllowedPriorArtifacts = priorReadArtifacts;
    const provenanceRefs = [
      ...(filteredPersonalContext?.provenanceRefs || []),
      ...history.filter((turn) => turn.turnId).map((turn) => ({ type: 'conversation_turn', id: turn.turnId })),
      ...(conversationSummary?.entries || []).map((turn) => ({ type: 'conversation_turn', id: turn.turnId })),
      ...priorReadArtifacts.filter((item) => item.actionId).map((item) => ({ type: 'prior_read_action', id: item.actionId })),
    ];
    this.lastProvenanceRefs = provenanceRefs;

    if (omitted.length && context.eventBus) {
      context.eventBus.publish({
        type: 'agent.context_restricted',
        source: 'agent',
        actor: context.actor,
        data: { destination, providerId, omitted },
        metadata: { correlationId: context.correlationId, provenance: 'planner:data-processing-policy' },
      });
    }

    if (omittedObservations.length && context.eventBus) {
      context.eventBus.publish({
        type: 'agent.observation_restricted',
        source: 'agent',
        actor: context.actor,
        data: { destination, providerId, omitted: omittedObservations },
        metadata: { correlationId: context.correlationId, provenance: 'planner:observation-policy' },
      });
    }

    if ((omittedHistory.length || omittedSummary.length) && context.eventBus) {
      context.eventBus.publish({
        type: 'agent.history_restricted', source: 'agent', actor: context.actor,
        data: { destination, providerId, omitted: [...omittedHistory, ...omittedSummary.map((item) => ({ ...item, source: 'earlier_summary' }))] },
        metadata: { correlationId: context.correlationId, provenance: 'planner:conversation-history-policy' },
      });
    }

    if (omittedPriorArtifacts.length && context.eventBus) {
      context.eventBus.publish({
        type: 'agent.prior_artifact_restricted', source: 'agent', actor: context.actor,
        data: { destination, providerId, omitted: omittedPriorArtifacts },
        metadata: { correlationId: context.correlationId, provenance: 'planner:prior-artifact-policy' },
      });
    }

    context.onModelCall?.();
    // Snapshot before invoking the provider; later calls or provider mutation
    // cannot change the classification authority for this exact output.
    const outputClassification = classifyObservation('model.context', {
      personalContext: filteredPersonalContext, observations, history, conversationSummary, priorReadArtifacts,
    });
    const { onModelCall, conversationHistory, conversationSummarySources: _summarySources,
      conversationSummary: _untrustedSummary, priorReadArtifacts: _priorReadArtifacts, ...providerContext } = context;
    const proposed = await provider.plan({ ...providerContext, personalContext: filteredPersonalContext, observations, conversationHistory: history, conversationSummary, priorReadArtifacts }, objective);
    // Allocate a distinct object even if a fixture/provider reuses its JSON
    // plan object. Malformed primitive/array results still reach validation.
    if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return proposed;
    const plan = { ...proposed };
    planContexts.set(plan, { providerId, observations, priorReadArtifacts, conversationSummary, provenanceRefs, outputClassification });
    return plan;
  }
}

function unavailableModel(cause) {
  const error = new Error('Planner unavailable: configured model failed; check its endpoint and credentials, then retry');
  error.code = 'MODEL_UNAVAILABLE';
  error.status = 503;
  error.cause = cause;
  return error;
}
