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
import { enqueueAction, cancelUnstartedAction } from './action-queue-store.js';
import { EvaluatorRegistry } from './proactive/evaluator-registry.js';
import { registerBuiltinEvaluators } from './proactive/builtin-evaluators.js';
import { proposeMemoryCandidate } from '../memory/candidate-store.js';
import { captureAccountBinding } from '../integrations/provider-registry.js';
import { accountDomainForAction, assertCalendarTarget, captureSmtpIdentity } from './account-binding.js';
import * as defaultRunStore from './run-store.js';
import { resolveActionReferences } from './result-references.js';
import { validatePlan } from './plan-validator.js';
import { getAgentAction, updateAgentAction } from '../policy/policy-engine.js';

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
    const runId = this.runStore.createRun({ correlationId, actorId, objective: text, voice });
    try {
      return await this._handleRunMessage({ text, actorId, voice, correlationId, actor, runId });
    } catch (error) {
      this.runStore.failRun(runId);
      throw error;
    }
  }

  async _handleRunMessage({ text, actorId, voice, correlationId, actor, runId, resume = false, previousObservations = [], previousResults = [], previousAttempted = new Set() }) {
    const planContext = await this.contextAssembler.assemble({ correlationId, actor, objective: text });

    if (!resume) this.eventBus.publish({
      type: 'agent.message.received', source: 'user', actor, data: { text },
      metadata: { correlationId, provenance: 'user:message' },
    });

    let plan = resume ? { reasoning_summary: this.runStore.getRunExecution(runId)?.run.reasoning_summary || '' } : null;
    let acceptedPlan;
    let stopReason = null;
    const results = [...previousResults];
    const pendingActionIds = [];
    const observations = [...previousObservations];
    const memoryCandidates = [];
    const attempted = new Set(previousAttempted);

    for (let round = resume ? this.runStore.getModelCallCount(runId) : 0; round < MAX_MODEL_CALLS_PER_MESSAGE; round++) {
      if (this.runStore.isCancellationRequested(runId)) {
        stopReason = 'Run cancellation requested. No further planning or new actions were started.';
        this.runStore.clearContinuation(runId);
        break;
      }
      const budgetBeforeModel = this.runStore.getBudgetStopReason?.(runId);
      if (budgetBeforeModel) {
        this.runStore.markBudgetExhausted(runId, budgetBeforeModel);
        stopReason = `Run budget exhausted (${budgetBeforeModel}); no new model call was started. The objective is not verified.`;
        break;
      }
      if (round > 0 && this.runStore.getModelCallCount?.(runId) >= MAX_MODEL_CALLS_PER_MESSAGE) {
        stopReason = 'Continuation stopped at the model-call limit. The objective is not verified.';
        this.runStore.clearContinuation(runId);
        break;
      }
      let proposedPlan;
      try {
        proposedPlan = await this.planner.plan({ ...planContext, observations, onModelCall: () => this.runStore.beginModelCall(runId, MAX_MODEL_CALLS_PER_MESSAGE) }, text);
      } catch (error) {
        if (error.code !== 'RUN_BUDGET_EXHAUSTED') throw error;
        this.runStore.markBudgetExhausted(runId, error.reason);
        stopReason = `Run budget exhausted (${error.reason}); no new model call was started. The objective is not verified.`;
        break;
      }
      if (this.runStore.isCancellationRequested(runId)) {
        stopReason = 'Run cancellation requested. The in-flight model result was discarded before any new action.';
        this.runStore.clearContinuation(runId);
        break;
      }
      const budgetAfterModel = this.runStore.getBudgetStopReason?.(runId);
      if (budgetAfterModel) {
        this.runStore.markBudgetExhausted(runId, budgetAfterModel);
        stopReason = `Run budget exhausted (${budgetAfterModel}); the late model result was discarded. The objective is not verified.`;
        break;
      }
      plan = validatePlan(proposedPlan, this.toolRegistry);
      if (round > 0 && observations.length && !(this.planner.lastAllowedObservations || []).some((observation) => observation.items.length)) {
        stopReason = 'Continuation stopped: the configured model cannot receive the required observations under the current privacy policy. The objective is not verified.';
        plan = acceptedPlan || plan;
        this.runStore.clearContinuation(runId);
        break;
      }
      // Provenance is specific to the provider that produced this plan,
      // after destination-aware filtering (including any fallback).
      const contextProvenance = this.planner.lastProvenanceRefs || [];
      // Reject an unverified reference anywhere in this plan before the
      // first step can cause an external effect or request approval.
      const resolvedActions = plan.actions.map((action) => resolveActionReferences(
        action, this.planner.lastAllowedObservations || [], this.toolRegistry, { continuation: round > 0 },
      ));
      const accountContexts = resolvedActions.map((action) => captureProposedAccount(action.tool, action.arguments));
      const baseIndex = this.runStore.recordRunPlan(runId, { ...plan, actions: resolvedActions }, contextProvenance, accountContexts, this._describeModel());
      acceptedPlan = plan;
      const roundResults = [];
      const observedBefore = observations.length;

      for (const [index, proposed] of resolvedActions.entries()) {
        const stepIndex = baseIndex + index;
        if (this.runStore.isCancellationRequested(runId)) {
          const stopped = { status: 'cancelled', tool: proposed.tool, arguments: proposed.arguments, reason: 'Run cancelled before this step was attempted' };
          results.push(stopped); roundResults.push(stopped);
          this.runStore.recordRunStepOutcome(runId, stepIndex, 'cancelled');
          continue;
        }
        const budgetBeforeStep = this.runStore.getBudgetStopReason?.(runId);
        if (budgetBeforeStep) {
          this.runStore.markBudgetExhausted(runId, budgetBeforeStep);
          const stopped = { status: 'budget_exhausted', tool: proposed.tool, arguments: proposed.arguments, reason: budgetBeforeStep };
          results.push(stopped); roundResults.push(stopped);
          stopReason = `Run budget exhausted (${budgetBeforeStep}); no further step was started. The objective is not verified.`;
          continue;
        }
        const unmet = (proposed.dependsOn || []).filter((dependency) => roundResults[dependency]?.status !== 'executed');
        if (unmet.length) {
          const waiting = unmet.some((dependency) => ['pending', 'waiting_dependency', 'waiting_for_action', 'retrying', 'queued', 'uncertain', 'outcome_uncertain'].includes(roundResults[dependency]?.status));
          const status = waiting ? 'waiting_dependency' : 'skipped';
          const deferred = {
            status, tool: proposed.tool, arguments: proposed.arguments || {}, dependsOn: proposed.dependsOn,
            unmetDependencies: unmet.map((dependency) => ({ index: baseIndex + dependency, status: roundResults[dependency]?.status || 'unknown', actionId: roundResults[dependency]?.id || null })),
            reason: waiting ? 'Waiting for prerequisite action; no attempt was made' : 'Prerequisite action did not complete successfully; no attempt was made',
          };
          results.push(deferred); roundResults.push(deferred);
          this.runStore.recordRunStepOutcome(runId, stepIndex, status);
          continue;
        }
        const signature = JSON.stringify([proposed.tool, canonicalArguments(proposed.arguments)]);
        if (attempted.has(signature)) {
          const skipped = { status: 'skipped', tool: proposed.tool, arguments: proposed.arguments, reason: 'Repeated action made no progress; no attempt was made' };
          results.push(skipped); roundResults.push(skipped);
          this.runStore.recordRunStepOutcome(runId, stepIndex, 'skipped');
          continue;
        }
        attempted.add(signature);
        let actionId;
        try { actionId = this.runStore.beginRunStep(runId, stepIndex); }
        catch (error) {
          if (error.code !== 'RUN_BUDGET_EXHAUSTED') throw error;
          this.runStore.markBudgetExhausted(runId, error.reason);
          const stopped = { status: 'budget_exhausted', tool: proposed.tool, arguments: proposed.arguments, reason: error.reason };
          results.push(stopped); roundResults.push(stopped);
          stopReason = `Run budget exhausted (${error.reason}); no further step was started. The objective is not verified.`;
          continue;
        }
        const outcome = await this.evaluateAndMaybeExecute({
          actionId, tool: proposed.tool, arguments: proposed.arguments, requestedBy: actorId,
          requestText: text, reasoningSummary: plan.reasoning_summary, correlationId,
          actor, voice, contextProvenance, accountContext: accountContexts[index], modelIdentity: this._describeModel(), runId,
        });
        results.push(outcome); roundResults.push(outcome);
        this.runStore.recordRunStepOutcome(runId, stepIndex, outcome.status);
        if (outcome.status === 'pending') pendingActionIds.push(outcome.id);
        if (outcome.status === 'executed') {
          observations.push({ stepIndex, tool: proposed.tool, actionId: outcome.id, status: 'executed', result: outcome.result });
        }
      }
      if (Array.isArray(plan.memoryCandidates)) memoryCandidates.push(...plan.memoryCandidates);
      if (plan.continue !== true) break;
      if (!roundResults.length || roundResults.some((outcome) => outcome.status !== 'executed') || observations.length === observedBefore) {
        const resumable = roundResults.length > 0 && roundResults.every((outcome) => ['executed', 'pending', 'waiting_dependency', 'waiting_for_action', 'retrying', 'queued'].includes(outcome.status));
        if (!resumable) {
          this.runStore.clearContinuation(runId);
        }
        stopReason = `Continuation ${resumable ? 'paused' : 'stopped'}: prerequisites did not all complete. Review the action statuses; the objective is not verified.`;
        break;
      }
      if (round === MAX_MODEL_CALLS_PER_MESSAGE - 1) {
        stopReason = 'Continuation stopped at the model-call limit. The objective is not verified.';
        this.runStore.clearContinuation(runId);
      }
    }

    if (!resume && !this.runStore.isCancellationRequested(runId) && this.ownerEntityId) {
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
    if (memoryCandidates.length && !this.runStore.isCancellationRequested(runId)) {
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
    const cancelled = this.runStore.isCancellationRequested(runId);
    const response = cancelled
      ? 'Run cancellation requested. No further steps were started; check run status for any in-flight or uncertain action.'
      : stopReason ? `${stopReason}${incompleteResponse ? ` ${incompleteResponse}` : ''}` : incompleteResponse || plan?.response;
    this.runStore.finishRun(runId, response);
    return {
      runId,
      correlationId,
      reasoning_summary: plan?.reasoning_summary,
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
  async evaluateAndMaybeExecute({ actionId, tool: toolName, arguments: args, requestedBy, requestText, reasoningSummary, correlationId, actor, voice, contextProvenance, accountContext, modelIdentity, runId }) {
    const tool = this.actionEvaluator.resolve(toolName);
    const rawEvaluation = this.actionEvaluator.evaluate({ tool, arguments: args });
    const accountState = accountContext === undefined ? captureProposedAccount(toolName, args) : accountContext;
    const accountBinding = accountState?.binding || null;
    const bindingError = accountState?.error || null;
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
      model: modelIdentity || this._describeModel(),
      reasoningSummary,
      evaluation,
      correlationId,
      actor,
      contextProvenance,
      accountBinding,
    });

    if (runId && this.runStore.isCancellationRequested(runId)) {
      updateAgentAction(auditRow.id, { status: 'cancelled', result: { error: 'Run cancelled before execution' } });
      return { id: auditRow.id, status: 'cancelled', tool: toolName, arguments: args, reason: 'Run cancelled before execution', accountBinding };
    }

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
    const linked = this.runStore.findRunByAction(id);
    if (linked && this.runStore.isCancellationRequested(linked)) throw new Error('Run was cancelled; approval is no longer valid');
    if (linked && getAgentAction(id)?.status === 'pending' && this.runStore.isRunDeadlineExpired(linked)) {
      updateAgentAction(id, { status: 'blocked', result: { error: 'Run elapsed-time budget expired before approval' } });
      this.runStore.markBudgetExhausted(linked, 'elapsed_limit');
      return { id, status: 'blocked', reason: 'Run elapsed-time budget expired before approval' };
    }
    const result = await this.approvalManager.approve(id, approvedBy);
    await this._wakeLinkedRun(id);
    return result;
  }

  async rejectAction(id, rejectedBy) {
    const result = await this.approvalManager.reject(id, rejectedBy);
    await this._wakeLinkedRun(id);
    return result;
  }

  async _wakeLinkedRun(actionId) {
    const runId = this.runStore.findRunByAction(actionId);
    if (!runId) return;
    try {
      await this.resumeRunDependents(runId);
      await this.resumeRunPlanning(runId);
    }
    catch {
      // Approval/rejection has already committed. Keep its response truthful;
      // the owner can inspect and retry the still-durable waiting run.
      console.error('[agent] dependent run wake failed; inspect the run and retry safely');
    }
  }

  /** Owner-triggered or approval-triggered wake of already-validated steps.
   * Never calls a model or replays an action with an assigned action ID. */
  async resumeRunDependents(runId) {
    const execution = this.runStore.getRunExecution(runId);
    if (!execution) return null;
    const { run, steps } = execution;
    if (!steps.some((step) => step.status === 'waiting_dependency')) return this.runStore.getRun(runId);
    for (const step of steps) {
      if (step.status !== 'waiting_dependency') continue;
      if (this.runStore.isCancellationRequested(runId)) {
        this.runStore.recordRunStepOutcome(runId, step.step_index, 'cancelled');
        continue;
      }
      const budgetReason = this.runStore.getBudgetStopReason?.(runId);
      if (budgetReason) {
        this.runStore.markBudgetExhausted(runId, budgetReason);
        break;
      }
      const current = this.runStore.getRun(runId);
      const dependencies = JSON.parse(step.depends_on).map((index) => current.steps.find((item) => item.index === index));
      if (dependencies.some((item) => !item)) continue;
      if (dependencies.some((item) => ['rejected', 'blocked', 'failed', 'cancelled', 'skipped', 'needs_attention'].includes(item.status))) {
        this.runStore.recordRunStepOutcome(runId, step.step_index, 'skipped');
        continue;
      }
      if (dependencies.some((item) => item.status !== 'executed')) continue;
      const args = JSON.parse(step.arguments);
      const duplicate = this.runStore.getRunExecution(runId).steps.some((prior) => prior.step_index < step.step_index
        && prior.tool === step.tool && prior.status !== 'waiting_dependency' && prior.status !== 'skipped'
        && JSON.stringify(canonicalArguments(JSON.parse(prior.arguments))) === JSON.stringify(canonicalArguments(args)));
      if (duplicate) {
        this.runStore.recordRunStepOutcome(runId, step.step_index, 'skipped');
        continue;
      }
      // Atomic claim ensures duplicate owner/event wakes cannot execute twice.
      let actionId;
      try { actionId = this.runStore.beginRunStep(runId, step.step_index); }
      catch { continue; }
      const outcome = await this.evaluateAndMaybeExecute({
        actionId, tool: step.tool, arguments: args, requestedBy: run.actor_id,
        requestText: run.objective, reasoningSummary: run.reasoning_summary,
        correlationId: run.correlation_id, actor: { type: 'user', id: run.actor_id },
        voice: run.voice_confidence === null ? undefined : { confidence: run.voice_confidence },
        contextProvenance: step.context_provenance ? JSON.parse(step.context_provenance) : [],
        accountContext: step.account_context ? JSON.parse(step.account_context) : accountDomainForAction(step.tool)
          ? { binding: null, error: 'Account identity was not captured for this deferred action; replan with the selected account' } : null,
        modelIdentity: step.model_id,
        runId,
      });
      this.runStore.recordRunStepOutcome(runId, step.step_index, outcome.status);
    }
    return this.runStore.getRun(runId);
  }

  /** Resume only a checkpoint whose authoritative actions all completed.
   * The atomic claim and persisted call count bound duplicate wakes and crashes. */
  async resumeRunPlanning(runId) {
    const status = this.runStore.getRun(runId);
    if (!status || status.status !== 'ready_to_continue') return status;
    const budgetReason = this.runStore.getBudgetStopReason?.(runId);
    if (budgetReason) return this.runStore.markBudgetExhausted(runId, budgetReason);
    if (status.modelCalls >= MAX_MODEL_CALLS_PER_MESSAGE) {
      this.runStore.clearContinuation(runId);
      this.runStore.finishRun(runId, 'Continuation stopped at the model-call limit. The objective is not verified.');
      return this.runStore.getRun(runId);
    }
    if (!this.runStore.claimContinuation(runId)) return this.runStore.getRun(runId);
    const { run, steps } = this.runStore.getRunExecution(runId);
    const observations = [];
    const results = [];
    const attempted = new Set();
    try {
      for (const step of steps) {
        const action = getAgentAction(step.action_id);
        if (!action || action.status !== 'executed') {
          this.runStore.failRun(runId, 'Continuation needs owner review: a recorded prerequisite has no confirmed result. No action was replayed.');
          return this.runStore.getRun(runId);
        }
        const args = JSON.parse(step.arguments);
        attempted.add(JSON.stringify([step.tool, canonicalArguments(args)]));
        observations.push({ stepIndex: step.step_index, tool: step.tool, actionId: step.action_id, status: 'executed', result: action.result });
        results.push({ id: step.action_id, tool: step.tool, arguments: args, status: 'executed', result: action.result });
      }
      await this._handleRunMessage({
        text: run.objective, actorId: run.actor_id, correlationId: run.correlation_id,
        actor: { type: 'user', id: run.actor_id },
        voice: run.voice_confidence === null ? undefined : { confidence: run.voice_confidence },
        runId, resume: true, previousObservations: observations, previousResults: results, previousAttempted: attempted,
      });
    } catch {
      this.runStore.failRun(runId, 'Continuation failed during planning. Completed actions were not replayed; review the run before giving a new instruction.');
    }
    return this.runStore.getRun(runId);
  }

  async cancelRun(runId, cancelledBy) {
    const requested = this.runStore.requestRunCancellation(runId, cancelledBy);
    if (!requested) return null;
    if (!requested.cancellationRequested) return requested;
    const execution = this.runStore.getRunExecution(runId);
    for (const step of execution.steps) {
      if (!step.action_id) continue;
      const action = getAgentAction(step.action_id);
      if (action?.status === 'pending') {
        try { await this.approvalManager.reject(step.action_id, cancelledBy); }
        catch { /* An approval may already have won; inspect its queue below. */ }
      }
      cancelUnstartedAction(step.action_id);
    }
    return this.runStore.getRun(runId);
  }
}

function captureProposedAccount(toolName, args) {
  const domain = accountDomainForAction(toolName);
  if (!domain) return null;
  try {
    const binding = captureAccountBinding(domain);
    if (toolName === 'email.send' && binding.providerId === 'imap') binding.smtpIdentity = captureSmtpIdentity(binding);
    if (toolName === 'calendar.reschedule') assertCalendarTarget(binding, args?.eventId);
    return { binding, error: null };
  } catch (error) {
    return { binding: null, error: error.message };
  }
}

function summarizeIncompleteActions(results) {
  const incomplete = results.filter((result) => result.status !== 'executed');
  if (!incomplete.length) return null;
  const completed = results.length - incomplete.length;
  const pending = incomplete.filter((result) => result.status === 'pending');
  const notAttempted = incomplete.filter((result) => ['skipped', 'blocked', 'rejected', 'waiting_dependency'].includes(result.status));
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
