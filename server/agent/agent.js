import { newId } from '../db/ids.js';
import { detectAndRecordCommitment } from '../memory/projector.js';
import { generateDashboard as buildDashboard } from './dashboard-planner.js';
import { applyVoiceAuthorization } from '../voice/authorize.js';
import { ContextAssembler } from './context-assembler.js';
import { Planner } from './planner.js';
import { ActionEvaluator } from './action-evaluator.js';
import { ActionExecutor } from './action-executor.js';
import { ApprovalManager } from './approval-manager.js';
import { ActionQueueWorker } from './action-queue-worker.js';
import { enqueueAction } from './action-queue-store.js';
import { EvaluatorRegistry } from './proactive/evaluator-registry.js';
import { registerBuiltinEvaluators } from './proactive/builtin-evaluators.js';
import { proposeMemoryCandidate } from '../memory/candidate-store.js';
import { captureAccountBinding } from '../integrations/provider-registry.js';
import { accountDomainForAction, assertCalendarTarget, captureSmtpIdentity } from './account-binding.js';
import * as defaultRunStore from './run-store.js';
import { resolveActionReferences } from './result-references.js';

const MAX_MODEL_CALLS_PER_MESSAGE = 3;

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
  constructor({ modelProvider, modelRouter, policyEngine, toolRegistry, eventBus, ownerEntityId = null, evaluatorRegistry, embeddingProvider = null, dataProcessingPolicy, runStore = defaultRunStore } = {}) {
    this.modelProvider = modelProvider;
    this.modelRouter = modelRouter;
    this.policyEngine = policyEngine;
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.ownerEntityId = ownerEntityId;
    this.runStore = runStore;

    this.contextAssembler = new ContextAssembler({ toolRegistry, eventBus, ownerEntityId, embeddingProvider, dataProcessingPolicy });
    this.planner = new Planner({ modelProvider, modelRouter, role: 'planner', dataProcessingPolicy });
    this.actionEvaluator = new ActionEvaluator({ toolRegistry, policyEngine });
    this.actionExecutor = new ActionExecutor({ eventBus });
    this.actionQueueWorker = new ActionQueueWorker({ actionEvaluator: this.actionEvaluator, actionExecutor: this.actionExecutor, eventBus });
    this.approvalManager = new ApprovalManager({ eventBus, actionEvaluator: this.actionEvaluator, actionQueueWorker: this.actionQueueWorker });
    this.evaluatorRegistry = evaluatorRegistry || registerBuiltinEvaluators(new EvaluatorRegistry());
  }

  setOwnerEntityId(id) {
    this.ownerEntityId = id;
    this.contextAssembler.ownerEntityId = id;
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
  // existing text-chat path (POST /api/agent/message), which must preserve
  // the same authorization behavior. Only POST /api/agent/voice-message
  // ever passes it. See server/voice/authorize.js for the one place it
  // actually changes anything.
  async handleMessage({ text, actorId = 'user', voice } = {}) {
    const correlationId = newId('corr');
    const actor = { type: 'user', id: actorId };
    const runId = this.runStore.createRun({ correlationId, actorId, objective: text });
    try {
      return await this._handleRunMessage({ text, actorId, voice, correlationId, actor, runId });
    } catch (error) {
      this.runStore.failRun(runId);
      throw error;
    }
  }

  async _handleRunMessage({ text, actorId, voice, correlationId, actor, runId }) {
    const planContext = await this.contextAssembler.assemble({ correlationId, actor, objective: text });

    this.eventBus.publish({
      type: 'agent.message.received',
      source: 'user',
      actor,
      data: { text },
      metadata: { correlationId, provenance: 'user:message' },
    });

    let plan;
    let acceptedPlan;
    let stopReason = null;
    const results = [];
    const pendingActionIds = [];
    const observations = [];
    const memoryCandidates = [];
    const attempted = new Set();

    for (let round = 0; round < MAX_MODEL_CALLS_PER_MESSAGE; round++) {
      if (round > 0 && this.runStore.getModelCallCount?.(runId) >= MAX_MODEL_CALLS_PER_MESSAGE) {
        stopReason = 'Continuation stopped at the model-call limit. The objective is not verified.';
        break;
      }
      plan = await this.planner.plan({ ...planContext, observations, onModelCall: () => this.runStore.beginModelCall(runId, MAX_MODEL_CALLS_PER_MESSAGE) }, text);
      if (round > 0 && observations.length && !(this.planner.lastAllowedObservations || []).some((observation) => observation.items.length)) {
        stopReason = 'Continuation stopped: the configured model cannot receive the required observations under the current privacy policy. The objective is not verified.';
        plan = acceptedPlan;
        break;
      }
      const baseIndex = this.runStore.recordRunPlan(runId, plan);
      acceptedPlan = plan;
      const roundResults = [];
      const observedBefore = observations.length;
      // Provenance is specific to the provider that produced this plan,
      // after destination-aware filtering (including any fallback).
      const contextProvenance = this.planner.lastProvenanceRefs || [];

      for (const [index, proposed] of (plan.actions || []).entries()) {
        const stepIndex = baseIndex + index;
        const unmet = (proposed.dependsOn || []).filter((dependency) => roundResults[dependency]?.status !== 'executed');
        if (unmet.length) {
          const skipped = {
            status: 'skipped', tool: proposed.tool, arguments: proposed.arguments || {}, dependsOn: proposed.dependsOn,
            unmetDependencies: unmet.map((dependency) => ({ index: baseIndex + dependency, status: roundResults[dependency]?.status || 'unknown', actionId: roundResults[dependency]?.id || null })),
            reason: 'Prerequisite action did not complete successfully; no attempt was made',
          };
          results.push(skipped); roundResults.push(skipped);
          this.runStore.recordRunStepOutcome(runId, stepIndex, 'skipped');
          continue;
        }
        const resolved = resolveActionReferences(proposed, this.planner.lastAllowedObservations || [], this.toolRegistry, { continuation: round > 0 });
        const signature = JSON.stringify([resolved.tool, canonicalArguments(resolved.arguments)]);
        if (attempted.has(signature)) {
          const skipped = { status: 'skipped', tool: resolved.tool, arguments: resolved.arguments, reason: 'Repeated action made no progress; no attempt was made' };
          results.push(skipped); roundResults.push(skipped);
          this.runStore.recordRunStepOutcome(runId, stepIndex, 'skipped');
          continue;
        }
        attempted.add(signature);
        const actionId = this.runStore.beginRunStep(runId, stepIndex);
        const outcome = await this.evaluateAndMaybeExecute({
          actionId, tool: resolved.tool, arguments: resolved.arguments, requestedBy: actorId,
          requestText: text, reasoningSummary: plan.reasoning_summary, correlationId,
          actor, voice, contextProvenance,
        });
        results.push(outcome); roundResults.push(outcome);
        this.runStore.recordRunStepOutcome(runId, stepIndex, outcome.status);
        if (outcome.status === 'pending') pendingActionIds.push(outcome.id);
        if (outcome.status === 'executed' && this.toolRegistry.get(resolved.tool).category === 'read') {
          observations.push({ stepIndex, tool: resolved.tool, actionId: outcome.id, status: 'executed', result: outcome.result });
        }
      }
      if (Array.isArray(plan.memoryCandidates)) memoryCandidates.push(...plan.memoryCandidates);
      if (plan.continue !== true) break;
      if (!roundResults.length || roundResults.some((outcome) => outcome.status !== 'executed' || this.toolRegistry.get(outcome.tool).category !== 'read') || observations.length === observedBefore) {
        stopReason = 'Continuation stopped: read-only prerequisites did not all complete. Review the action statuses; the objective is not verified.';
        break;
      }
      if (round === MAX_MODEL_CALLS_PER_MESSAGE - 1) {
        stopReason = 'Continuation stopped at the model-call limit. The objective is not verified.';
      }
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
    if (memoryCandidates.length) {
      for (const [index, candidate] of memoryCandidates.entries()) {
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

    const incompleteResponse = summarizeIncompleteActions(results);
    const response = stopReason ? `${stopReason}${incompleteResponse ? ` ${incompleteResponse}` : ''}` : incompleteResponse || plan.response;
    this.runStore.finishRun(runId, response);
    return {
      runId,
      correlationId,
      reasoning_summary: plan.reasoning_summary,
      actions: results,
      pendingActionIds,
      ...(response !== undefined ? { response } : {}),
      ...(memoryCandidates.length ? { memoryCandidates } : {}),
    };
  }

  /**
   * Public so other entry points (e.g. POST /api/tasks) can route a direct,
   * non-chat request through the same policy-gated, audited pipeline instead
   * of calling a tool directly -- "policy gates everything consequential"
   * applies regardless of which HTTP route triggered it.
   */
  async evaluateAndMaybeExecute({ actionId, tool: toolName, arguments: args, requestedBy, requestText, reasoningSummary, correlationId, actor, voice, contextProvenance }) {
    const tool = this.actionEvaluator.resolve(toolName);
    const rawEvaluation = this.actionEvaluator.evaluate({ tool, arguments: args });
    const accountDomain = accountDomainForAction(toolName);
    let accountBinding = null;
    let bindingError = null;
    if (accountDomain) {
      try {
        accountBinding = captureAccountBinding(accountDomain);
        if (toolName === 'email.send' && accountBinding.providerId === 'imap') accountBinding.smtpIdentity = captureSmtpIdentity(accountBinding);
        if (toolName === 'calendar.reschedule') assertCalendarTarget(accountBinding, args?.eventId);
      }
      catch (err) { bindingError = err.message; }
    }
    // Additive-only voice gate (server/voice/authorize.js): a no-op unless
    // `voice` is present, and even then only ever tightens `rawEvaluation`,
    // never loosens it. The audit row records the (possibly voice-adjusted)
    // policyRule/requiresApproval, so a voice-forced approval is always
    // inspectable in the audit trail, never silent.
    const voiceEvaluation = applyVoiceAuthorization({ evaluation: rawEvaluation, voice });
    const evaluation = bindingError && !voiceEvaluation.blocked
      ? { ...voiceEvaluation, blocked: true, requiresApproval: false, reason: bindingError, rule: 'account-binding' }
      : voiceEvaluation;

    const auditRow = this.approvalManager.recordDecision({
      id: actionId,
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
      accountBinding,
    });

    if (evaluation.blocked) {
      return { id: auditRow.id, status: 'blocked', tool: toolName, arguments: args, reason: evaluation.reason, accountBinding };
    }
    if (evaluation.requiresApproval) {
      return { id: auditRow.id, status: 'pending', tool: toolName, arguments: args, reason: evaluation.reason, accountBinding };
    }
    enqueueAction({
      actionId: auditRow.id,
      correlationId,
      tool: tool.name,
      arguments: args,
      actor,
      approvalReference: 'autonomous',
      policyDecisionReference: evaluation.rule,
    });
    return this.actionQueueWorker.processAction(auditRow.id);
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

function summarizeIncompleteActions(results) {
  const incomplete = results.filter((result) => result.status !== 'executed');
  if (!incomplete.length) return null;
  const completed = results.length - incomplete.length;
  const pending = incomplete.filter((result) => result.status === 'pending');
  const notAttempted = incomplete.filter((result) => ['skipped', 'blocked', 'rejected'].includes(result.status));
  const failed = incomplete.length - pending.length - notAttempted.length;
  const recipients = pending.filter((result) => result.tool === 'email.send' && typeof result.arguments?.to === 'string')
    .map((result) => result.arguments.to.slice(0, 120));
  return `${completed} action(s) completed; ${pending.length} awaiting approval${recipients.length ? ` (email to ${recipients.join(', ')})` : ''}; ${notAttempted.length} not attempted; ${failed} failed or needing attention. The objective is not verified.`;
}

function canonicalArguments(value) {
  if (Array.isArray(value)) return value.map(canonicalArguments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalArguments(value[key])]));
  }
  return value;
}
