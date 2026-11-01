import { autopilotIndicator } from './overview.js';

// The Agent Operations view model (#640): what the job-hunt agent is doing,
// what waits for the owner, what failed, and when it last did anything. It is
// READ ONLY and built from real rows: the autopilot status, the agent_actions
// audit table, the action queue and the hunt store. Nothing here (or behind
// GET /api/job-hunt/operations) changes the autopilot, an approval or a
// submission policy. Every list is capped and every query is bound.
//
// "A job-hunt action" is one whose tool is jobs.*, or that the job autopilot
// requested, or whose id is on the hunt emails ledger (the owner's own send
// from the Job hunt page goes through email.send). Arguments and results are
// never returned, only the job id they name (when it is a valid job id).

export const OPS_LIMITS = { running: 20, awaiting: 20, recent: 15, failures: 10, ledger: 200 };
const JOB_ID = /^job_[0-9a-f]{16}$/;
const MAX_TEXT = 200;

const TOOL_LABELS = {
  'jobs.send_application': 'Send application email',
  'jobs.submit_application': 'Submit application form',
  'email.send': 'Send email',
  'apple_mail.send': 'Send email (Apple Mail)',
  'apple_mail.draft': 'Draft email (Apple Mail)',
};
const toolLabel = (tool) => TOOL_LABELS[tool] ?? String(tool).replace(/[._-]+/g, ' ').slice(0, 60);
const text = (value) => (value == null ? null : String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) || null);
const parseJson = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

function scope(ledger) {
  const ids = ledger.map((entry) => entry.actionId);
  const marks = ids.map(() => '?').join(',');
  return { sql: `(substr(a.tool, 1, 5) = 'jobs.' OR a.requested_by = 'job-autopilot'${ids.length ? ` OR a.id IN (${marks})` : ''})`, params: ids };
}

function errorOf(row) {
  const result = parseJson(row.result);
  return text(result?.error ?? result?.message ?? row.last_error ?? null);
}

/**
 * `db` is the main SQLite database (agent_actions, action_queue), `store` the
 * hunt store, `autopilot` autopilot.status() or null.
 */
export function buildOperations({ db, store, autopilot = null, now = new Date() } = {}) {
  const ledger = store.listRecentEmailActions(OPS_LIMITS.ledger);
  const jobByAction = new Map(ledger.map((entry) => [entry.actionId, entry.jobId]));
  const { sql: inScope, params } = scope(ledger);
  const jobs = new Map();
  const jobOf = (row) => {
    let jobId = jobByAction.get(row.id) ?? null;
    if (!jobId) { const given = parseJson(row.arguments)?.job_id; if (typeof given === 'string' && JOB_ID.test(given)) jobId = given; }
    if (!jobId) return { jobId: null, company: null, role: null };
    if (!jobs.has(jobId)) jobs.set(jobId, store.getJob(jobId));
    const job = jobs.get(jobId);
    // An id that is not a known job names nothing (and links nowhere).
    return job ? { jobId, company: text(job.company), role: text(job.role) } : { jobId: null, company: null, role: null };
  };
  const shape = (row, extra = {}) => ({ id: row.id, tool: row.tool, label: toolLabel(row.tool), status: row.status, requestedBy: text(row.requested_by), ...jobOf(row), ...extra });

  const awaitingCount = db.prepare(`SELECT COUNT(*) AS n FROM agent_actions a WHERE a.status = 'pending' AND ${inScope}`).get(...params).n;
  const awaiting = db.prepare(`SELECT a.id, a.tool, a.arguments, a.status, a.requested_by, a.created_at FROM agent_actions a WHERE a.status = 'pending' AND ${inScope} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
    .all(...params, OPS_LIMITS.awaiting).map((row) => shape(row, { since: row.created_at }));

  const running = db.prepare(`SELECT a.id, a.tool, a.arguments, a.requested_by, q.status, q.attempt_count, q.updated_at FROM action_queue q JOIN agent_actions a ON a.id = q.action_id
    WHERE q.status IN ('queued','leased','executing','retry_wait') AND ${inScope} ORDER BY q.updated_at DESC, a.id DESC LIMIT ?`)
    .all(...params, OPS_LIMITS.running).map((row) => shape(row, { attempts: row.attempt_count, since: row.updated_at }));

  const recent = db.prepare(`SELECT a.id, a.tool, a.arguments, a.status, a.requested_by, a.updated_at FROM agent_actions a WHERE a.status <> 'pending' AND ${inScope} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`)
    .all(...params, OPS_LIMITS.recent).map((row) => shape(row, { at: row.updated_at }));

  const failedRows = db.prepare(`SELECT a.id, a.tool, a.arguments, a.status, a.requested_by, a.result, a.updated_at, q.last_error FROM agent_actions a LEFT JOIN action_queue q ON q.action_id = a.id
    WHERE (a.status IN ('failed','blocked') OR q.status IN ('failed','dead_letter')) AND ${inScope} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`)
    .all(...params, OPS_LIMITS.failures).map((row) => shape(row, { source: 'action', at: row.updated_at, message: errorOf(row) }));

  const report = autopilot?.lastReport ?? null;
  const reportErrors = (Array.isArray(report?.errors) ? report.errors : []).slice(0, OPS_LIMITS.failures)
    .map((message) => ({ source: 'autopilot', id: null, label: 'Autopilot cycle', status: 'error', at: report.finishedAt ?? report.startedAt ?? null, message: text(message), jobId: null, company: null, role: null }));
  const failures = [...reportErrors, ...failedRows].slice(0, OPS_LIMITS.failures * 2);

  const indicator = autopilotIndicator(autopilot);
  const lastAction = recent[0]?.at ?? null;
  return {
    generatedAt: now.toISOString(),
    autopilot: indicator && {
      ...indicator,
      cycleRunning: Boolean(autopilot?.running),
      lastCycle: report ? { startedAt: report.startedAt ?? null, finishedAt: report.finishedAt ?? null, mode: report.mode ?? null, actions: Array.isArray(report.actions) ? report.actions.length : null, needsYou: Array.isArray(report.needsYou) ? report.needsYou.length : null, errors: Array.isArray(report.errors) ? report.errors.length : null } : null,
      settingsChangedAt: autopilot?.lastChange?.at ?? null,
    },
    running: { count: running.length, items: running },
    awaitingApproval: { count: awaitingCount, items: awaiting },
    recent,
    failures,
    lastActivity: { autopilotCycleAt: indicator?.lastRunAt ?? null, lastActionAt: lastAction, lastFailureAt: failures.map((f) => f.at).filter(Boolean).sort().at(-1) ?? null },
  };
}
