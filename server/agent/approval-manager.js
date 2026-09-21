import { recordAudit, updateAgentAction, getAgentAction } from '../policy/policy-engine.js';
import { enqueueAction, getQueuedActionByActionId, requeueAction } from './action-queue-store.js';

/**
 * ApprovalManager: owns the pending-approval lifecycle -- create (audit row
 * + proposed/blocked bookkeeping event), retrieve, approve, reject, and
 * re-evaluation of policy immediately before an approved action executes.
 *
 * Every evaluated action is audited here regardless of outcome (autonomous,
 * pending, or blocked) -- see docs/policies.md's audit log field list.
 * `approve()` re-runs the ActionEvaluator rather than trusting the
 * (possibly stale) evaluation recorded at proposal time: a policy edited or
 * reloaded between proposal and approval must be honored, never the
 * decision that was true when the action was first proposed.
 */
export class ApprovalManager {
  constructor({ eventBus, actionEvaluator, actionQueueWorker }) {
    this.eventBus = eventBus;
    this.actionEvaluator = actionEvaluator;
    this.actionQueueWorker = actionQueueWorker;
  }

  /**
   * Records the audit row for a freshly evaluated action and publishes the
   * blocked/proposed bookkeeping event when applicable. Returns the audit
   * row; the caller (Agent) decides whether to execute immediately based on
   * `evaluation.blocked`/`evaluation.requiresApproval`.
   */
  recordDecision({ tool, arguments: args, requestedBy, requestText, model, reasoningSummary, evaluation, correlationId, actor, contextProvenance }) {
    const auditRow = recordAudit({
      requestedBy,
      requestText,
      model,
      tool: tool.name,
      arguments: args,
      reasoningSummary,
      policyDomain: evaluation.domain,
      policyRule: evaluation.rule,
      autonomyLevel: evaluation.autonomyLevel,
      requiresApproval: evaluation.requiresApproval,
      status: evaluation.blocked ? 'blocked' : evaluation.requiresApproval ? 'pending' : 'approved',
      correlationId,
      contextProvenance,
    });

    if (evaluation.blocked) {
      this.eventBus.publish({
        type: 'agent.action.failed',
        source: 'policy-engine',
        actor,
        subject: { type: 'agent_action', id: auditRow.id },
        data: { tool: tool.name, reason: evaluation.reason },
        metadata: { correlationId, provenance: `policy:${evaluation.rule}` },
      });
    } else if (evaluation.requiresApproval) {
      this.eventBus.publish({
        type: 'agent.action.proposed',
        source: 'agent',
        actor,
        subject: { type: 'agent_action', id: auditRow.id },
        data: { tool: tool.name, arguments: args, reason: evaluation.reason },
        metadata: { correlationId, provenance: 'agent:plan' },
      });
    }

    return auditRow;
  }

  get(id) {
    return getAgentAction(id);
  }

  async approve(id, approvedBy) {
    const action = getAgentAction(id);
    if (!action) throw new Error(`No such action: ${id}`);
    if (action.status !== 'pending') throw new Error(`Action ${id} is not pending (status=${action.status})`);

    const tool = this.actionEvaluator.resolve(action.tool);
    const evaluation = this.actionEvaluator.evaluate({ tool, arguments: action.arguments });
    const actor = { type: 'user', id: approvedBy };

    if (evaluation.blocked) {
      updateAgentAction(id, { status: 'blocked' });
      this.eventBus.publish({
        type: 'agent.action.failed',
        source: 'policy-engine',
        actor,
        subject: { type: 'agent_action', id },
        data: { tool: action.tool, reason: evaluation.reason },
        metadata: { correlationId: action.correlation_id, provenance: `policy:${evaluation.rule}` },
      });
      return { id, status: 'blocked', tool: action.tool, reason: evaluation.reason };
    }

    updateAgentAction(id, { status: 'approved', approvedBy, approvedAt: new Date().toISOString() });
    this.eventBus.publish({
      type: 'agent.action.approved',
      source: 'user',
      actor,
      subject: { type: 'agent_action', id },
      data: { tool: action.tool },
      metadata: { correlationId: action.correlation_id, provenance: 'user:approve' },
    });

    const existingQueue = getQueuedActionByActionId(id);
    if (existingQueue && ['failed', 'cancelled'].includes(existingQueue.status)) {
      requeueAction(existingQueue.id, {
        approvalReference: `${id}:${new Date().toISOString()}`,
        policyDecisionReference: evaluation.rule,
      });
    } else {
      enqueueAction({
        actionId: id,
        correlationId: action.correlation_id,
        tool: tool.name,
        arguments: action.arguments,
        actor,
        approvalReference: `${id}:${new Date().toISOString()}`,
        policyDecisionReference: evaluation.rule,
      });
    }
    return this.actionQueueWorker.processAction(id);
  }

  async reject(id, rejectedBy) {
    const action = getAgentAction(id);
    if (!action) throw new Error(`No such action: ${id}`);
    if (action.status !== 'pending') throw new Error(`Action ${id} is not pending (status=${action.status})`);

    updateAgentAction(id, { status: 'rejected', rejectedBy, rejectedAt: new Date().toISOString() });
    this.eventBus.publish({
      type: 'agent.action.rejected',
      source: 'user',
      actor: { type: 'user', id: rejectedBy },
      subject: { type: 'agent_action', id },
      data: { tool: action.tool },
      metadata: { correlationId: action.correlation_id, provenance: 'user:reject' },
    });
    return getAgentAction(id);
  }
}
