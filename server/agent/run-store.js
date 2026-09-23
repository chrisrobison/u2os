import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';

const TERMINAL = new Set(['executed', 'blocked', 'failed', 'cancelled', 'rejected', 'skipped']);

export function createRun({ correlationId, actorId, objective }) {
  const id = newId('run');
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO agent_runs (id, correlation_id, actor_id, objective, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'planning', ?, ?)`).run(id, correlationId, actorId, objective, now, now);
  return id;
}

export function recordRunPlan(runId, plan) {
  const db = getDb();
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    const baseIndex = db.prepare('SELECT COALESCE(MAX(step_index) + 1, 0) AS next FROM agent_run_steps WHERE run_id = ?').get(runId).next;
    const insert = db.prepare(`INSERT INTO agent_run_steps
      (run_id, step_index, tool, arguments, depends_on, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)`);
    for (const [index, action] of plan.actions.entries()) {
      insert.run(runId, baseIndex + index, action.tool, JSON.stringify(action.arguments), JSON.stringify((action.dependsOn || []).map((dependency) => baseIndex + dependency)), now, now);
    }
    db.prepare(`UPDATE agent_runs SET status = 'running', reasoning_summary = ?, updated_at = ? WHERE id = ?`)
      .run(plan.reasoning_summary, now, runId);
    return baseIndex;
  });
}

export function beginModelCall(runId, limit = 3) {
  const changed = getDb().prepare(`UPDATE agent_runs SET model_call_count = model_call_count + 1, updated_at = ?
    WHERE id = ? AND model_call_count < ? AND status IN ('planning', 'running')`)
    .run(new Date().toISOString(), runId, limit);
  if (changed.changes !== 1) {
    const error = new Error('Run model-call limit reached');
    error.code = 'MODEL_CALL_LIMIT';
    error.status = 429;
    throw error;
  }
}

export function getModelCallCount(runId) {
  return getDb().prepare('SELECT model_call_count FROM agent_runs WHERE id = ?').get(runId)?.model_call_count ?? 0;
}

export function beginRunStep(runId, index) {
  const actionId = newId('act');
  const changed = getDb().prepare(`UPDATE agent_run_steps SET status = 'running', action_id = ?, updated_at = ?
    WHERE run_id = ? AND step_index = ? AND status = 'planned'`).run(actionId, new Date().toISOString(), runId, index);
  if (changed.changes !== 1) throw new Error('Run step is no longer planned');
  return actionId;
}

export function recordRunStepOutcome(runId, index, status) {
  getDb().prepare('UPDATE agent_run_steps SET status = ?, updated_at = ? WHERE run_id = ? AND step_index = ?')
    .run(status, new Date().toISOString(), runId, index);
}

export function finishRun(runId, response = null) {
  const db = getDb();
  const rows = db.prepare('SELECT status FROM agent_run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
  const status = classifyRun(rows.map((row) => row.status));
  db.prepare('UPDATE agent_runs SET status = ?, response = ?, updated_at = ? WHERE id = ?')
    .run(status, response, new Date().toISOString(), runId);
  return status;
}

export function failRun(runId) {
  getDb().prepare(`UPDATE agent_runs SET status = 'failed', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), runId);
}

export function getRun(runId) {
  const db = getDb();
  const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const steps = db.prepare(`SELECT s.step_index, s.tool, s.depends_on, s.status, s.action_id,
    a.status AS action_status, q.status AS queue_status,
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
  const status = ['planning', 'running', 'failed'].includes(run.status) || !steps.length ? run.status : classifyRun(currentSteps.map((step) => step.status));
  if (run.status !== status) {
    db.prepare('UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, runId);
  }
  return {
    id: run.id,
    correlationId: run.correlation_id,
    status,
    objectiveStatus: run.objective_status,
    modelCalls: run.model_call_count,
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

export function reconcileInterruptedRuns() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE agent_run_steps SET status = 'interrupted', updated_at = ?
    WHERE action_id IS NULL AND status IN ('planned', 'running')`).run(now);
  db.prepare(`UPDATE agent_runs SET status = 'interrupted', updated_at = ? WHERE status IN ('planning', 'running')`).run(now);
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
  if (step.action_status === 'approved' && !step.queue_status) return 'needs_attention';
  if (['queued', 'leased', 'executing', 'retry_wait'].includes(step.queue_status)) return 'waiting_for_action';
  if (step.expired_attempt && (step.queue_status === 'failed' || step.queue_status === 'cancelled')) return 'outcome_uncertain';
  if (step.queue_status === 'failed' || step.queue_status === 'cancelled') return 'needs_attention';
  return step.action_status;
}

function classifyRun(statuses) {
  if (statuses.includes('planning') || statuses.includes('planned')) return 'running';
  if (statuses.includes('interrupted')) return 'interrupted';
  if (statuses.includes('needs_attention')) return 'needs_attention';
  if (statuses.includes('outcome_uncertain')) return 'needs_attention';
  if (statuses.includes('waiting_for_approval') || statuses.includes('pending')) return 'waiting_for_approval';
  if (statuses.includes('waiting_for_action') || statuses.includes('approved') || statuses.includes('queued') || statuses.includes('running') || statuses.includes('retrying')) return 'waiting_for_action';
  if (statuses.some((status) => TERMINAL.has(status) && status !== 'executed')) return 'failed';
  return 'completed';
}
