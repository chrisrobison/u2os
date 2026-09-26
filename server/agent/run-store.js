import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { summarizeIncompleteActions, isActionSummaryResponse } from './action-result-summary.js';

const TERMINAL = new Set(['executed', 'blocked', 'failed', 'cancelled', 'rejected', 'skipped']);
export const DEFAULT_RUN_STEP_LIMIT = 16;
export const DEFAULT_RUN_ELAPSED_MS = 86_400_000;

export function createRun({ correlationId, actorId, objective, voice, conversationId = null, goalId = null, goalWakeId = null }) {
  const id = newId('run');
  const now = new Date().toISOString();
  withTransaction(getDb(), () => {
    let goalRevision = null;
    if (goalId) {
      const goal = getDb().prepare('SELECT owner_id, status, budgets, permitted_scope, revision FROM goals WHERE id = ?').get(goalId);
      if (!goal || goal.owner_id !== actorId) throw goalError(404, 'Goal not found');
      if (!['draft', 'active'].includes(goal.status)) throw goalError(409, 'Goal cannot start a run in its current state');
      if (!JSON.parse(goal.permitted_scope).domains.length) throw goalError(409, 'Select at least one intended domain before running this goal');
      const budgets = JSON.parse(goal.budgets);
      const spent = goalUsage(goalId);
      if (spent.unfinished) throw goalError(409, 'A goal run is still unfinished; inspect or resolve it before starting another');
      if (spent.runs >= budgets.maxRuns || spent.modelCalls >= budgets.maxModelCalls || spent.tokens >= budgets.maxTokens) {
        throw goalError(409, 'Goal budget exhausted; revise or review the goal before another run');
      }
      getDb().prepare("UPDATE goals SET status = 'active', updated_at = ? WHERE id = ?").run(now, goalId);
      goalRevision = goal.revision;
    }
    if (goalWakeId) {
      const consumed = getDb().prepare(`UPDATE goal_wakes SET status = 'started', run_id = ?, updated_at = ?
        WHERE id = ? AND goal_id = ? AND goal_revision = ? AND status = 'pending' AND fire_at <= ?`)
        .run(id, now, goalWakeId, goalId, goalRevision, now);
      if (consumed.changes !== 1) throw goalError(409, 'Goal wake is not due or has already been consumed');
    }
    getDb().prepare(`INSERT INTO agent_runs (id, correlation_id, actor_id, objective, conversation_id, goal_id, goal_revision, voice_confidence, deadline_at, status, output_classification, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', 'private', ?, ?)`).run(id, correlationId, actorId, objective, conversationId, goalId, goalRevision, voice ? voice.confidence : null,
        new Date(Date.now() + DEFAULT_RUN_ELAPSED_MS).toISOString(), now, now);
  });
  return id;
}

export function recordRunPlan(runId, plan, contextProvenance = [], accountContexts = [], modelId = null) {
  const db = getDb();
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    const baseIndex = db.prepare('SELECT COALESCE(MAX(step_index) + 1, 0) AS next FROM agent_run_steps WHERE run_id = ?').get(runId).next;
    const insert = db.prepare(`INSERT INTO agent_run_steps
      (run_id, step_index, tool, arguments, depends_on, context_provenance, account_context, model_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`);
    for (const [index, action] of plan.actions.entries()) {
      insert.run(runId, baseIndex + index, action.tool, JSON.stringify(action.arguments), JSON.stringify((action.dependsOn || []).map((dependency) => baseIndex + dependency)), JSON.stringify(contextProvenance), accountContexts[index] ? JSON.stringify(accountContexts[index]) : null, modelId, now, now);
    }
    db.prepare(`UPDATE agent_runs SET status = 'running', reasoning_summary = ?, continuation_after_step = ?, continuation_claimed = 0, updated_at = ? WHERE id = ?`)
      .run(plan.reasoning_summary, plan.continue === true && plan.actions.length ? baseIndex + plan.actions.length - 1 : null, now, runId);
    return baseIndex;
  });
}

export function recordOutputClassification(runId, classification) {
  // Unknown runtime metadata is restrictive, never a model-assigned downgrade.
  if (classification !== 'private') {
    getDb().prepare("UPDATE agent_runs SET output_classification = 'sensitive' WHERE id = ?").run(runId);
  }
}

export function getOutputClassification(runId) {
  return getDb().prepare('SELECT output_classification FROM agent_runs WHERE id = ?').get(runId)?.output_classification === 'private' ? 'private' : 'sensitive';
}

export function beginModelCall(runId, limit = 3) {
  withTransaction(getDb(), () => {
    const reason = getBudgetStopReason(runId);
    if (reason) throw budgetError(reason);
    const goalReason = getGoalModelCallStopReason(runId);
    if (goalReason) throw budgetError(goalReason);
    const now = new Date().toISOString();
    const changed = getDb().prepare(`UPDATE agent_runs SET model_call_count = model_call_count + 1, updated_at = ?
      WHERE id = ? AND model_call_count < ? AND status IN ('planning', 'running') AND cancel_requested_at IS NULL
      AND step_count < step_limit AND input_tokens + output_tokens < token_limit AND deadline_at > ?`)
      .run(now, runId, limit, now);
    if (changed.changes !== 1) {
      const error = new Error('Run model-call limit reached');
      error.code = 'MODEL_CALL_LIMIT';
      error.status = 429;
      throw error;
    }
  });
}

export function getModelCallCount(runId) {
  return getDb().prepare('SELECT model_call_count FROM agent_runs WHERE id = ?').get(runId)?.model_call_count ?? 0;
}

/** Meter a completed provider response before its plan can authorize effects. */
export function recordModelUsage(runId, { inputTokens, outputTokens }) {
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0 || inputTokens > 10_000_000 || outputTokens > 10_000_000) {
    const error = new Error('Invalid model usage');
    error.code = 'MODEL_USAGE_INVALID';
    throw error;
  }
  try {
    const reason = withTransaction(getDb(), () => {
      const now = new Date().toISOString();
      const changed = getDb().prepare(`UPDATE agent_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
        metered_model_calls = metered_model_calls + 1, updated_at = ?
        WHERE id = ? AND status IN ('planning', 'running') AND metered_model_calls < model_call_count`)
        .run(inputTokens, outputTokens, now, runId);
      if (changed.changes !== 1) throw new Error('Run is unavailable for model usage');
      return getBudgetStopReason(runId);
    });
    if (reason) throw budgetError(reason);
  } catch (error) {
    if (error.code === 'RUN_BUDGET_EXHAUSTED') throw error;
    const failure = new Error('Model usage could not be recorded');
    failure.code = 'MODEL_USAGE_RECORD_FAILED';
    throw failure;
  }
}

export function beginRunStep(runId, index) {
  const actionId = newId('act');
  withTransaction(getDb(), () => {
    const reason = getBudgetStopReason(runId);
    if (reason) throw budgetError(reason);
    const now = new Date().toISOString();
    const reserved = getDb().prepare(`UPDATE agent_runs SET step_count = step_count + 1, updated_at = ?
      WHERE id = ? AND step_count < step_limit AND input_tokens + output_tokens < token_limit AND deadline_at > ? AND cancel_requested_at IS NULL`).run(now, runId, now);
    if (reserved.changes !== 1) throw budgetError(getBudgetStopReason(runId) || 'run_unavailable');
    const changed = getDb().prepare(`UPDATE agent_run_steps SET status = 'running', action_id = ?, updated_at = ?
      WHERE run_id = ? AND step_index = ? AND status IN ('planned', 'waiting_dependency')`).run(actionId, now, runId, index);
    if (changed.changes !== 1) throw new Error('Run step is no longer planned');
  });
  return actionId;
}

export function getBudgetStopReason(runId, now = new Date()) {
  const row = getDb().prepare('SELECT step_count, step_limit, input_tokens, output_tokens, token_limit, deadline_at, goal_id, goal_revision FROM agent_runs WHERE id = ?').get(runId);
  if (!row) return 'run_unavailable';
  if (new Date(now).toISOString() >= row.deadline_at) return 'elapsed_limit';
  if (row.step_count >= row.step_limit) return 'step_limit';
  if (row.input_tokens + row.output_tokens >= row.token_limit) return 'token_limit';
  if (row.goal_id) {
    const goal = getDb().prepare('SELECT budgets, status, revision FROM goals WHERE id = ?').get(row.goal_id);
    if (!goal || goal.status !== 'active' || goal.revision !== row.goal_revision) return 'goal_unavailable';
    const spent = goalUsage(row.goal_id);
    const budgets = JSON.parse(goal.budgets);
    if (spent.tokens >= budgets.maxTokens) return 'goal_token_limit';
  }
  return null;
}

function getGoalModelCallStopReason(runId) {
  const row = getDb().prepare('SELECT goal_id, goal_revision FROM agent_runs WHERE id = ?').get(runId);
  if (!row?.goal_id) return null;
  const goal = getDb().prepare('SELECT budgets, status, revision FROM goals WHERE id = ?').get(row.goal_id);
  if (!goal || goal.status !== 'active' || goal.revision !== row.goal_revision) return 'goal_unavailable';
  return goalUsage(row.goal_id).modelCalls >= JSON.parse(goal.budgets).maxModelCalls ? 'goal_model_call_limit' : null;
}

function goalUsage(goalId) {
  const row = getDb().prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(model_call_count), 0) AS modelCalls,
    COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
    COALESCE(SUM(CASE WHEN status NOT IN ('completed', 'failed', 'cancelled', 'budget_exhausted') THEN 1 ELSE 0 END), 0) AS unfinished
    FROM agent_runs WHERE goal_id = ?`).get(goalId);
  return row;
}

function goalError(status, message) { const error = new Error(message); error.status = status; return error; }

export function isRunDeadlineExpired(runId) {
  const row = getDb().prepare('SELECT deadline_at FROM agent_runs WHERE id = ?').get(runId);
  return Boolean(row && new Date().toISOString() >= row.deadline_at);
}

export function markBudgetExhausted(runId, reason) {
  const now = new Date().toISOString();
  withTransaction(getDb(), () => {
    getDb().prepare(`UPDATE agent_runs SET budget_stop_reason = COALESCE(budget_stop_reason, ?),
      continuation_after_step = NULL, continuation_claimed = 0, status = 'budget_exhausted',
      response = 'Run budget exhausted. Completed or in-flight actions were not replayed; the objective is not verified.', updated_at = ?
      WHERE id = ? AND cancel_requested_at IS NULL`).run(reason, now, runId);
    getDb().prepare(`UPDATE agent_run_steps SET status = 'budget_exhausted', updated_at = ?
      WHERE run_id = ? AND action_id IS NULL AND status IN ('planned', 'waiting_dependency')`).run(now, runId);
  });
  return getRun(runId);
}

function budgetError(reason) {
  const error = new Error(`Run budget exhausted: ${reason}`);
  error.code = 'RUN_BUDGET_EXHAUSTED';
  error.reason = reason;
  return error;
}

export function getRunExecution(runId) {
  const db = getDb();
  const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const steps = db.prepare('SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
  return { run, steps };
}

export function findRunByAction(actionId) {
  return getDb().prepare('SELECT run_id FROM agent_run_steps WHERE action_id = ?').get(actionId)?.run_id ?? null;
}

export function clearContinuation(runId) {
  getDb().prepare('UPDATE agent_runs SET continuation_after_step = NULL, continuation_claimed = 0, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), runId);
}

export function claimContinuation(runId) {
  const run = getRun(runId);
  if (!run || run.status !== 'ready_to_continue') return false;
  const changed = getDb().prepare(`UPDATE agent_runs SET status = 'planning', continuation_claimed = 1, updated_at = ?
    WHERE id = ? AND status = 'ready_to_continue' AND continuation_claimed = 0 AND continuation_after_step IS NOT NULL AND cancel_requested_at IS NULL`)
    .run(new Date().toISOString(), runId);
  return changed.changes === 1;
}

export function isCancellationRequested(runId) {
  return Boolean(getDb().prepare('SELECT cancel_requested_at FROM agent_runs WHERE id = ?').get(runId)?.cancel_requested_at);
}

export function requestRunCancellation(runId, cancelledBy) {
  const status = getRun(runId);
  if (!status) return null;
  if (['completed', 'failed'].includes(status.status)) return status;
  const now = new Date().toISOString();
  withTransaction(getDb(), () => {
    getDb().prepare(`UPDATE agent_runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancelled_by = COALESCE(cancelled_by, ?),
      continuation_after_step = NULL, continuation_claimed = 0, updated_at = ? WHERE id = ?`)
      .run(now, cancelledBy, now, runId);
    getDb().prepare(`UPDATE agent_run_steps SET status = 'cancelled', updated_at = ?
      WHERE run_id = ? AND action_id IS NULL AND status IN ('planned', 'waiting_dependency')`)
      .run(now, runId);
  });
  return getRun(runId);
}

export function recordRunStepOutcome(runId, index, status) {
  getDb().prepare('UPDATE agent_run_steps SET status = ?, updated_at = ? WHERE run_id = ? AND step_index = ?')
    .run(status, new Date().toISOString(), runId, index);
}

export function finishRun(runId, response = null) {
  const db = getDb();
  const rows = db.prepare('SELECT status FROM agent_run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
  const checkpoint = db.prepare('SELECT continuation_after_step, cancel_requested_at, budget_stop_reason FROM agent_runs WHERE id = ?').get(runId);
  const status = classifyRun(rows.map((row) => row.status), checkpoint?.continuation_after_step != null, Boolean(checkpoint?.cancel_requested_at), Boolean(checkpoint?.budget_stop_reason));
  db.prepare('UPDATE agent_runs SET status = ?, response = ?, updated_at = ? WHERE id = ?')
    .run(status, response, new Date().toISOString(), runId);
  return status;
}

export function failRun(runId, response = null) {
  getDb().prepare(`UPDATE agent_runs SET status = 'failed', response = COALESCE(?, response), updated_at = ? WHERE id = ?`)
    .run(response, new Date().toISOString(), runId);
}

export function getRun(runId) {
  const db = getDb();
  const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const steps = db.prepare(`SELECT s.step_index, s.tool, s.depends_on, s.status, s.action_id,
    a.status AS action_status, a.rejected_by AS action_rejected_by, q.status AS queue_status, q.error_class AS queue_error_class,
    EXISTS (SELECT 1 FROM action_attempts attempt WHERE attempt.queue_id = q.id AND attempt.error = 'lease expired') AS expired_attempt
    FROM agent_run_steps s
    LEFT JOIN agent_actions a ON a.id = s.action_id
    LEFT JOIN action_queue q ON q.action_id = s.action_id
    WHERE s.run_id = ? ORDER BY s.step_index`).all(runId);
  const currentSteps = steps.map((step) => ({
    index: step.step_index,
    tool: step.tool,
    dependsOn: JSON.parse(step.depends_on),
    status: currentStepStatus(step),
    actionId: step.action_id,
  }));
  const now = new Date().toISOString();
  const updateStep = db.prepare('UPDATE agent_run_steps SET status = ?, updated_at = ? WHERE run_id = ? AND step_index = ?');
  for (const [position, step] of currentSteps.entries()) {
    if (step.status !== steps[position].status) updateStep.run(step.status, now, runId, step.index);
  }
  const status = (!run.cancel_requested_at && ['planning', 'running', 'failed'].includes(run.status)) || (!steps.length && !run.cancel_requested_at)
    ? run.status : classifyRun(currentSteps.map((step) => step.status), run.continuation_after_step !== null, Boolean(run.cancel_requested_at), Boolean(run.budget_stop_reason));
  if (run.status !== status) {
    db.prepare('UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, runId);
  }
  const terminalRun = ['completed', 'failed', 'cancelled', 'budget_exhausted'].includes(status);
  const usageEnd = terminalRun && run.status === status ? Date.parse(run.updated_at) : Date.now();
  return {
    id: run.id,
    goalId: run.goal_id,
    goalRevision: run.goal_revision,
    correlationId: run.correlation_id,
    status,
    objectiveStatus: run.objective_status,
    modelCalls: run.model_call_count,
    continuationReady: status === 'ready_to_continue',
    cancellationRequested: Boolean(run.cancel_requested_at),
    cancelRequestedAt: run.cancel_requested_at,
    budget: {
      stepsUsed: run.step_count,
      stepLimit: run.step_limit,
      modelCallsUsed: run.model_call_count,
      modelCallLimit: 3,
      tokens: {
        input: run.input_tokens,
        output: run.output_tokens,
        total: run.input_tokens + run.output_tokens,
        limit: run.token_limit,
        meteredCalls: run.metered_model_calls,
        complete: run.metered_model_calls === run.model_call_count,
      },
      elapsedMs: Math.max(0, usageEnd - Date.parse(run.created_at)),
      elapsedLimitMs: run.elapsed_limit_ms,
      deadlineAt: run.deadline_at,
      currentLimit: terminalRun && !run.budget_stop_reason ? null : new Date().toISOString() >= run.deadline_at ? 'elapsed_limit'
        : run.step_count >= run.step_limit ? 'step_limit'
          : run.input_tokens + run.output_tokens >= run.token_limit ? 'token_limit' : null,
      stopReason: run.budget_stop_reason,
      monetaryCost: { available: false, amount: null, currency: null },
    },
    steps: currentSteps,
    createdAt: run.created_at,
    updatedAt: run.status !== status ? now : run.updated_at,
  };
}

export function listRuns({ limit = 20 } = {}) {
  const ids = getDb().prepare('SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Math.max(Number(limit) || 20, 1), 50));
  return ids.map(({ id }) => getRun(id));
}

/** Fair, bounded reconciliation over durable waiting states. Active turns
 * and terminal runs are excluded; scan position is only an optimization. */
export function listRunWakeCandidates({ afterId = '', limit = 20 } = {}) {
  const bounded = Math.min(20, Math.max(1, Math.floor(Number(limit) || 20)));
  const db = getDb();
  const query = `SELECT id FROM agent_runs WHERE cancel_requested_at IS NULL
    AND status IN ('waiting_for_action', 'waiting_for_dependency', 'ready_to_continue', 'interrupted')`;
  const rows = db.prepare(`${query} AND id > ? ORDER BY id LIMIT ?`).all(afterId, bounded);
  return rows.length || !afterId ? rows : db.prepare(`${query} ORDER BY id LIMIT ?`).all(bounded);
}

export function getRunResult(runId) {
  const status = getRun(runId);
  if (!status) return null;
  const row = getDb().prepare('SELECT response FROM agent_runs WHERE id = ?').get(runId);
  const summary = summarizeIncompleteActions(status.steps, { always: isActionSummaryResponse(row.response) });
  const prefix = `${status.cancellationRequested ? 'Run cancellation requested. ' : ''}${status.budget.stopReason ? 'Run budget exhausted. ' : ''}`;
  return { ...status, response: summary ? `${prefix}${summary}` : row.response };
}

export function reconcileInterruptedRuns() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE agent_run_steps SET status = 'interrupted', updated_at = ?
    WHERE action_id IS NULL AND status IN ('planned', 'running')`).run(now);
  db.prepare(`UPDATE agent_runs SET status = 'interrupted', updated_at = ? WHERE status IN ('planning', 'running')`).run(now);
  db.prepare("UPDATE agent_runs SET continuation_claimed = 0 WHERE status = 'interrupted' AND continuation_after_step IS NOT NULL").run();
  const ids = db.prepare("SELECT id FROM agent_runs WHERE status IN ('interrupted', 'waiting_for_action', 'waiting_for_approval')").all();
  for (const { id } of ids) getRun(id);
}

function currentStepStatus(step) {
  if (!step.action_id) return step.status === 'running' ? 'interrupted' : step.status;
  if (!step.action_status) return 'interrupted';
  if (step.action_status === 'rejected') return 'rejected';
  if (step.action_status === 'blocked') return 'blocked';
  if (step.action_status === 'executed') return 'executed';
  if (step.queue_status === 'completed') return 'executed';
  if (['recovery_review_required', 'outcome_uncertain'].includes(step.queue_error_class) || step.action_rejected_by === 'system:recovery') return 'outcome_uncertain';
  if (step.action_status === 'cancelled' && step.expired_attempt) return 'outcome_uncertain';
  if (step.action_status === 'cancelled' && (!step.queue_status || step.queue_status === 'cancelled')) return 'cancelled';
  if (step.action_status === 'approved' && !step.queue_status) return 'needs_attention';
  if (['queued', 'leased', 'executing', 'retry_wait'].includes(step.queue_status)) return 'waiting_for_action';
  if (step.expired_attempt && (step.queue_status === 'failed' || step.queue_status === 'cancelled')) return 'outcome_uncertain';
  if (step.queue_status === 'failed' || step.queue_status === 'cancelled') return 'needs_attention';
  return step.action_status;
}

function classifyRun(statuses, hasContinuation = false, cancellationRequested = false, budgetStopped = false) {
  if (cancellationRequested) {
    if (statuses.includes('outcome_uncertain') || statuses.includes('needs_attention') || statuses.includes('interrupted')) return 'needs_attention';
    if (statuses.some((status) => ['waiting_for_action', 'approved', 'queued', 'running', 'retrying', 'pending'].includes(status))) return 'cancelling';
    return 'cancelled';
  }
  if (statuses.includes('planning') || statuses.includes('planned')) return 'running';
  if (statuses.includes('interrupted')) return 'interrupted';
  if (statuses.includes('needs_attention')) return 'needs_attention';
  if (statuses.includes('outcome_uncertain')) return 'needs_attention';
  if (budgetStopped && !statuses.some((status) => ['waiting_for_action', 'approved', 'queued', 'running', 'retrying'].includes(status))) return 'budget_exhausted';
  if (statuses.includes('waiting_for_approval') || statuses.includes('pending')) return 'waiting_for_approval';
  if (statuses.includes('waiting_dependency')) return 'waiting_for_dependency';
  if (statuses.includes('waiting_for_action') || statuses.includes('approved') || statuses.includes('queued') || statuses.includes('running') || statuses.includes('retrying')) return 'waiting_for_action';
  if (statuses.some((status) => TERMINAL.has(status) && status !== 'executed')) return 'failed';
  return hasContinuation ? 'ready_to_continue' : 'completed';
}
