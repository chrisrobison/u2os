/**
 * EvaluatorRegistry: lets proactive event-specific behavior register itself
 * instead of living in a growing switch statement inside Agent. Modeled on
 * ToolRegistry's shape (server/tools/registry.js) so the two "things skills
 * can extend without editing core orchestration code" mechanisms stay
 * consistent.
 *
 *   registry.register({
 *     eventPattern: 'email.received',
 *     evaluate(event, context) { ... },
 *   })
 *
 * `evaluate(event, context)` must return a decision object of the shape
 * documented in docs/automation.md (`{ decision: 'ignore'|'remember'|
 * 'notify'|'recommend'|'prepare'|'request_approval'|'act', ... }`). An
 * evaluator NEVER calls a tool directly -- it proposes through
 * `context.proposeAction(...)`, which Agent wires to the same policy-gated,
 * audited evaluateAndMaybeExecute() pipeline every other action source
 * uses. Registering an evaluator can add new proactive behavior; it cannot
 * add a new way to bypass policy.
 *
 * `eventPattern` is either an exact event type ('email.received'), a
 * '<prefix>.*' wildcard, or '*' to match everything. First registered match
 * wins -- callers that need more elaborate routing can register a single
 * evaluator with a broader pattern and dispatch internally.
 */
export class EvaluatorRegistry {
  constructor() {
    this._evaluators = [];
  }

  register({ eventPattern, evaluate, name }) {
    if (!eventPattern || typeof eventPattern !== 'string') {
      throw new Error('EvaluatorRegistry.register requires a string eventPattern');
    }
    if (typeof evaluate !== 'function') {
      throw new Error('EvaluatorRegistry.register requires an evaluate(event, context) function');
    }
    this._evaluators.push({ eventPattern, evaluate, name: name || eventPattern });
    return this;
  }

  /** Returns the first registered evaluator whose pattern matches eventType, or null. */
  find(eventType) {
    return this._evaluators.find((entry) => matchesPattern(entry.eventPattern, eventType)) || null;
  }

  list() {
    return [...this._evaluators];
  }
}

function matchesPattern(pattern, eventType) {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return eventType.startsWith(pattern.slice(0, -1));
  return pattern === eventType;
}
