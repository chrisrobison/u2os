/**
 * ContextAssembler: gathers the bounded context a Planner hands to a model
 * provider for a single planning request.
 *
 * PHASE 1 SCOPE (current): this only assembles the same minimal plan
 * context Agent always built inline -- the tool registry, event bus, and
 * request identity (correlationId/actor) a provider needs to look up tools
 * and execute read-only lookups while planning (see
 * mock-model-provider.js's calendar lookups). No memory, facts, or
 * conversation history are assembled yet.
 *
 * PLANNED: per PLAN.md / docs/architecture.md, this is where bounded,
 * ranked, provenance-tagged personal context (recent conversation, relevant
 * entities/facts/relationships, commitments, recent events, applicable
 * policy hints) will be assembled for the Planner, subject to a token
 * budget and to the data-processing privacy policy (which context is even
 * allowed to reach the selected provider). Introducing the class now,
 * rather than after Planner/model-routing work lands, gives those phases a
 * stable seam instead of requiring another Agent surgery later.
 */
export class ContextAssembler {
  constructor({ toolRegistry, eventBus } = {}) {
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
  }

  /**
   * @returns {{toolRegistry: object, eventBus: object, correlationId: string, actor: object}}
   */
  assemble({ correlationId, actor } = {}) {
    return {
      toolRegistry: this.toolRegistry,
      eventBus: this.eventBus,
      correlationId,
      actor,
    };
  }
}
