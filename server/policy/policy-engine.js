import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { loadPolicies } from './policies-loader.js';

// always/autonomous/confirm/never -> autonomy levels 0/4/3/5, per docs/policies.md.
const LEVELS = { always: 0, autonomous: 4, confirm: 3, never: 5 };

// Only `confirm` blocks on user approval; `never` is a separate hard block
// (also surfaced with requiresApproval=true, but with blocked=true so the
// tool layer refuses to execute it even if "approved" -- see docs/policies.md
// step 4). Any levelKey not in this map fails safe toward requiring approval.
const REQUIRES_APPROVAL = { always: false, autonomous: false, confirm: true, never: true };

export class PolicyEngine {
  constructor({ policies } = {}) {
    this.policies = policies || loadPolicies();
  }

  reload() {
    this.policies = loadPolicies();
    return this.policies;
  }

  /**
   * evaluate({ tool, arguments, context }) -> { autonomyLevel, requiresApproval, blocked, domain, rule, reason }
   * Implements the exact resolution algorithm in docs/policies.md.
   */
  evaluate({ tool, arguments: args = {}, context = {} }) {
    const domain = tool.domain;
    const operation = tool.name.split('.')[1];

    if (tool.category === 'read') {
      return {
        autonomyLevel: 0,
        requiresApproval: false,
        blocked: false,
        domain,
        rule: 'read:always',
        reason: 'Read-only tools are always allowed in Phase 1.',
      };
    }

    const opPolicy = this.policies?.[domain]?.[operation];

    if (opPolicy === undefined) {
      // Fail safe toward asking, never toward silent autonomy.
      return {
        autonomyLevel: 3,
        requiresApproval: true,
        blocked: false,
        domain,
        rule: `${domain}.${operation}:missing`,
        reason: `No policy configured for ${domain}.${operation}; defaulting to confirm.`,
      };
    }

    let levelKey;
    let rule;

    if (typeof opPolicy === 'string') {
      levelKey = opPolicy;
      rule = `${domain}.${operation}:${opPolicy}`;
    } else if (typeof opPolicy === 'object' && opPolicy !== null) {
      const subCategory = resolveSubCategory(context);
      if (subCategory && opPolicy[subCategory] !== undefined) {
        levelKey = opPolicy[subCategory];
        rule = `${domain}.${operation}.${subCategory}:${levelKey}`;
      } else if (subCategory && opPolicy.default !== undefined) {
        levelKey = opPolicy.default;
        rule = `${domain}.${operation}.default:${levelKey}`;
      } else {
        levelKey = 'confirm';
        rule = `${domain}.${operation}:fallback-confirm`;
      }
    } else {
      levelKey = 'confirm';
      rule = `${domain}.${operation}:fallback-confirm`;
    }

    const autonomyLevel = LEVELS[levelKey] ?? 3;
    const blocked = levelKey === 'never';
    const requiresApproval = REQUIRES_APPROVAL[levelKey] ?? true;

    return {
      autonomyLevel,
      requiresApproval,
      blocked,
      domain,
      rule,
      reason: describeReason(levelKey, domain, operation),
    };
  }
}

// SECURITY: sub-category is resolved ONLY from `context`, which the caller
// (server/agent/agent.js's _buildEvalContext) must derive from authoritative,
// server-side data (e.g. the target calendar event's stored category). It
// must NEVER fall back to the proposed action's own `arguments` -- those are
// produced by the model/planner, and a policy engine that lets a proposal
// categorize itself lets the model pick its own autonomy level (e.g. an
// email.send to a legal contact tagged arguments.category:'friends' would
// silently bypass a `never` block). This is the one gate PROMPT.md says no
// LLM may bypass, so it must not trust model-authored input for this
// decision, even indirectly.
function resolveSubCategory(context) {
  return context?.category || context?.event?.category || null;
}

function describeReason(levelKey, domain, operation) {
  switch (levelKey) {
    case 'always':
      return `${domain}.${operation} is always allowed.`;
    case 'autonomous':
      return `${domain}.${operation} is configured for delegated autonomy.`;
    case 'confirm':
      return `${domain}.${operation} requires explicit confirmation per policy.`;
    case 'never':
      return `${domain}.${operation} is blocked by policy (never).`;
    default:
      return `${domain}.${operation} defaulted to confirm (unrecognized policy value "${levelKey}").`;
  }
}

// --- agent_actions audit trail -------------------------------------------
// Every policy evaluation ends up here, regardless of outcome, per
// docs/policies.md's audit log field list.

export function recordAudit(row) {
  const db = getDb();
  const id = row.id || newId('act');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_actions (
      id, requested_by, request_text, model, tool, arguments, reasoning_summary,
      policy_domain, policy_rule, autonomy_level, requires_approval, status,
      approved_by, approved_at, result, correlation_id, context_provenance, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    row.requestedBy,
    row.requestText ?? null,
    row.model ?? null,
    row.tool,
    JSON.stringify(row.arguments ?? {}),
    row.reasoningSummary ?? null,
    row.policyDomain ?? null,
    row.policyRule ?? null,
    row.autonomyLevel ?? null,
    row.requiresApproval ? 1 : 0,
    row.status || 'pending',
    row.approvedBy ?? null,
    row.approvedAt ?? null,
    row.result !== undefined && row.result !== null ? JSON.stringify(row.result) : null,
    row.correlationId ?? null,
    row.contextProvenance && row.contextProvenance.length ? JSON.stringify(row.contextProvenance) : null,
    now,
    now
  );
  return getAgentAction(id);
}

export function updateAgentAction(id, patch = {}) {
  const existing = getAgentAction(id);
  if (!existing) return null;
  const db = getDb();
  const now = new Date().toISOString();
  const status = patch.status ?? existing.status;
  const approvedBy = patch.approvedBy !== undefined ? patch.approvedBy : existing.approved_by;
  const approvedAt = patch.approvedAt !== undefined ? patch.approvedAt : existing.approved_at;
  const rejectedBy = patch.rejectedBy !== undefined ? patch.rejectedBy : existing.rejected_by;
  const rejectedAt = patch.rejectedAt !== undefined ? patch.rejectedAt : existing.rejected_at;
  const result =
    patch.result !== undefined
      ? JSON.stringify(patch.result)
      : existing.result
        ? JSON.stringify(existing.result)
        : null;
  db.prepare('UPDATE agent_actions SET status = ?, approved_by = ?, approved_at = ?, rejected_by = ?, rejected_at = ?, result = ?, updated_at = ? WHERE id = ?').run(
    status,
    approvedBy,
    approvedAt,
    rejectedBy,
    rejectedAt,
    result,
    now,
    id
  );
  return getAgentAction(id);
}

export function getAgentAction(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(id);
  return row ? rowToAction(row) : null;
}

export function listPendingActions() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_actions WHERE status = 'pending' ORDER BY created_at DESC").all();
  return rows.map(rowToAction);
}

function rowToAction(row) {
  return {
    ...row,
    arguments: JSON.parse(row.arguments || '{}'),
    result: row.result ? JSON.parse(row.result) : null,
    contextProvenance: row.context_provenance ? JSON.parse(row.context_provenance) : [],
  };
}
