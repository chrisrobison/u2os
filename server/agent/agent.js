import { newId } from '../db/ids.js';
import { detectAndRecordCommitment } from '../memory/projector.js';
import { generateDashboard as buildDashboard } from './dashboard-planner.js';
import { applyVoiceAuthorization } from '../voice/authorize.js';
import { ContextAssembler } from './context-assembler.js';
import { Planner } from './planner.js';
import { ActionEvaluator } from './action-evaluator.js';
import { ActionExecutor } from './action-executor.js';
import { ApprovalManager } from './approval-manager.js';
import { EvaluatorRegistry } from './proactive/evaluator-registry.js';
import { registerBuiltinEvaluators } from './proactive/builtin-evaluators.js';
import { proposeMemoryCandidate } from '../memory/candidate-store.js';

/**
 * Agent: the orchestrator. It does not itself plan, evaluate policy,
 * execute tools, or own approval state -- it composes the focused services
 * that do (see docs/architecture.md's "Agent responsibility extraction"):
 *
 *   ContextAssembler  -- bounded context for a planning request
 *   Planner           -- objective + context -> structured candidate plan
 *   ActionEvaluator    -- tool resolution + authoritative policy context + decision
 *   ActionExecutor     -- executes an already-authorized tool, records outcome
 *   ApprovalManager    -- pending-approval lifecycle (create/get/approve/reject)
 *   EvaluatorRegistry  -- proactive per-event-type decision logic
 *
 * NEVER call a tool directly without going through
 * evaluateAndMaybeExecute() -- that is the one gate every consequential
 * action must pass through, regardless of which service proposed it.
 */
export class Agent {
  constructor({ modelProvider, modelRouter, policyEngine, toolRegistry, eventBus, ownerEntityId = null, evaluatorRegistry, embeddingProvider = null, dataProcessingPolicy } = {}) {
    this.modelProvider = modelProvider;
    this.modelRouter = modelRouter;
    this.policyEngine = policyEngine;
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.ownerEntityId = ownerEntityId;

    this.contextAssembler = new ContextAssembler({ toolRegistry, eventBus, ownerEntityId, embeddingProvider });
    this.planner = new Planner({ modelProvider, modelRouter, role: 'planner', dataProcessingPolicy });
    this.actionEvaluator = new ActionEvaluator({ toolRegistry, policyEngine });
    this.actionExecutor = new ActionExecutor({ eventBus });
    this.approvalManager = new ApprovalManager({ eventBus, actionEvaluator: this.actionEvaluator, actionExecutor: this.actionExecutor });
    this.evaluatorRegistry = evaluatorRegistry || registerBuiltinEvaluators(new EvaluatorRegistry());
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
    const planContext = await this.contextAssembler.assemble({ correlationId, actor, objective: text });

    this.eventBus.publish({
      type: 'agent.message.received',
      source: 'user',
      actor,
      data: { text },
      metadata: { correlationId, provenance: 'user:message' },
    });

    const plan = await this.planner.plan(planContext, text);
    // Explainability (PLAN.md Phase 9): the retrieved-memory-item ids that
    // actually reached the provider which produced THIS plan (after
    // data-processing filtering) -- attached to every action's audit row
    // below so a later "why did U2OS do this" view can point at exactly
    // what informed it, not just the model's own prose.
    const contextProvenance = this.planner.lastProvenanceRefs || [];
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
        contextProvenance,
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

    // A model may propose candidate facts worth remembering (plan-validator.js's
    // validated `memoryCandidates`). This ONLY records what was proposed, for
    // later review -- it is NOT a memory write. Promoting a candidate into an
    // established fact (with its own provenance/confidence) is a separate,
    // explicit step; a plan can never silently become "established truth".
    if (Array.isArray(plan.memoryCandidates)) {
      for (const [index, candidate] of plan.memoryCandidates.entries()) {
        const stored = proposeMemoryCandidate({ content: candidate.content, confidence: candidate.confidence, correlationId, proposedBy: actorId });
        this.eventBus.publish({
          type: 'agent.memory_candidate.proposed',
          source: 'agent',
          actor,
          subject: { type: 'memory_candidate', id: stored.id },
          data: { candidateId: stored.id, content: candidate.content, confidence: candidate.confidence || null, index },
          metadata: { correlationId, provenance: 'agent:plan' },
        });
      }
    }

    return {
      correlationId,
      reasoning_summary: plan.reasoning_summary,
      actions: results,
      pendingActionIds,
      ...(plan.response !== undefined ? { response: plan.response } : {}),
      ...(plan.memoryCandidates !== undefined ? { memoryCandidates: plan.memoryCandidates } : {}),
    };
  }

  /**
   * Public so other entry points (e.g. POST /api/tasks) can route a direct,
   * non-chat request through the same policy-gated, audited pipeline instead
   * of calling a tool directly -- "policy gates everything consequential"
   * applies regardless of which HTTP route triggered it.
   */
  async evaluateAndMaybeExecute({ tool: toolName, arguments: args, requestedBy, requestText, reasoningSummary, correlationId, actor, voice, contextProvenance }) {
    const tool = this.actionEvaluator.resolve(toolName);
    const rawEvaluation = this.actionEvaluator.evaluate({ tool, arguments: args });
    // Additive-only voice gate (server/voice/authorize.js): a no-op unless
    // `voice` is present, and even then only ever tightens `rawEvaluation`,
    // never loosens it. The audit row records the (possibly voice-adjusted)
    // policyRule/requiresApproval, so a voice-forced approval is always
    // inspectable in the audit trail, never silent.
    const evaluation = applyVoiceAuthorization({ evaluation: rawEvaluation, voice });

    const auditRow = this.approvalManager.recordDecision({
      tool,
      arguments: args,
      requestedBy,
      requestText,
      model: this._describeModel(),
      reasoningSummary,
      evaluation,
      correlationId,
      actor,
      contextProvenance,
    });

    if (evaluation.blocked) {
      return { id: auditRow.id, status: 'blocked', tool: toolName, arguments: args, reason: evaluation.reason };
    }
    if (evaluation.requiresApproval) {
      return { id: auditRow.id, status: 'pending', tool: toolName, arguments: args, reason: evaluation.reason };
    }
    return this.actionExecutor.execute(auditRow.id, tool, args, { correlationId, actor });
  }

  /**
   * PROMPT.md §9 / docs/automation.md's proactive agent. Given an event
   * (from the trigger engine's 'evaluate' action, or any other caller),
   * looks up the registered EvaluatorRegistry entry for its type and
   * delegates the ignore|remember|notify|recommend|prepare|
   * request_approval|act decision to it.
   *
   * NON-NEGOTIABLE INVARIANT: an evaluator's decision is a PROPOSAL, never a
   * bypass. Every side effect that touches a tool goes through
   * evaluateAndMaybeExecute() (wired in as `context.proposeAction` below) --
   * the exact same policy-gated, audited pipeline chat/voice messages use.
   *
   * An event type with no registered evaluator is a documented gap, not a
   * silent one: it returns 'ignore' rather than crashing or doing something
   * undocumented.
   */
  async evaluateEvent(event, context = {}) {
    const correlationId = context.correlationId || event.correlationId || newId('corr');
    const actor = context.actor || { type: 'agent', id: 'agent_default' };

    const evaluator = this.evaluatorRegistry.find(event.type);
    if (!evaluator) {
      return {
        decision: 'ignore',
        eventType: event.type,
        reason: 'No evaluateEvent rule wired for this event type yet (documented gap -- see docs/automation.md).',
      };
    }

    const evalContext = {
      correlationId,
      actor,
      eventBus: this.eventBus,
      ownerEntityId: this.ownerEntityId,
      proposeAction: (proposal) => this.evaluateAndMaybeExecute({ ...proposal, correlationId, actor }),
      generateDashboard: (args) => this.generateDashboard(args),
    };
    return evaluator.evaluate(event, evalContext);
  }

  // Identifies which provider is recorded in the agent_actions audit trail
  // for a given proposal. After a handleMessage() call, Planner.lastProviderId
  // reflects the provider that actually produced that specific plan
  // (including a fallback if one was used). Actions proposed outside a
  // plan() call (e.g. evaluateEvent()'s builtin evaluators, or a direct
  // evaluateAndMaybeExecute() call from an HTTP route) fall back to
  // whichever provider the planner role currently resolves to -- a
  // representative "currently configured model" identifier, not a claim
  // that the model itself decided this specific action.
  _describeModel() {
    if (this.planner.lastProviderId) return this.planner.lastProviderId;
    if (this.modelRouter) {
      try {
        return this.modelRouter.resolve('planner').id;
      } catch {
        // fall through to unknown -- misconfiguration must never crash audit logging.
      }
    }
    return this.modelProvider?.id || this.modelProvider?.name || 'unknown-model-provider';
  }

  async approveAction(id, approvedBy) {
    return this.approvalManager.approve(id, approvedBy);
  }

  async rejectAction(id, rejectedBy) {
    return this.approvalManager.reject(id, rejectedBy);
  }
}
