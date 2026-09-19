import { getAgentAction } from '../policy/policy-engine.js';
import { listEvents } from '../events/log.js';
import { getDb } from '../db/connection.js';

/**
 * Assembles a human-inspectable explanation for one proposed/executed
 * action -- the actual data a future "Why did U2OS do this?" view would
 * read (PLAN.md Phase 9). Every field is either a concise, already-stored
 * reasoning summary or a concrete reference (an id) that can be looked up;
 * this deliberately never stores or surfaces raw model chain-of-thought.
 *
 * @returns {null | {
 *   id: string, tool: string, arguments: object, reasoningSummary: string|null,
 *   model: string|null, policyDomain: string|null, policyRule: string|null,
 *   autonomyLevel: number|null, requiresApproval: boolean, status: string,
 *   approvedBy: string|null, rejectedBy: string|null, result: unknown,
 *   contextProvenance: Array<{type: string, id: string}>,
 *   correlationId: string|null,
 *   relatedEvents: Array<{id: string, type: string, timestamp: string}>,
 * }}
 */
export function explainAction(id) {
  const action = getAgentAction(id);
  if (!action) return null;

  const db = getDb();
  const relatedEvents = action.correlation_id
    ? listEvents(db, { correlationId: action.correlation_id, limit: 200 }).map((e) => ({ id: e.id, type: e.type, timestamp: e.timestamp }))
    : [];

  return {
    id: action.id,
    tool: action.tool,
    arguments: action.arguments,
    reasoningSummary: action.reasoning_summary,
    model: action.model,
    policyDomain: action.policy_domain,
    policyRule: action.policy_rule,
    autonomyLevel: action.autonomy_level,
    requiresApproval: Boolean(action.requires_approval),
    status: action.status,
    approvedBy: action.approved_by,
    rejectedBy: action.rejected_by,
    result: action.result,
    contextProvenance: action.contextProvenance || [],
    correlationId: action.correlation_id,
    // Oldest first -- reads as the actual causal story ("this happened,
    // then this, then this"), not a reverse-chronological activity feed.
    relatedEvents: relatedEvents.slice().reverse(),
  };
}
