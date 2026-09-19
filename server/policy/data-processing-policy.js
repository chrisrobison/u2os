import { loadDataProcessingPolicies } from './data-processing-loader.js';

/**
 * DataProcessingPolicy: governs whether a piece of user data, at a given
 * CLASSIFICATION, may reach a given DESTINATION. This is a separate
 * question from tool authorization (server/policy/policy-engine.js's "may
 * calendar.reschedule execute?") -- a local model can be allowed to
 * summarize a sensitive document while the same content is forbidden from
 * ever reaching a remote inference API, independent of whether any tool is
 * involved at all. See docs/policies.md and PLAN.md's data-trust phase.
 *
 * Classifications (least to most restrictive): public, personal, private,
 * sensitive. Destinations: local_model, configured_remote_model,
 * external_tool, local_ui.
 */
export class DataProcessingPolicy {
  constructor({ policies } = {}) {
    this.policies = policies || loadDataProcessingPolicies();
  }

  reload() {
    this.policies = loadDataProcessingPolicies();
    return this.policies;
  }

  /**
   * evaluate({ classification, destination }) -> { decision: 'allow'|'confirm'|'never', rule, reason }
   * Fails safe toward 'confirm' (never toward silent 'allow') for any
   * unrecognized classification, destination, or policy value -- the same
   * fail-safe posture policy-engine.js uses for an unconfigured tool
   * operation.
   */
  evaluate({ classification = 'personal', destination }) {
    const destKey = destinationPolicyKey(destination);
    const classPolicy = this.policies?.[classification];

    if (!classPolicy) {
      return {
        decision: 'confirm',
        rule: `${classification}:missing`,
        reason: `No data-processing policy configured for classification "${classification}"; defaulting to confirm.`,
      };
    }

    const decision = classPolicy[destKey];
    if (decision === undefined) {
      return {
        decision: 'confirm',
        rule: `${classification}.${destKey}:missing`,
        reason: `No data-processing rule for ${classification} -> ${destKey}; defaulting to confirm.`,
      };
    }
    if (!['allow', 'confirm', 'never'].includes(decision)) {
      return {
        decision: 'confirm',
        rule: `${classification}.${destKey}:invalid`,
        reason: `Unrecognized data-processing policy value "${decision}" for ${classification} -> ${destKey}; defaulting to confirm.`,
      };
    }

    return { decision, rule: `${classification}.${destKey}:${decision}`, reason: describeReason(classification, destKey, decision) };
  }
}

// SECURITY: like policy-engine.js's resolveSubCategory, `destination` must
// come from authoritative context the caller derives itself (which
// provider was actually resolved to handle this request), never from
// anything a model or its own output could influence.
function destinationPolicyKey(destination) {
  switch (destination) {
    case 'local_model':
      return 'local_models';
    case 'configured_remote_model':
      return 'remote_models';
    case 'external_tool':
      return 'external_tools';
    case 'local_ui':
      return 'local_ui';
    default:
      // An unrecognized destination fails toward the strictest common
      // category rather than guessing it's safe.
      return 'remote_models';
  }
}

function describeReason(classification, destKey, decision) {
  if (decision === 'never') return `${classification} data may never reach ${destKey}.`;
  if (decision === 'confirm') return `${classification} data requires confirmation before reaching ${destKey}.`;
  return `${classification} data is allowed to reach ${destKey}.`;
}
