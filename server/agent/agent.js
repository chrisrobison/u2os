import { newId } from '../db/ids.js';
import { recordAudit, updateAgentAction, getAgentAction } from '../policy/policy-engine.js';
import { getCachedCalendarEvent } from '../integrations/calendar-store.js';
import { detectAndRecordCommitment } from '../memory/projector.js';
import { generateDashboard as buildDashboard } from './dashboard-planner.js';
import { applyVoiceAuthorization } from '../voice/authorize.js';
import { createRecommendation } from './recommendation-store.js';
import { findEntities } from '../memory/entity-store.js';
import * as tasksProvider from '../integrations/mock-tasks-provider.js';
import { scoreForSuggestion } from '../feedback/prioritizer.js';
import { detectEmailEdit } from '../feedback/email-edit-detector.js';

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

  // `voice` is `{ confidence: number } | undefined` -- undefined for the
  // existing text-chat path (POST /api/agent/message), which must remain
  // byte-identical to before Phase 4/5. Only POST /api/agent/voice-message
  // ever passes it. See server/voice/authorize.js for the one place it
  // actually changes anything.
  async handleMessage({ text, actorId = 'user', voice } = {}) {
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
        voice,
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
  async evaluateAndMaybeExecute({ tool: toolName, arguments: args, requestedBy, requestText, reasoningSummary, correlationId, actor, voice }) {
    const tool = this.toolRegistry.get(toolName);
    const evalContext = this._buildEvalContext(tool, args);
    const rawEvaluation = this.policyEngine.evaluate({ tool, arguments: args, context: evalContext });
    // Additive-only voice gate (server/voice/authorize.js): a no-op unless
    // `voice` is present, and even then only ever tightens `rawEvaluation`,
    // never loosens it. The audit row below records the (possibly
    // voice-adjusted) `policyRule`/`requiresApproval`, so a voice-forced
    // approval is always inspectable in the audit trail, never silent.
    const evaluation = applyVoiceAuthorization({ evaluation: rawEvaluation, voice });

    const auditRow = recordAudit({
      requestedBy,
      requestText,
      model: this.modelProvider.id || this.modelProvider.name || 'unknown-model-provider',
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

  /**
   * PROMPT.md §9 / docs/automation.md's proactive agent. Given an event
   * (from the trigger engine's 'evaluate' action, or any other caller),
   * decides one of ignore|remember|notify|recommend|prepare|request_approval|act
   * and performs the corresponding side effect.
   *
   * NON-NEGOTIABLE INVARIANT: choosing 'act' (or 'request_approval') is a
   * PROPOSAL, never a bypass. Every side effect that touches a tool goes
   * through evaluateAndMaybeExecute() -- the exact same policy-gated,
   * audited pipeline chat/voice messages use. The policy engine still has
   * final say on whether it actually executes autonomously or needs
   * approval; this method cannot and does not skip that gate.
   *
   * Only the four event types docs/automation.md names for this phase are
   * wired below (email.received, calendar.event_approaching, task.overdue,
   * commitment.made). Every other event type is a documented gap, not a
   * silent one: it returns 'ignore' rather than crashing or doing something
   * undocumented.
   */
  async evaluateEvent(event, context = {}) {
    const correlationId = context.correlationId || event.correlationId || newId('corr');
    const actor = context.actor || { type: 'agent', id: 'agent_default' };
    const ctx = { correlationId, actor };

    switch (event.type) {
      case 'email.received':
        return this._evaluateEmailReceived(event, ctx);
      case 'calendar.event_approaching':
        return this._evaluateCalendarApproaching(event, ctx);
      case 'task.overdue':
        return this._evaluateTaskOverdue(event, ctx);
      case 'commitment.made':
        return this._evaluateCommitmentMade(event, ctx);
      default:
        return {
          decision: 'ignore',
          eventType: event.type,
          reason: 'No evaluateEvent rule wired for this event type yet (documented gap -- see docs/automation.md).',
        };
    }
  }

  // email.received -> notify: recruiter/talent sender heuristic.
  //
  // Phase 7 / docs/feedback.md's named borderline case: once the heuristic
  // matches, this is no longer a strict binary (notify or not) -- it's a
  // three-way choice among notify/recommend/ignore, and
  // server/feedback/prioritizer.js's scoreForSuggestion() nudges which one
  // fires based on how the user has responded to past recruiter
  // notifications. This ONLY changes which of notify/recommend/ignore is
  // chosen here; it never changes whether notifications.send itself is
  // policy-gated -- evaluateAndMaybeExecute() below still runs it through
  // the exact same policy engine as every other proposed action, unchanged.
  async _evaluateEmailReceived(event, { correlationId, actor }) {
    const from = String(event.data?.from || '').toLowerCase();
    const subject = String(event.data?.subject || '').toLowerCase();
    const looksLikeRecruiter = /recruiter|talent/.test(from) || /recruiter|talent/.test(subject);

    if (!looksLikeRecruiter) {
      return { decision: 'ignore', eventType: event.type, reason: 'Sender/subject does not match the recruiter/talent heuristic.' };
    }

    const feedbackAdjustment = scoreForSuggestion({ tool: 'notifications.send', domain: 'email', requestedBy: 'agent:evaluateEvent' });
    const reasoningSummary = `Sender/subject matched the recruiter/talent heuristic. Feedback adjustment: ${feedbackAdjustment.adjustment} (${feedbackAdjustment.reason})`;
    const notificationArgs = {
      title: 'Recruiter email',
      body: `New email from ${event.data?.from || 'unknown sender'}: ${event.data?.subject || '(no subject)'}`,
      priority: 'high',
    };

    // Repeated negative feedback on this domain suppresses the notification
    // entirely -- "quietly deprioritized toward ignore", per docs/feedback.md.
    if (feedbackAdjustment.adjustment <= -0.15) {
      return {
        decision: 'ignore',
        eventType: event.type,
        reason: `${reasoningSummary}. Suppressed: repeated negative feedback on this domain.`,
        feedbackAdjustment,
      };
    }

    // Mildly negative feedback downgrades notify -> a lower-urgency,
    // dismissible recommendation instead of an immediate notification.
    if (feedbackAdjustment.adjustment < 0) {
      const recommendation = createRecommendation({
        decision: 'recommend',
        eventType: event.type,
        tool: 'notifications.send',
        arguments: notificationArgs,
        reasoningSummary: `${reasoningSummary}. Downgraded from notify to a lower-urgency recommendation.`,
        correlationId,
      });
      this.eventBus.publish({
        type: 'agent.action.completed',
        source: 'agent',
        actor,
        subject: { type: 'recommendation', id: recommendation.id },
        data: { decision: 'recommend', eventType: event.type, recommendationId: recommendation.id, feedbackAdjustment },
        metadata: { correlationId, provenance: 'agent:evaluateEvent' },
      });
      return { decision: 'recommend', eventType: event.type, recommendation, feedbackAdjustment };
    }

    const outcome = await this.evaluateAndMaybeExecute({
      tool: 'notifications.send',
      arguments: notificationArgs,
      requestedBy: 'agent:evaluateEvent',
      requestText: `email.received from ${event.data?.from}`,
      reasoningSummary,
      correlationId,
      actor,
    });
    return { decision: 'notify', eventType: event.type, outcome, feedbackAdjustment };
  }

  // calendar.event_approaching -> prepare: generate a before-meeting
  // dashboard (reusing the existing Phase 2 dashboard-planner, never
  // reimplemented) and attach it to a dismissible recommendation.
  async _evaluateCalendarApproaching(event, { correlationId, actor }) {
    const eventId = event.data?.eventId || event.subject?.id;
    const calendarEvent = eventId ? getCachedCalendarEvent(eventId) : null;

    let dashboard = null;
    let personId = null;
    let reasoningSummary = `Meeting ${eventId} is approaching (${event.data?.minutesUntil ?? '?'} minute(s) out).`;

    if (calendarEvent) {
      const firstAttendee = (calendarEvent.attendees || [])[0];
      const attendeeName = typeof firstAttendee === 'string' ? firstAttendee : firstAttendee?.name;
      if (attendeeName) {
        const [person] = findEntities({ type: 'Person', query: attendeeName });
        if (person) personId = person.id;
      }
    }

    if (personId) {
      try {
        dashboard = this.generateDashboard({ context: 'before-meeting', params: { personId } });
        reasoningSummary += ' Generated a before-meeting dashboard.';
      } catch (err) {
        reasoningSummary += ` Could not generate a before-meeting dashboard: ${err.message}.`;
      }
    } else {
      reasoningSummary += ' No matching Person entity found for the meeting attendee; recommendation has no dashboard attached.';
    }

    const recommendation = createRecommendation({
      decision: 'prepare',
      eventType: event.type,
      eventId,
      reasoningSummary,
      dashboard,
      correlationId,
    });

    // No tool was called (dashboard generation isn't a tool), so this is
    // the bookkeeping event for this decision -- still visible in the
    // activity feed like everything else (PROMPT.md §14).
    this.eventBus.publish({
      type: 'agent.action.completed',
      source: 'agent',
      actor,
      subject: { type: 'recommendation', id: recommendation.id },
      data: { decision: 'prepare', eventType: event.type, recommendationId: recommendation.id },
      metadata: { correlationId, provenance: 'agent:evaluateEvent' },
    });

    return { decision: 'prepare', eventType: event.type, recommendation };
  }

  // task.overdue -> notify.
  async _evaluateTaskOverdue(event, { correlationId, actor }) {
    const title = event.data?.title || 'a task';
    const outcome = await this.evaluateAndMaybeExecute({
      tool: 'notifications.send',
      arguments: {
        title: 'Overdue task',
        body: `"${title}" was due ${event.data?.dueAt || 'earlier'} and is still open.`,
        priority: 'normal',
      },
      requestedBy: 'agent:evaluateEvent',
      requestText: `task.overdue: ${title}`,
      reasoningSummary: `Task "${title}" is overdue.`,
      correlationId,
      actor,
    });
    return { decision: 'notify', eventType: event.type, outcome };
  }

  // commitment.made -> act: auto-create the linked task (ties into
  // memory/projector.js's detectAndRecordCommitment). Skips if a task
  // already exists for this commitment (the seed trigger's own "IF no task
  // exists" condition, enforced here since event_rule's `when` clause can't
  // express a cross-table existence check).
  async _evaluateCommitmentMade(event, { correlationId, actor }) {
    const commitmentId = event.subject?.id;
    const description = event.data?.description;

    if (!description) {
      return { decision: 'ignore', eventType: event.type, reason: 'commitment.made event carried no description.' };
    }

    if (commitmentId) {
      const existingTasks = tasksProvider.listTasks({}).filter((t) => t.related_entity_id === commitmentId);
      if (existingTasks.length) {
        return {
          decision: 'ignore',
          eventType: event.type,
          reason: `A task already exists for this commitment (${existingTasks[0].id}).`,
        };
      }
    }

    // This is a PROPOSAL through the same policy-gated pipeline as
    // everything else -- the policy engine still decides whether
    // tasks.create actually executes autonomously or needs approval.
    const outcome = await this.evaluateAndMaybeExecute({
      tool: 'tasks.create',
      arguments: { title: description, relatedEntityId: commitmentId },
      requestedBy: 'agent:evaluateEvent',
      requestText: `commitment.made: ${description}`,
      reasoningSummary: `Auto-creating a task for the commitment "${description}".`,
      correlationId,
      actor,
    });
    return { decision: 'act', eventType: event.type, outcome };
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

      // Phase 7 / docs/feedback.md: best-effort auto-detected "edited before
      // send" feedback. See server/feedback/email-edit-detector.js for
      // exactly what this can and can't catch -- it never affects whether
      // this send executed (that already happened, above), only whether a
      // feedback_events row gets written for later prioritization.
      if (tool.name === 'email.send') {
        try {
          detectEmailEdit({ actionId, correlationId, args, eventBus: this.eventBus });
        } catch (err) {
          console.error('[agent] email edit-detection failed', err);
        }
      }

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
