// Persistence for coding agent runs (table coding_agent_runs). Plain rows,
// JSON for the structured columns, camelCase at the boundary. Holds no
// provider credentials: nothing here ever sees them.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { TERMINAL_STATUSES } from './types.js';

const COLUMNS = {
  status: 'status', pid: 'pid', exitCode: 'exit_code', summary: 'summary', output: 'output', stderr: 'stderr',
  error: 'error', startedAt: 'started_at', completedAt: 'completed_at',
};

export function createRun({ provider, task, cwd, permissions, requestedBy = 'owner', correlationId = null, metadata = {}, now = new Date() }) {
  const id = newId('cagent');
  const at = now.toISOString();
  getDb().prepare(`INSERT INTO coding_agent_runs
    (id, provider, status, task, cwd, permissions, requested_by, correlation_id, metadata, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, provider, 'queued', task, cwd, JSON.stringify(permissions), requestedBy, correlationId, JSON.stringify(metadata), at, at);
  return getRun(id);
}

/** Applies a partial update; `filesChanged` and `metadata` are stored as JSON. */
export function updateRun(id, fields, now = new Date()) {
  const sets = ['updated_at = ?'];
  const values = [now.toISOString()];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(fields[key]);
  }
  if (fields.filesChanged !== undefined) { sets.push('files_changed = ?'); values.push(JSON.stringify(fields.filesChanged)); }
  if (fields.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(fields.metadata)); }
  getDb().prepare(`UPDATE coding_agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  return getRun(id);
}

export function getRun(id) {
  const row = getDb().prepare('SELECT * FROM coding_agent_runs WHERE id = ?').get(id);
  return row ? fromRow(row) : null;
}

/** Newest first. `status` and `provider` filter; limit is clamped to 1..200. */
export function listRuns({ status = null, provider = null, limit = 25 } = {}) {
  const where = [];
  const values = [];
  if (status) { where.push('status = ?'); values.push(status); }
  if (provider) { where.push('provider = ?'); values.push(provider); }
  const capped = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 200);
  const rows = getDb().prepare(`SELECT * FROM coding_agent_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values, capped);
  return rows.map(fromRow);
}

/**
 * Runs left queued/running by a process that no longer exists. Called at
 * startup: a run whose child is gone can never finish, so it is recorded as
 * failed instead of staying "running" forever.
 */
export function failInterruptedRuns({ isAlive = pidIsAlive, now = new Date() } = {}) {
  const rows = getDb().prepare("SELECT id, pid FROM coding_agent_runs WHERE status IN ('queued', 'running')").all();
  const failed = [];
  for (const row of rows) {
    if (row.pid && isAlive(row.pid)) continue;
    updateRun(row.id, { status: 'failed', error: 'Interrupted: U2OS stopped before this run finished', completedAt: now.toISOString() }, now);
    failed.push(row.id);
  }
  return failed;
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function fromRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    task: row.task,
    cwd: row.cwd,
    permissions: JSON.parse(row.permissions || '{}'),
    requestedBy: row.requested_by,
    correlationId: row.correlation_id,
    pid: row.pid ?? undefined,
    startedAt: row.started_at || row.created_at,
    createdAt: row.created_at,
    completedAt: row.completed_at || undefined,
    exitCode: row.exit_code ?? undefined,
    summary: row.summary || undefined,
    output: row.output || undefined,
    stderr: row.stderr || undefined,
    error: row.error || undefined,
    filesChanged: row.files_changed ? JSON.parse(row.files_changed) : undefined,
    metadata: JSON.parse(row.metadata || '{}'),
    terminal: TERMINAL_STATUSES.includes(row.status),
  };
}
