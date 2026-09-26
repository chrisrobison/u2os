import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getDataDir } from '../db/connection.js';
import { acquireHomeGuard } from '../runtime/home-guard.js';
import { readInstallationIdentity } from '../seed/installation-mode.js';
import { RECOVERY_FILE, writeRecoveryState } from './recovery-state.js';

export const RECOVERY_ERROR_CLASS = 'recovery_review_required';
const EVENT_TYPE = 'system.recovery_work_quarantined';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_WORK = `(status NOT IN ('completed','failed','cancelled','budget_exhausted') AND cancel_requested_at IS NULL) OR continuation_after_step IS NOT NULL OR EXISTS
  (SELECT 1 FROM agent_run_steps s WHERE s.run_id = agent_runs.id AND s.status IN ('planned','running','waiting_dependency'))`;
const required = {
  events: ['id','type','timestamp','source','actor_type','actor_id','subject_type','subject_id','data','metadata','correlation_id','created_at'],
  agent_actions: ['id','status','rejected_at','rejected_by','result','updated_at'],
  action_queue: ['id','action_id','status','lease_owner','lease_expires_at','last_error','error_class','approval_reference','policy_decision_reference','updated_at'],
  action_attempts: ['id','queue_id','status'],
  agent_runs: ['id','status','continuation_after_step','continuation_claimed','cancel_requested_at','cancelled_by','updated_at'],
  agent_run_steps: ['run_id','action_id','status','updated_at'],
  goals: ['id','status','revision','updated_at'],
  goal_wakes: ['status','blocker','updated_at'],
  goal_research_schedules: ['status','blocker','updated_at'],
  triggers: ['enabled','next_check_at','lease_owner','lease_expires_at','updated_at'],
  sessions: ['id_hash'],
};
function refused(message) { const error = new Error(`Recovery review refused: ${message}. Preserve the home for offline review; activation is not supported`); error.code = 'RECOVERY_REVIEW_REFUSED'; return error; }

function readMarker(home) {
  const file = path.join(home, RECOVERY_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error();
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (marker.version !== 1 || marker.status !== 'inactive' || marker.database !== 'ok' || !Number.isFinite(Date.parse(marker.verifiedAt)) ||
        !marker.installationId || marker.installationId !== readInstallationIdentity(home) ||
        (marker.recoveryId !== undefined && !UUID.test(marker.recoveryId))) throw new Error();
    return marker;
  } catch { throw refused('verified inactive installation identity is missing or invalid'); }
}

function validateSchema(db) {
  // Do not execute archive-supplied triggers/views/generated expressions or
  // custom constraints during operational-state updates. No migrations here.
  const objects = db.prepare('SELECT type, name, sql FROM sqlite_master LIMIT 1001').all();
  if (objects.length > 1000 || objects.some((row) => !['table','index'].includes(row.type) || /\bCHECK\s*\(/i.test(row.sql || '')) ||
      db.prepare('PRAGMA table_list').all().some((row) => ['virtual','shadow'].includes(row.type))) throw refused('custom executable database schema is unsupported');
  const partialIndexes = new Set([
    "create unique index idx_goal_wake_pending on goal_wakes(goal_id) where status = 'pending'",
    "create unique index idx_goal_research_active on goal_research_schedules(goal_id) where status = 'active'",
  ]);
  for (const index of objects.filter((row) => row.type === 'index')) {
    const sql = (index.sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (db.prepare('SELECT cid FROM pragma_index_xinfo(?)').all(index.name).some((row) => row.cid === -2) ||
        (/\bwhere\b/.test(sql) && !partialIndexes.has(sql))) throw refused('custom executable index expressions are unsupported');
  }
  for (const [table, columns] of Object.entries(required)) {
    const actual = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    if (actual.some((column) => column.hidden || /[()]/.test(column.dflt_value || '')) || columns.some((column) => !actual.some((entry) => entry.name === column))) throw refused('database schema is unsupported; no migrations were attempted');
  }
  if (db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal') throw refused('database is not a self-contained offline snapshot');
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0].integrity_check !== 'ok') throw refused('SQLite integrity verification failed');
}

function counts(db) {
  const count = (table, where = '1') => db.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get().n;
  return {
    approvals: count('agent_actions', "status IN ('pending','approved')"),
    heldQueueItems: count('action_queue', "status != 'completed' AND NOT EXISTS (SELECT 1 FROM agent_actions a WHERE a.id = action_queue.action_id AND a.status = 'executed')"),
    knownCompletedQueueRepairs: count('action_queue', "status != 'completed' AND EXISTS (SELECT 1 FROM agent_actions a WHERE a.id = action_queue.action_id AND a.status = 'executed')"),
    runsToStop: count('agent_runs', RUN_WORK),
    pausedGoals: count('goals', "status IN ('draft','active')"), enabledTriggers: count('triggers', 'enabled != 0'),
    pendingWakes: count('goal_wakes', "status = 'pending'"), activeSchedules: count('goal_research_schedules', "status = 'active'"), sessions: count('sessions'),
  };
}

/** Offline metadata-only preview/apply. Neither path starts providers or
 * interprets observations as permission. Every successful home stays inactive. */
export function reviewRecoveryWork({ dataDir = getDataDir(), apply = false } = {}) {
  if (typeof apply !== 'boolean') throw refused('apply must be explicitly true or false');
  let home;
  try { home = fs.realpathSync(path.resolve(dataDir)); }
  catch { throw refused('existing recovery home is unavailable'); }
  const guard = acquireHomeGuard(home);
  let db;
  try {
    let marker = readMarker(home);
    const file = path.join(home, 'db', 'u2os.sqlite');
    const databaseFile = fs.lstatSync(file);
    if (!fs.lstatSync(path.dirname(file)).isDirectory() || !databaseFile.isFile() || databaseFile.nlink !== 1) throw refused('application database is unavailable or linked');
    db = new DatabaseSync(file, { readOnly: !apply }); db.exec('PRAGMA trusted_schema = OFF;');
    validateSchema(db);
    const prior = db.prepare('SELECT data FROM events WHERE type = ? AND source = ? AND subject_id = ? LIMIT 2')
      .all(EVENT_TYPE, 'system:recovery', marker.recoveryId ?? '');
    if (prior.length > 1) throw refused('recovery checkpoint is ambiguous');
    if (prior.length) {
      let receipt;
      try { if (prior[0].data.length > 65536) throw new Error(); receipt = JSON.parse(prior[0].data); }
      catch { throw refused('recovery checkpoint is invalid'); }
      const fields = Object.keys(counts(db));
      if (receipt.version !== 1 || !UUID.test(receipt.id) || receipt.scope !== 'database-work-only' || !receipt.counts ||
          Object.keys(receipt).some((key) => !['version','id','appliedAt','counts','scope'].includes(key)) ||
          Object.keys(receipt.counts).length !== fields.length || fields.some((key) => !Number.isSafeInteger(receipt.counts[key]) || receipt.counts[key] < 0) ||
          !Number.isFinite(Date.parse(receipt.appliedAt)) || new Date(receipt.appliedAt).toISOString() !== receipt.appliedAt) throw refused('recovery checkpoint is invalid');
      const current = counts(db);
      if (Object.entries(current).some(([key, value]) => key !== 'heldQueueItems' && value !== 0) ||
          db.prepare(`SELECT count(*) n FROM action_queue WHERE status != 'completed' AND
            (status != 'failed' OR error_class IS NOT ? OR lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL OR approval_reference IS NOT NULL OR policy_decision_reference IS NOT NULL)`).get(RECOVERY_ERROR_CLASS).n ||
          db.prepare(`SELECT count(*) n FROM agent_actions WHERE status != 'executed' AND rejected_at IS NULL AND id IN
            (SELECT action_id FROM action_queue WHERE status != 'completed')`).get().n) throw refused('quarantine checkpoint no longer matches stopped work');
      if (apply && marker.workQuarantine?.id !== receipt.id) writeRecoveryState(home, { ...marker, workQuarantine: receipt });
      return apply ? { inactive: true, alreadyApplied: true, ...receipt } : { inactive: true, alreadyApplied: true, counts: receipt.counts };
    }
    if (marker.workQuarantine) throw refused('recovery marker has no corresponding database checkpoint');
    const summary = counts(db);
    if (!apply) return { inactive: true, alreadyApplied: false, counts: summary };
    if (!marker.recoveryId) {
      marker = { ...marker, recoveryId: randomUUID() }; writeRecoveryState(home, marker);
    }
    const receipt = { version: 1, id: randomUUID(), appliedAt: new Date().toISOString(), counts: summary, scope: 'database-work-only' };
    const now = receipt.appliedAt;
    db.exec('BEGIN IMMEDIATE;');
    try {
      // Revoke approval, retaining historical approval/result/attempt fields.
      db.prepare(`UPDATE agent_actions SET rejected_at = COALESCE(rejected_at, ?), rejected_by = COALESCE(rejected_by, 'system:recovery'), updated_at = ?
        WHERE status IN ('pending','approved') OR (status != 'executed' AND id IN (SELECT action_id FROM action_queue WHERE status != 'completed'))`).run(now, now);
      db.prepare("UPDATE agent_actions SET status = 'cancelled', updated_at = ? WHERE status IN ('pending','approved')").run(now);
      db.prepare(`UPDATE action_queue SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, approval_reference = NULL,
        policy_decision_reference = NULL, updated_at = ? WHERE status != 'completed' AND action_id IN (SELECT id FROM agent_actions WHERE status = 'executed')`).run(now);
      db.prepare(`UPDATE action_queue SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, approval_reference = NULL,
        policy_decision_reference = NULL, error_class = ?, last_error = 'Restored snapshot requires owner review; the original may have progressed after capture', updated_at = ?
        WHERE status != 'completed'`).run(RECOVERY_ERROR_CLASS, now);
      db.prepare(`UPDATE agent_runs SET status = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, ?),
        cancelled_by = COALESCE(cancelled_by, 'system:recovery'), continuation_after_step = NULL, continuation_claimed = 0, updated_at = ? WHERE ${RUN_WORK}`).run(now, now);
      db.prepare(`UPDATE agent_run_steps SET status = CASE WHEN action_id IN
        (SELECT id FROM agent_actions WHERE status = 'executed' UNION SELECT action_id FROM action_queue WHERE status = 'completed')
        THEN 'executed' ELSE 'cancelled' END, updated_at = ? WHERE status IN ('planned','running','waiting_dependency')`).run(now);
      db.prepare("UPDATE goals SET status = 'paused', revision = revision + 1, updated_at = ? WHERE status IN ('draft','active')").run(now);
      db.prepare('UPDATE triggers SET enabled = 0, next_check_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE enabled != 0 OR lease_owner IS NOT NULL').run(now);
      db.prepare("UPDATE goal_wakes SET status = 'cancelled', blocker = 'recovery_review_required', updated_at = ? WHERE status = 'pending'").run(now);
      db.prepare("UPDATE goal_research_schedules SET status = 'cancelled', blocker = 'recovery_review_required', updated_at = ? WHERE status = 'active'").run(now);
      db.exec('DELETE FROM sessions;');
      db.prepare(`INSERT INTO events (id,type,timestamp,source,actor_type,actor_id,subject_type,subject_id,data,metadata,created_at)
        VALUES (?,?,?,'system:recovery','system','recovery','recovery',?,?,'{"classification":"private"}',?)`)
        .run(`recovery_${receipt.id}`, EVENT_TYPE, now, marker.recoveryId, JSON.stringify(receipt), now);
      db.exec('COMMIT;');
    } catch { db.exec('ROLLBACK;'); throw refused('database quarantine failed; its transaction was rolled back'); }
    writeRecoveryState(home, { ...marker, workQuarantine: receipt });
    return { inactive: true, alreadyApplied: false, ...receipt };
  } catch (error) {
    if (error.code === 'RECOVERY_REVIEW_REFUSED') throw error;
    throw refused('review or checkpoint publication failed; the home remains inactive');
  } finally { db?.close(); guard.release(); }
}
