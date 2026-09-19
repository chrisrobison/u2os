import { DataProcessingPolicy } from '../policy/data-processing-policy.js';

/**
 * Filters a ContextAssembler-produced personalContext object down to what
 * the data-processing privacy policy allows to reach `destination`
 * ('local_model' | 'configured_remote_model'). This is a SEPARATE gate from
 * tool authorization (PolicyEngine) -- it governs what the model gets to
 * SEE, not what it's allowed to DO. See docs/policies.md and PLAN.md's
 * data-trust phase.
 *
 * Only facts currently carry an explicit classification (public/personal/
 * private/sensitive); people/commitments/events are not yet independently
 * classified, so this only filters the `facts` arrays within
 * `relevantPeople`, per-fact. That's the actual free-text content most
 * likely to carry something sensitive; extending classification to
 * commitments/events is future work (see docs/architecture.md).
 *
 * A `confirm` decision is currently treated the same as `never` (omit) --
 * ContextAssembler assembly happens synchronously within a single planning
 * call, with no interactive mid-request confirmation mechanism yet. Per
 * PLAN.md Phase 6 ("omit restricted context if the task still makes sense
 * ... otherwise fail clearly"), omitting is the conservative, fail-safe
 * choice: this NEVER silently sends restricted data, even though it also
 * doesn't yet implement the "ask for explicit approval" alternative.
 *
 * Returns { context, omitted }: `omitted` lists every withheld fact's id,
 * classification, and the policy rule that withheld it, for an audit event
 * and future explainability UI.
 */
export function filterPersonalContextForDestination(personalContext, destination, dataProcessingPolicy = new DataProcessingPolicy()) {
  if (!personalContext) return { context: personalContext, omitted: [] };

  const omitted = [];

  const relevantPeople = (personalContext.relevantPeople || []).map((person) => {
    const facts = person.facts.filter((fact) => {
      const classification = fact.classification || 'personal';
      const evaluation = dataProcessingPolicy.evaluate({ classification, destination });
      if (evaluation.decision === 'allow') return true;
      omitted.push({ type: 'fact', id: fact.factId, classification, decision: evaluation.decision, rule: evaluation.rule });
      return false;
    });
    return { ...person, facts };
  });

  if (!omitted.length) return { context: personalContext, omitted };

  return {
    context: { ...personalContext, relevantPeople, dataProcessingRestricted: true },
    omitted,
  };
}
