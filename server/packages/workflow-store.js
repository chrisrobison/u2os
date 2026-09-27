// Persistence for automation instances, workflow runs and step records
// (docs/plugin-architecture.md §8). Plain rows in and out; the engine owns
// the semantics.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

const now = () => new Date().toISOString();
const json = (value) => (value === undefined ? null : JSON.stringify(value));
const parse = (text, fallback = null) => (text === null || text === undefined ? fallback : JSON.parse(text));

export const TERMINAL_RUN_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'skipped', 'throttled']);
export const ACTIVE_RUN_STATUSES = Object.freeze(['pending', 'running', 'waiting']);

// --- automation instances ------------------------------------------------------

export function ensureAutomationInstance({ packageId, automationId, initialState = {} }) {
  const db = getDb();
  const existing = getInstanceByAutomation(automationId);
  if (existing) {
    // Additive state migration: keys new in `initial` are added, nothing
    // existing is removed or overwritten.
    const merged = { ...structuredClone(initialState), ...existing.state };
    db.prepare("UPDATE automation_instances SET package_id = ?, status = 'installed', state = ?, updated_at = ? WHERE id = ?")
      .run(packageId, JSON.stringify(merged), now(), existing.id);
    return getInstance(existing.id);
  }
  const id = newId('ain');
  const time = now();
  db.prepare(`INSERT INTO automation_instances (id, package_id, automation_id, enabled, paused, status, state, created_at, updated_at)
    VALUES (?,?,?,0,0,'installed',?,?,?)`).run(id, packageId, automationId, JSON.stringify(initialState || {}), time, time);
  return getInstance(id);
}

export function getInstance(id) {
  return rowToInstance(getDb().prepare('SELECT * FROM automation_instances WHERE id = ?').get(id));
}

export function getInstanceByAutomation(automationId) {
  return rowToInstance(getDb().prepare('SELECT * FROM automation_instances WHERE automation_id = ?').get(automationId));
}

export function listInstances({ includeUninstalled = false, packageId = null } = {}) {
  const rows = getDb().prepare('SELECT * FROM automation_instances ORDER BY automation_id').all().map(rowToInstance);
  return rows.filter((row) => (includeUninstalled || row.status === 'installed') && (!packageId || row.packageId === packageId));
}

export function updateInstance(id, patch) {
  const columns = { enabled: 'enabled', paused: 'paused', status: 'status', nextRunAt: 'next_run_at', lastRunId: 'last_run_id',
    lastRunAt: 'last_run_at', lastStatus: 'last_status', lastError: 'last_error' };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (patch.state !== undefined) { sets.push('state = ?', 'state_version = state_version + 1'); values.push(JSON.stringify(patch.state)); }
  if (!sets.length) return getInstance(id);
  sets.push('updated_at = ?');
  values.push(now(), id);
  getDb().prepare(`UPDATE automation_instances SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getInstance(id);
}

function rowToInstance(row) {
  if (!row) return null;
  return {
    id: row.id, packageId: row.package_id, automationId: row.automation_id, enabled: row.enabled === 1, paused: row.paused === 1,
    status: row.status, state: parse(row.state, {}), stateVersion: row.state_version, nextRunAt: row.next_run_at,
    lastRunId: row.last_run_id, lastRunAt: row.last_run_at, lastStatus: row.last_status, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// --- runs --------------------------------------------------------------------

/** Inserts a run; returns null when dedupeKey was already claimed. */
export function insertRun(run) {
  const id = run.id || newId('wfr');
  const time = now();
  const result = getDb().prepare(`INSERT OR IGNORE INTO workflow_runs (
      id, kind, definition_id, package_id, principal_package_id, package_version, automation_instance_id, root_run_id, parent_run_id, parent_step_id, depth,
      trigger, dedupe_key, status, workflow, inputs, context, position, correlation_id, error, created_at, updated_at, completed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, run.kind, run.definitionId, run.packageId, run.principalPackageId || run.packageId, run.packageVersion ?? null, run.instanceId ?? null, run.rootRunId ?? id,
    run.parentRunId ?? null, run.parentStepId ?? null, run.depth ?? 0, JSON.stringify(run.trigger || {}), run.dedupeKey ?? null,
    run.status || 'pending', JSON.stringify(run.workflow), JSON.stringify(run.inputs || {}), '{}', JSON.stringify(initialPosition()),
    run.correlationId ?? null, run.error ?? null, time, time, TERMINAL_RUN_STATUSES.includes(run.status) ? time : null,
  );
  return result.changes ? getRun(id) : null;
}

export function initialPosition() {
  return { step: 0, iteration: 0, items: null, results: [], handle: null };
}

export function getRun(id) {
  return rowToRun(getDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id));
}

export function getRunByDedupe(dedupeKey) {
  return rowToRun(getDb().prepare('SELECT * FROM workflow_runs WHERE dedupe_key = ?').get(dedupeKey));
}

export function listRuns({ instanceId = null, packageId = null, status = null, kind = null, parentRunId = null, limit = 50 } = {}) {
  const clauses = [];
  const values = [];
  if (instanceId) { clauses.push('automation_instance_id = ?'); values.push(instanceId); }
  if (packageId) { clauses.push('package_id = ?'); values.push(packageId); }
  if (kind) { clauses.push('kind = ?'); values.push(kind); }
  if (parentRunId) { clauses.push('parent_run_id = ?'); values.push(parentRunId); }
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
    values.push(...statuses);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 1000));
  return getDb().prepare(`SELECT * FROM workflow_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values).map(rowToRun);
}

/** Atomically claims a pending run for execution. */
export function leaseRun(id, { leaseOwner, leaseMs }) {
  const time = new Date();
  const result = getDb().prepare(`UPDATE workflow_runs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
      started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(leaseOwner, new Date(time.getTime() + leaseMs).toISOString(), time.toISOString(), time.toISOString(), id);
  return result.changes === 1 ? getRun(id) : null;
}

export function renewRunLease(id, { leaseOwner, leaseMs }) {
  getDb().prepare("UPDATE workflow_runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'")
    .run(new Date(Date.now() + leaseMs).toISOString(), id, leaseOwner);
}

/** Persists a checkpoint (context + position) for a run this worker holds. */
export function checkpointRun(id, { context, position, leaseOwner }) {
  getDb().prepare("UPDATE workflow_runs SET context = ?, position = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'")
    .run(JSON.stringify(context), JSON.stringify(position), now(), id, leaseOwner);
}

export function suspendRun(id, { context, position, wait, wakeAt = null, leaseOwner }) {
  getDb().prepare(`UPDATE workflow_runs SET status = 'waiting', context = ?, position = ?, wait = ?, wake_at = ?, lease_owner = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`)
    .run(JSON.stringify(context), JSON.stringify(position), JSON.stringify(wait), wakeAt, now(), id, leaseOwner);
  return getRun(id);
}

export function finishRun(id, { status, outputs = null, error = null, context, position }) {
  const time = now();
  getDb().prepare(`UPDATE workflow_runs SET status = ?, outputs = ?, error = ?, context = COALESCE(?, context), position = COALESCE(?, position),
      wait = NULL, wake_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE id = ?`)
    .run(status, json(outputs), error, context === undefined ? null : JSON.stringify(context), position === undefined ? null : JSON.stringify(position), time, time, id);
  return getRun(id);
}

/** Makes a waiting run runnable again, optionally updating its wait handle. */
export function wakeRun(id, { position = null } = {}) {
  const result = getDb().prepare(`UPDATE workflow_runs SET status = 'pending', position = COALESCE(?, position), wait = NULL, wake_at = NULL,
      updated_at = ? WHERE id = ? AND status = 'waiting'`).run(position ? JSON.stringify(position) : null, now(), id);
  return result.changes === 1;
}

/** Runs left 'running' by a stopped process return to 'pending'. */
export function recoverInterruptedRuns({ expiredOnly = false } = {}) {
  const time = now();
  const sql = expiredOnly
    ? "UPDATE workflow_runs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"
    : "UPDATE workflow_runs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running'";
  return expiredOnly ? getDb().prepare(sql).run(time, time).changes : getDb().prepare(sql).run(time).changes;
}

export function listWaitingRuns({ dueBefore = null } = {}) {
  if (dueBefore) {
    return getDb().prepare("SELECT * FROM workflow_runs WHERE status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= ? ORDER BY wake_at").all(dueBefore).map(rowToRun);
  }
  return getDb().prepare("SELECT * FROM workflow_runs WHERE status = 'waiting' ORDER BY created_at").all().map(rowToRun);
}

export function listRunnableRuns(limit = 25) {
  return getDb().prepare("SELECT * FROM workflow_runs WHERE status = 'pending' ORDER BY created_at, id LIMIT ?").all(limit).map(rowToRun);
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, definitionId: row.definition_id, packageId: row.package_id, principalPackageId: row.principal_package_id, packageVersion: row.package_version,
    instanceId: row.automation_instance_id, rootRunId: row.root_run_id, parentRunId: row.parent_run_id, parentStepId: row.parent_step_id,
    depth: row.depth, trigger: parse(row.trigger, {}), dedupeKey: row.dedupe_key, status: row.status, workflow: parse(row.workflow, {}),
    inputs: parse(row.inputs, {}), outputs: parse(row.outputs), context: parse(row.context, {}), position: parse(row.position, initialPosition()),
    wait: parse(row.wait), wakeAt: row.wake_at, error: row.error, correlationId: row.correlation_id, leaseOwner: row.lease_owner,
    createdAt: row.created_at, startedAt: row.started_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  };
}

// --- step records --------------------------------------------------------------

export function recordStep({ runId, stepId, iteration = -1, kind, status, attempts = 0, actionId = null, childRunId = null, policy = null, output, error = null }) {
  const time = now();
  const terminal = ['completed', 'failed', 'skipped', 'denied'].includes(status);
  getDb().prepare(`INSERT INTO workflow_steps (id, run_id, step_id, iteration, kind, status, attempts, action_id, child_run_id, policy, output, error, started_at, updated_at, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, step_id, iteration) DO UPDATE SET status = excluded.status, attempts = excluded.attempts,
        action_id = COALESCE(excluded.action_id, action_id), child_run_id = COALESCE(excluded.child_run_id, child_run_id),
        policy = COALESCE(excluded.policy, policy), output = excluded.output, error = excluded.error, updated_at = excluded.updated_at,
        completed_at = excluded.completed_at`)
    .run(newId('wfs'), runId, stepId, iteration, kind, status, attempts, actionId, childRunId, json(policy ?? undefined), json(output), error, time, time, terminal ? time : null);
}

export function listSteps(runId) {
  return getDb().prepare('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY started_at, rowid').all(runId).map((row) => ({
    stepId: row.step_id, iteration: row.iteration, kind: row.kind, status: row.status, attempts: row.attempts, actionId: row.action_id,
    childRunId: row.child_run_id, policy: parse(row.policy), output: parse(row.output), error: row.error,
    startedAt: row.started_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  }));
}

// --- event cursor --------------------------------------------------------------

export function getEventCursor() {
  return getDb().prepare('SELECT last_rowid FROM automation_event_cursor WHERE id = 1').get()?.last_rowid ?? null;
}

export function setEventCursor(rowid) {
  getDb().prepare(`INSERT INTO automation_event_cursor (id, last_rowid, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_rowid = MAX(last_rowid, excluded.last_rowid), updated_at = excluded.updated_at`).run(rowid, now());
}
