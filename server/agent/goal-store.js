import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

const DOMAINS = new Set(['web', 'email', 'calendar', 'contacts', 'tasks']);
const FIELDS = ['objective', 'completionCriteria', 'constraints', 'permittedScope', 'budgets'];

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

/** Full replacement with a compare-and-swap revision. An owner cannot
 * silently overwrite a goal revised from another browser/tab. */
export function updateGoalDraft(id, ownerId, input) {
  if (!isObject(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw httpError(400, 'expectedRevision must be a positive integer');
  }
  const data = validateDraft(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'expectedRevision')));
  const current = getGoalDraft(id, ownerId);
  if (current.status !== 'draft') throw httpError(409, 'Only draft goals can be revised');
  const now = new Date().toISOString();
  const changed = getDb().prepare(`UPDATE goals SET objective = ?, completion_criteria = ?, constraints = ?,
    permitted_scope = ?, budgets = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND owner_id = ? AND status = 'draft' AND revision = ?`).run(data.objective,
    JSON.stringify(data.completionCriteria), JSON.stringify(data.constraints), JSON.stringify(data.permittedScope),
    JSON.stringify(data.budgets), now, id, ownerId, input.expectedRevision);
  if (changed.changes !== 1) throw httpError(409, 'Goal changed; reload before editing');
  return getGoalDraft(id, ownerId);
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
  return {
    id: row.id, objective: row.objective, completionCriteria: JSON.parse(row.completion_criteria),
    constraints: JSON.parse(row.constraints), permittedScope: JSON.parse(row.permitted_scope),
    budgets: JSON.parse(row.budgets), status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
    executionEnabled: false, nextWakeAt: null, relatedRuns: [],
    spent: { runs: 0, modelCalls: 0, tokens: 0, monetaryCost: { available: false, amount: null, currency: null } },
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
