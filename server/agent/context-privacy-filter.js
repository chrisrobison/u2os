import { DataProcessingPolicy } from '../policy/data-processing-policy.js';

/**
 * Filters a ContextAssembler-produced personalContext object down to what
 * the data-processing privacy policy allows to reach `destination`
 * ('local_model' | 'configured_remote_model'). This is a SEPARATE gate from
 * tool authorization (PolicyEngine) -- it governs what the model gets to
 * SEE, not what it's allowed to DO. See docs/policies.md and PLAN.md's
 * data-trust phase.
 *
 * Every item type ContextAssembler produces now carries its own explicit
 * classification (public/personal/private/sensitive), so this filters at
 * TWO independent levels:
 *
 *   - Whole-item level: each person in `relevantPeople`, each standalone
 *     fact in `relevantFacts`, each entry in `commitments`, and each entry in `recentEvents` is evaluated on its
 *     OWN classification. If the policy doesn't `allow` it for
 *     `destination`, the entire item is dropped.
 *   - Per-fact level (people only): a person who IS allowed through can
 *     still carry individually-sensitive facts, so `person.facts` is
 *     filtered independently, exactly as before. A dropped person's facts
 *     are never separately evaluated -- there's no point auditing the
 *     contents of an item that's already gone.
 *
 * A `confirm` decision is currently treated the same as `never` (omit) --
 * ContextAssembler assembly happens synchronously within a single planning
 * call, with no interactive mid-request confirmation mechanism yet. Per
 * PLAN.md Phase 6 ("omit restricted context if the task still makes sense
 * ... otherwise fail clearly"), omitting is the conservative, fail-safe
 * choice: this NEVER silently sends restricted data, even though it also
 * doesn't yet implement the "ask for explicit approval" alternative.
 *
 * Returns { context, omitted }: `omitted` lists every withheld item's type
 * (person/fact/commitment/event), id, classification, destination, decision,
 * and the policy rule that withheld it, for an audit event and future
 * explainability UI.
 */
export function filterPersonalContextForDestination(personalContext, destination, dataProcessingPolicy = new DataProcessingPolicy()) {
  if (!personalContext) return { context: personalContext, omitted: [] };

  const omitted = [];

  const evaluate = (type, id, classification) => {
    const evaluation = dataProcessingPolicy.evaluate({ classification, destination });
    if (evaluation.decision === 'allow') return true;
    omitted.push({ type, id, classification, destination, decision: evaluation.decision, rule: evaluation.rule });
    return false;
  };

  const relevantPeople = (personalContext.relevantPeople || []).filter((person) => {
    const classification = person.classification || 'personal';
    return evaluate('person', person.id, classification);
  }).map((person) => {
    const facts = person.facts.filter((fact) => {
      const factClassification = fact.classification || 'personal';
      return evaluate('fact', fact.factId, factClassification);
    });
    return { ...person, facts };
  });

  const commitments = (personalContext.commitments || []).filter((commitment) => {
    const classification = commitment.classification || 'personal';
    return evaluate('commitment', commitment.id, classification);
  });

  const relevantFacts = (personalContext.relevantFacts || []).filter((fact) => {
    const classification = fact.classification || 'personal';
    return evaluate('fact', fact.factId, classification);
  });

  const recentEvents = (personalContext.recentEvents || []).filter((event) => {
    const classification = event.classification || 'personal';
    return evaluate('event', event.eventId, classification);
  });

  if (!omitted.length) return { context: personalContext, omitted };

  return {
    context: { ...personalContext, relevantPeople, relevantFacts, commitments, recentEvents, provenanceRefs: filterProvenanceRefs(personalContext.provenanceRefs, { relevantPeople, relevantFacts, commitments, recentEvents }), dataProcessingRestricted: true },
    omitted,
  };
}

function filterProvenanceRefs(refs = [], { relevantPeople, relevantFacts, commitments, recentEvents }) {
  const allowed = new Set();
  for (const person of relevantPeople) {
    allowed.add(`entity:${person.id}`);
    for (const fact of person.facts) allowed.add(`fact:${fact.factId}`);
  }
  for (const fact of relevantFacts) {
    allowed.add(`entity:${fact.entityId}`); allowed.add(`fact:${fact.factId}`);
  }
  for (const commitment of commitments) {
    allowed.add(`entity:${commitment.id}`); allowed.add(`relationship:${commitment.relationshipId}`);
  }
  for (const event of recentEvents) allowed.add(`event:${event.eventId}`);
  return refs.filter((ref) => allowed.has(`${ref.type}:${ref.id}`));
}
