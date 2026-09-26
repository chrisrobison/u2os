import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { getRun } from './run-store.js';

const DOMAINS = new Set(['web', 'email', 'calendar', 'contacts', 'tasks']);
const FIELDS = ['objective', 'completionCriteria', 'constraints', 'permittedScope', 'budgets'];
const EVIDENCE_PREVIEW_CHARS = 4000;
const SECRET_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credential)/i;

export function createGoalDraft(ownerId, input) {
  const data = validateDraft(input);
  const id = newId('goal');
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO goals
    (id, owner_id, objective, completion_criteria, constraints, permitted_scope, budgets, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, data.objective,
      JSON.stringify(data.completionCriteria), JSON.stringify(data.constraints),
      JSON.stringify(data.permittedScope), JSON.stringify(data.budgets), now, now);
  return getGoalDraft(id, ownerId);
}

export function getGoalDraft(id, ownerId) {
  const row = getDb().prepare('SELECT * FROM goals WHERE id = ? AND owner_id = ?').get(id, ownerId);
  if (!row) throw httpError(404, 'Goal not found');
  return present(row);
}

export function listGoalDrafts(ownerId, limit = 20) {
  const bounded = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return getDb().prepare('SELECT * FROM goals WHERE owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
    .all(ownerId, bounded).map(present);
}

/** A goal's stored scope, not model text, is authoritative for linked runs. */
export function getGoalForRun(runId) {
  const link = getDb().prepare('SELECT goal_id, goal_revision FROM agent_runs WHERE id = ?').get(runId);
  if (!link?.goal_id) return null;
  const row = getDb().prepare('SELECT * FROM goals WHERE id = ?').get(link.goal_id);
  return row ? { id: row.id, status: row.status, revision: row.revision, runRevision: link.goal_revision, permittedScope: JSON.parse(row.permitted_scope) }
    : { id: link.goal_id, status: 'missing', permittedScope: { domains: [] } };
}

/** Owner-only, bounded view of persisted run observations. Arguments and
 * account bindings stay in the audit store and never enter this response. */
export function getGoalRunEvidence(goalId, ownerId, runId) {
  if (!getDb().prepare('SELECT 1 FROM goals WHERE id = ? AND owner_id = ?').get(goalId, ownerId)) {
    throw httpError(404, 'Goal not found');
  }
  const linked = getDb().prepare('SELECT response, objective, goal_revision FROM agent_runs WHERE id = ? AND goal_id = ? AND actor_id = ?')
    .get(runId, goalId, ownerId);
  if (!linked) throw httpError(404, 'Goal run not found');
  const run = getRun(runId);
  const rows = getDb().prepare(`SELECT s.step_index, s.tool, s.status, s.action_id, a.result
    FROM agent_run_steps s LEFT JOIN agent_actions a ON a.id = s.action_id
    WHERE s.run_id = ? ORDER BY s.step_index LIMIT 33`).all(runId);
  const statuses = new Map(run.steps.map((step) => [step.index, step.status]));
  const response = preview(linked.response);
  const objective = preview(linked.objective);
  return {
    goalId, runId, status: run.status, objectiveStatus: run.objectiveStatus,
    goalRevision: linked.goal_revision, objective: objective.text, objectiveTruncated: objective.truncated,
    response: response.text, responseTruncated: response.truncated,
    stepsTruncated: rows.length > 32,
    steps: rows.slice(0, 32).map((row) => {
      const status = statuses.get(row.step_index) || row.status;
      const result = status === 'executed' ? previewResult(row.result) : { text: null, truncated: false };
      return { index: row.step_index, tool: row.tool, status, actionId: row.action_id,
        resultPreview: result.text, resultTruncated: result.truncated };
    }),
  };
}

function previewResult(raw) {
  if (raw == null) return { text: null, truncated: false };
  if (raw.length > 100_000) return { text: '[Large result omitted]', truncated: true };
  try { return preview(JSON.stringify(redactResult(JSON.parse(raw)))); }
  catch { return { text: '[Result unavailable]', truncated: false }; }
}

function redactResult(value, depth = 0) {
  if (depth >= 8) return '[nested result omitted]';
  if (Array.isArray(value)) return value.map((item) => redactResult(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, SECRET_FIELD.test(key) ? '[redacted]' : redactResult(item, depth + 1)]));
  return value;
}

function preview(value) {
  if (value == null) return { text: null, truncated: false };
  const text = String(value);
  return { text: text.slice(0, EVIDENCE_PREVIEW_CHARS), truncated: text.length > EVIDENCE_PREVIEW_CHARS };
}

/** Full replacement with a compare-and-swap revision. An owner cannot
 * silently overwrite a goal revised from another browser/tab. */
export function updateGoalDraft(id, ownerId, input) {
  if (!isObject(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw httpError(400, 'expectedRevision must be a positive integer');
  }
  const data = validateDraft(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'expectedRevision')));
  const current = getGoalDraft(id, ownerId);
  if (!['draft', 'paused'].includes(current.status)) throw httpError(409, 'Pause the goal before revising its scope');
  const now = new Date().toISOString();
  const changed = withTransaction(getDb(), () => {
    const result = getDb().prepare(`UPDATE goals SET objective = ?, completion_criteria = ?, constraints = ?,
    permitted_scope = ?, budgets = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND owner_id = ? AND status = ? AND revision = ?`).run(data.objective,
    JSON.stringify(data.completionCriteria), JSON.stringify(data.constraints), JSON.stringify(data.permittedScope),
    JSON.stringify(data.budgets), now, id, ownerId, current.status, input.expectedRevision);
    if (result.changes === 1) invalidateGoalWakes(id, 'goal_revised');
    return result;
  });
  if (changed.changes !== 1) throw httpError(409, 'Goal changed; reload before editing');
  return getGoalDraft(id, ownerId);
}

/** Lifecycle changes never reset usage or replay a prior run. Same-state
 * retries are harmless; a stale request cannot change the current state. */
export function controlGoal(id, ownerId, input) {
  if (!isObject(input) || Object.keys(input).some((key) => !['operation', 'expectedRevision'].includes(key)) ||
      !['pause', 'resume', 'cancel'].includes(input.operation) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw httpError(400, 'operation and a positive expectedRevision are required');
  }
  const current = getGoalDraft(id, ownerId);
  const target = input.operation === 'pause' ? 'paused' : input.operation === 'cancel' ? 'cancelled'
    : current.spent.runs ? 'active' : 'draft';
  if (current.status === target) return current;
  if (current.status === 'cancelled') throw httpError(409, 'Cancelled goals cannot be resumed');
  if (current.revision !== input.expectedRevision) throw httpError(409, 'Goal changed; reload before changing its state');
  if (input.operation === 'resume' && current.status !== 'paused') throw httpError(409, 'Only paused goals can be resumed');
  const changed = withTransaction(getDb(), () => {
    const result = getDb().prepare(`UPDATE goals SET status = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND owner_id = ? AND revision = ? AND status = ?`).run(target, new Date().toISOString(), id, ownerId,
      input.expectedRevision, current.status);
    if (result.changes === 1) invalidateGoalWakes(id, 'goal_stopped');
    return result;
  });
  if (changed.changes !== 1) throw httpError(409, 'Goal changed; reload before changing its state');
  return getGoalDraft(id, ownerId);
}

function invalidateGoalWakes(id, reason) {
  getDb().prepare(`UPDATE triggers SET enabled = 0, next_check_at = NULL WHERE id IN
    (SELECT trigger_id FROM goal_wakes WHERE goal_id = ? AND status = 'pending')`).run(id);
  getDb().prepare("UPDATE goal_wakes SET status = 'cancelled', blocker = ?, updated_at = ? WHERE goal_id = ? AND status = 'pending'")
    .run(reason, new Date().toISOString(), id);
}

export function goalRunObjective(goal) {
  return `${goal.objective}\nCompletion criteria:\n${goal.completionCriteria.map((item) => `- ${item}`).join('\n')}\nConstraints:\n${goal.constraints.map((item) => `- ${item}`).join('\n')}\nUse read-only tools within the intended domains. Do not claim objective completion without evidence.`;
}

function validateDraft(input) {
  if (!isObject(input) || Object.keys(input).some((key) => !FIELDS.includes(key))) throw httpError(400, 'Invalid goal draft fields');
  const objective = boundedText(input.objective, 2000, 'objective');
  const completionCriteria = boundedTexts(input.completionCriteria, 1, 8, 300, 'completionCriteria');
  const constraints = boundedTexts(input.constraints ?? [], 0, 10, 300, 'constraints');
  const scope = input.permittedScope;
  if (!isObject(scope) || Object.keys(scope).some((key) => !['domains', 'consequentialActions'].includes(key)) ||
      !Array.isArray(scope.domains) || scope.domains.length > 5 ||
      scope.domains.some((domain) => !DOMAINS.has(domain)) || new Set(scope.domains).size !== scope.domains.length ||
      typeof scope.consequentialActions !== 'boolean') throw httpError(400, 'Invalid permittedScope');
  const budgets = input.budgets;
  if (!isObject(budgets) || Object.keys(budgets).some((key) => !['maxRuns', 'maxModelCalls', 'maxTokens'].includes(key)) ||
      !integerBetween(budgets.maxRuns, 1, 100) || !integerBetween(budgets.maxModelCalls, 1, 300) ||
      !integerBetween(budgets.maxTokens, 1000, 1_000_000)) throw httpError(400, 'Invalid budgets');
  return { objective, completionCriteria, constraints, permittedScope: scope, budgets };
}

function present(row) {
  const linked = getDb().prepare(`SELECT id, status, objective_status, created_at, updated_at
    FROM agent_runs WHERE goal_id = ? ORDER BY created_at DESC, id DESC`).all(row.id);
  const usage = getDb().prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(model_call_count), 0) AS model_calls,
    COALESCE(SUM(metered_model_calls), 0) AS metered_calls, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
    COALESCE(SUM(CASE WHEN status NOT IN ('completed', 'failed', 'cancelled', 'budget_exhausted') THEN 1 ELSE 0 END), 0) AS unfinished
    FROM agent_runs WHERE goal_id = ?`).get(row.id);
  const budgets = JSON.parse(row.budgets);
  const permittedScope = JSON.parse(row.permitted_scope);
  const wake = getDb().prepare('SELECT * FROM goal_wakes WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(row.id);
  const pending = getDb().prepare("SELECT fire_at FROM goal_wakes WHERE goal_id = ? AND status = 'pending'").get(row.id);
  return {
    id: row.id, objective: row.objective, completionCriteria: JSON.parse(row.completion_criteria),
    constraints: JSON.parse(row.constraints), permittedScope,
    budgets, status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
    executionEnabled: Boolean(pending), manualRunAvailable: ['draft', 'active'].includes(row.status) && permittedScope.domains.length > 0 && !usage.unfinished &&
      usage.runs < budgets.maxRuns && usage.model_calls < budgets.maxModelCalls && usage.tokens < budgets.maxTokens,
    nextWakeAt: pending?.fire_at || null,
    lastWake: wake ? { id: wake.id, goalRevision: wake.goal_revision, fireAt: wake.fire_at, status: wake.status,
      runId: wake.run_id, blocker: wake.blocker } : null,
    relatedRuns: linked.map((run) => ({ id: run.id, status: run.status, objectiveStatus: run.objective_status,
      createdAt: run.created_at, updatedAt: run.updated_at })),
    spent: { runs: usage.runs, modelCalls: usage.model_calls, tokens: usage.tokens,
      meteredModelCalls: usage.metered_calls, tokenUsageComplete: usage.metered_calls === usage.model_calls,
      monetaryCost: { available: false, amount: null, currency: null } },
  };
}

function boundedText(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw httpError(400, `${field} must be 1–${max} characters`);
  return value.trim();
}
function boundedTexts(value, min, max, chars, field) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw httpError(400, `${field} must have ${min}–${max} entries`);
  return value.map((entry) => boundedText(entry, chars, field));
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integerBetween(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
