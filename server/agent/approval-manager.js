import { recordAudit, updateAgentAction, getAgentAction } from '../policy/policy-engine.js';
import { enqueueAction, getQueuedActionByActionId, requeueAction } from './action-queue-store.js';
import { getProviderForBinding } from '../integrations/provider-registry.js';
import { accountDomainForAction, assertCalendarTarget, assertSmtpIdentity } from './account-binding.js';
import { planRemember, applyRememberedRule } from '../policy/remember-approval.js';

export const STALE_ACTION_ERROR = 'Action is stale and requires owner review';

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
  recordDecision({ id, tool, arguments: args, requestedBy, requestText, model, reasoningSummary, evaluation, correlationId, actor, contextProvenance, accountBinding, packageContext = null }) {
    const auditRow = recordAudit({
      id,
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
      accountBinding,
      packageContext,
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

    const accountDomain = accountDomainForAction(action.tool);
    if (accountDomain) {
      try {
        getProviderForBinding(accountDomain, action.accountBinding);
        if (action.tool === 'email.send') assertSmtpIdentity(action.accountBinding);
        if (action.tool === 'calendar.reschedule') assertCalendarTarget(action.accountBinding, action.arguments.eventId);
      }
      catch (error) {
        updateAgentAction(id, { status: 'blocked', result: { error: error.message } });
        this.eventBus.publish({
          type: 'agent.action.failed', source: 'account-binding', actor,
          subject: { type: 'agent_action', id }, data: { tool: action.tool, reason: error.message },
          metadata: { correlationId: action.correlation_id, provenance: 'runtime:account-binding' },
        });
        return { id, status: 'blocked', tool: action.tool, reason: error.message };
      }
    }

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

  /**
   * What "Approve and always allow" would store for a pending action, or why
   * it can't. Evaluated against the policy in force right now, like approve().
   */
  previewRemember(id) {
    const action = getAgentAction(id);
    if (!action) throw new Error(`No such action: ${id}`);
    if (action.status !== 'pending') return planRemember({ action });
    let evaluation;
    try {
      const tool = this.actionEvaluator.resolve(action.tool);
      evaluation = this.actionEvaluator.evaluate({ tool, arguments: action.arguments });
    } catch { return planRemember({ action }); }
    return planRemember({ action, evaluation, policies: this.actionEvaluator.policyEngine.policies });
  }

  /** Writes a previously previewed rule. Never throws: the approval already happened. */
  rememberApproval(id, plan, approvedBy) {
    try {
      const policyEngine = this.actionEvaluator.policyEngine;
      const written = applyRememberedRule(plan, { effective: policyEngine.policies });
      // The engine notices the changed file on its next evaluation.
      this.eventBus.publish({
        type: 'policy.rule.remembered',
        source: 'user',
        actor: { type: 'user', id: approvedBy },
        subject: { type: 'agent_action', id },
        data: { domain: plan.domain, operation: plan.operation, subCategory: plan.subCategory, level: plan.level },
        metadata: { provenance: 'user:approve-and-remember' },
      });
      return { remembered: true, description: plan.description, created: written.created };
    } catch (error) {
      return { remembered: false, note: `Approved, but the rule was not saved: ${error.message}` };
    }
  }

  /**
   * "Review again" for an action that stopped as stale: records a fresh
   * pending approval from the same proposal, after re-checking current
   * policy. Executes nothing; the owner still approves the new action.
   * Idempotent: a second call returns the action the first one created.
   */
  repropose(id, requestedBy) {
    const action = getAgentAction(id);
    if (!action) throw new Error(`No such action: ${id}`);
    if (action.status !== 'failed' || action.result?.error !== STALE_ACTION_ERROR) throw new Error('Only an action that stopped as stale can be reviewed again');
    if (action.packageContext) throw new Error('Package actions cannot be re-proposed here');
    if (action.result?.reproposedAs) {
      const existing = getAgentAction(action.result.reproposedAs);
      if (existing) return { id: existing.id, status: existing.status, tool: existing.tool, arguments: existing.arguments, reason: existing.reasoning_summary || '', accountBinding: existing.accountBinding, reproposedFrom: id };
    }

    const tool = this.actionEvaluator.resolve(action.tool);
    const evaluation = this.actionEvaluator.evaluate({ tool, arguments: action.arguments });
    if (evaluation.blocked) throw new Error(evaluation.reason);
    if (!evaluation.requiresApproval) throw new Error('Current policy no longer asks for approval for this action; ask again to run it');
    const accountDomain = accountDomainForAction(action.tool);
    if (accountDomain) {
      getProviderForBinding(accountDomain, action.accountBinding);
      if (action.tool === 'email.send') assertSmtpIdentity(action.accountBinding);
      if (action.tool === 'calendar.reschedule') assertCalendarTarget(action.accountBinding, action.arguments.eventId);
    }

    const row = this.recordDecision({
      tool, arguments: action.arguments, requestedBy: action.requested_by, requestText: action.request_text,
      model: action.model, reasoningSummary: action.reasoning_summary, evaluation, correlationId: action.correlation_id,
      actor: { type: 'user', id: requestedBy }, contextProvenance: action.contextProvenance, accountBinding: action.accountBinding,
    });
    updateAgentAction(id, { result: { ...action.result, reproposedAs: row.id } });
    return { id: row.id, status: row.status, tool: row.tool, arguments: row.arguments, reason: evaluation.reason, accountBinding: row.accountBinding, reproposedFrom: id };
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
