import { getCachedCalendarEvent } from '../integrations/calendar-store.js';

/**
 * ActionEvaluator: resolves a proposed action's registered tool and
 * authoritative policy context, then asks the PolicyEngine for a decision.
 *
 * SECURITY (unchanged from the pre-refactor Agent._buildEvalContext):
 * privileged policy sub-category resolution must NEVER be derived from the
 * model-provided `arguments` on the proposed action -- only from context
 * this class derives itself from authoritative, server-side data (e.g. the
 * calendar event's own stored category). See docs/policies.md. A model that
 * could categorize its own proposal could pick its own autonomy level.
 */
export class ActionEvaluator {
  constructor({ toolRegistry, policyEngine }) {
    this.toolRegistry = toolRegistry;
    this.policyEngine = policyEngine;
  }

  /** Fail-closed lookup: throws "Unknown tool" for an unregistered/invented tool name. */
  resolve(toolName) {
    return this.toolRegistry.get(toolName);
  }

  /** @returns {{autonomyLevel:number, requiresApproval:boolean, blocked:boolean, domain:string, rule:string, reason:string}} */
  evaluate({ tool, arguments: args = {} }) {
    const context = this.buildEvalContext(tool, args);
    return this.policyEngine.evaluate({ tool, arguments: args, context });
  }

  // calendar.reschedule's policy sub-category is resolved from the target
  // event's OWN stored category, not from the reschedule arguments
  // themselves (eventId/newStartAt/newEndAt carry no category). Reads the
  // local calendar_events mirror directly rather than through whichever
  // calendar provider is currently active -- intentional: policy context
  // resolution must stay fast and must not depend on a live network call.
  buildEvalContext(tool, args) {
    if (tool.name === 'calendar.reschedule' && args?.eventId) {
      const event = getCachedCalendarEvent(args.eventId);
      if (event) return { category: event.category, event };
    }
    return {};
  }
}
