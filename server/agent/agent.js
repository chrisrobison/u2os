import { newId } from '../db/ids.js';
import { recordAudit, updateAgentAction, getAgentAction } from '../policy/policy-engine.js';
import { getCachedCalendarEvent } from '../integrations/calendar-store.js';
import { detectAndRecordCommitment } from '../memory/projector.js';
import { generateDashboard as buildDashboard } from './dashboard-planner.js';

/**
 * Agent: the orchestrator. Calls the model provider to get a plan, then for
 * every proposed action, evaluates it via the policy engine, writes the
 * agent_actions audit row, and either executes immediately (autonomous) or
 * leaves it pending for explicit approval. NEVER calls a tool directly
 * without going through evaluateAndMaybeExecute() -- that is the one gate
 * every consequential action must pass through (docs/architecture.md).
 */
export class Agent {
  constructor({ modelProvider, policyEngine, toolRegistry, eventBus, ownerEntityId = null }) {
    this.modelProvider = modelProvider;
    this.policyEngine = policyEngine;
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.ownerEntityId = ownerEntityId;
  }

  /**
   * Composes a dashboard schema from real calendar/tasks/memory data for
   * the requested context ('morning' | 'before-meeting' | 'project') --
   * delegates to dashboard-planner.js, which is also responsible for
   * running the result through validateDashboard() before it ever reaches
   * an HTTP response (see docs/dashboards.md).
   */
  generateDashboard({ context, params = {} } = {}) {
    return buildDashboard({ context, params });
  }

  async handleMessage({ text, actorId = 'user' }) {
    const correlationId = newId('corr');
    const actor = { type: 'user', id: actorId };
    const planContext = { toolRegistry: this.toolRegistry, eventBus: this.eventBus, correlationId, actor };

    this.eventBus.publish({
      type: 'agent.message.received',
      source: 'user',
      actor,
      data: { text },
      metadata: { correlationId, provenance: 'user:message' },
    });

    const plan = await this.modelProvider.plan(planContext, text);
    const proposedActions = plan.actions || [];
    const results = [];
    const pendingActionIds = [];

    for (const proposed of proposedActions) {
      const outcome = await this.evaluateAndMaybeExecute({
        tool: proposed.tool,
        arguments: proposed.arguments || {},
        requestedBy: actorId,
        requestText: text,
        reasoningSummary: plan.reasoning_summary,
        correlationId,
        actor,
      });
      results.push(outcome);
      if (outcome.status === 'pending') pendingActionIds.push(outcome.id);
    }

    if (this.ownerEntityId) {
      try {
        detectAndRecordCommitment({ text, ownerEntityId: this.ownerEntityId, eventBus: this.eventBus, correlationId });
      } catch (err) {
        console.error('[agent] commitment detection failed', err);
      }
    }

    return {
      correlationId,
      reasoning_summary: plan.reasoning_summary,
      actions: results,
      pendingActionIds,
    };
  }

  /**
   * Public so other entry points (e.g. POST /api/tasks) can route a direct,
   * non-chat request through the same policy-gated, audited pipeline instead
   * of calling a tool directly -- "policy gates everything consequential"
   * applies regardless of which HTTP route triggered it.
   */
  async evaluateAndMaybeExecute({ tool: toolName, arguments: args, requestedBy, requestText, reasoningSummary, correlationId, actor }) {
    const tool = this.toolRegistry.get(toolName);
    const evalContext = this._buildEvalContext(tool, args);
    const evaluation = this.policyEngine.evaluate({ tool, arguments: args, context: evalContext });

    const auditRow = recordAudit({
      requestedBy,
      requestText,
      model: 'mock-model-provider',
      tool: toolName,
      arguments: args,
      reasoningSummary,
      policyDomain: evaluation.domain,
      policyRule: evaluation.rule,
      autonomyLevel: evaluation.autonomyLevel,
      requiresApproval: evaluation.requiresApproval,
      status: evaluation.blocked ? 'blocked' : evaluation.requiresApproval ? 'pending' : 'approved',
      correlationId,
    });

    if (evaluation.blocked) {
      this.eventBus.publish({
        type: 'agent.action.failed',
        source: 'policy-engine',
        actor,
        subject: { type: 'agent_action', id: auditRow.id },
        data: { tool: toolName, reason: evaluation.reason },
        metadata: { correlationId, provenance: `policy:${evaluation.rule}` },
      });
      return { id: auditRow.id, status: 'blocked', tool: toolName, arguments: args, reason: evaluation.reason };
    }

    if (evaluation.requiresApproval) {
      this.eventBus.publish({
        type: 'agent.action.proposed',
        source: 'agent',
        actor,
        subject: { type: 'agent_action', id: auditRow.id },
        data: { tool: toolName, arguments: args, reason: evaluation.reason },
        metadata: { correlationId, provenance: 'agent:plan' },
      });
      return { id: auditRow.id, status: 'pending', tool: toolName, arguments: args, reason: evaluation.reason };
    }

    return this._execute(auditRow.id, tool, args, { correlationId, actor });
  }

  async approveAction(id, approvedBy) {
    const action = getAgentAction(id);
    if (!action) throw new Error(`No such action: ${id}`);
    if (action.status !== 'pending') throw new Error(`Action ${id} is not pending (status=${action.status})`);

    const tool = this.toolRegistry.get(action.tool);
    const evalContext = this._buildEvalContext(tool, action.arguments);
    const evaluation = this.policyEngine.evaluate({ tool, arguments: action.arguments, context: evalContext });
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

    return this._execute(id, tool, action.arguments, { correlationId: action.correlation_id, actor });
  }

  async rejectAction(id, rejectedBy) {
    const action = getAgentAction(id);
    if (!action) throw new Error(`No such action: ${id}`);
    if (action.status !== 'pending') throw new Error(`Action ${id} is not pending (status=${action.status})`);

    updateAgentAction(id, { status: 'rejected', approvedBy: rejectedBy, approvedAt: new Date().toISOString() });
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

  // calendar.reschedule's policy sub-category is resolved from the target
  // event's category (personal/interviews/...), not from the reschedule
  // arguments themselves (eventId/newStartAt/newEndAt carry no category).
  // Reads the local calendar_events mirror directly (see
  // integrations/calendar-store.js) rather than through whichever calendar
  // provider is currently active -- intentional, not a shortcut: policy
  // context resolution must stay fast and must not depend on a live network
  // call to a real provider.
  _buildEvalContext(tool, args) {
    if (tool.name === 'calendar.reschedule' && args?.eventId) {
      const event = getCachedCalendarEvent(args.eventId);
      if (event) return { category: event.category, event };
    }
    return {};
  }

  async _execute(actionId, tool, args, { correlationId, actor }) {
    try {
      const result = await tool.execute(args, { eventBus: this.eventBus, correlationId, actor });
      updateAgentAction(actionId, { status: 'executed', result });
      this.eventBus.publish({
        type: 'agent.action.completed',
        source: 'agent',
        actor,
        subject: { type: 'agent_action', id: actionId },
        data: { tool: tool.name, result },
        metadata: { correlationId, provenance: 'agent:execute' },
      });
      return { id: actionId, status: 'executed', tool: tool.name, arguments: args, result };
    } catch (err) {
      updateAgentAction(actionId, { status: 'failed', result: { error: err.message } });
      this.eventBus.publish({
        type: 'agent.action.failed',
        source: 'agent',
        actor,
        subject: { type: 'agent_action', id: actionId },
        data: { tool: tool.name, error: err.message },
        metadata: { correlationId, provenance: 'agent:execute' },
      });
      return { id: actionId, status: 'failed', tool: tool.name, arguments: args, error: err.message };
    }
  }
}
