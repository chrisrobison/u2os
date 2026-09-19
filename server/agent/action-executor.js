import { updateAgentAction } from '../policy/policy-engine.js';
import { detectEmailEdit } from '../feedback/email-edit-detector.js';

/**
 * ActionExecutor: executes an already-authorized tool call and records its
 * outcome. This is the ONLY place a tool's execute() is invoked from the
 * agent orchestration path. It must never call the planner and must never
 * re-decide authorization -- by the time Agent/ApprovalManager hand it a
 * (tool, args) pair, the policy decision has already been made.
 */
export class ActionExecutor {
  constructor({ eventBus }) {
    this.eventBus = eventBus;
  }

  async execute(actionId, tool, args, { correlationId, actor }) {
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
      // send" feedback. Never affects whether this send executed (that
      // already happened, above), only whether a feedback_events row gets
      // written for later prioritization.
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
