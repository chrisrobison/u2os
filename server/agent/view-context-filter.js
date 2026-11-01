import { DataProcessingPolicy } from '../policy/data-processing-policy.js';

// The context the owner attached to a chat message (the job they are looking
// at; #640). The server resolved it from its own records, so it is data about
// the owner's search, classified `private` like any other account-backed data:
// the same data-processing policy that governs memory and tool results decides
// whether it may reach this model. When it may not, it is left out (never
// downgraded), the omission is reported, and the message is planned without it.

export const VIEW_CONTEXT_CLASSIFICATION = 'private';
const MAX_CHARS = 6_000;

export function filterViewContextForDestination(viewContext, destination, policy = new DataProcessingPolicy()) {
  if (!viewContext) return { context: null, omitted: [] };
  const source = { kind: typeof viewContext.kind === 'string' ? viewContext.kind : 'unknown', destination };
  const decision = policy.evaluate({ classification: VIEW_CONTEXT_CLASSIFICATION, destination });
  if (decision.decision !== 'allow') return { context: null, omitted: [{ ...source, classification: VIEW_CONTEXT_CLASSIFICATION, decision: decision.decision, rule: decision.rule }] };
  if (JSON.stringify(viewContext).length > MAX_CHARS) return { context: null, omitted: [{ ...source, reason: 'payload-limit' }] };
  return { context: { ...viewContext, classification: VIEW_CONTEXT_CLASSIFICATION }, omitted: [] };
}
