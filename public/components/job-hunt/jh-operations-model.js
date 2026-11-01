import { jobHref } from './jh-overview-model.js';

// Pure helpers for the Agent Operations view (#640): labels, tones and links for the rows of GET /api/job-hunt/operations.
// DOM-free so they can be tested. A value the data does not have is a dash, never a made-up one.

export const DASH = '—';
export const OPERATIONS_HREF = '#/job-hunt/operations';
/** Where the existing approval cards live; the Operations page shows the owner's pending approvals. */
export const APPROVALS_HREF = '#/operations';

// agent_actions.status and the action queue status, as the owner would say them.
export const ACTION_STATUS = {
  pending: ['attention', 'Awaiting approval'], approved: ['active', 'Approved'], executed: ['success', 'Done'], failed: ['danger', 'Failed'],
  blocked: ['danger', 'Blocked by policy'], rejected: ['neutral', 'Rejected'], cancelled: ['neutral', 'Cancelled'], skipped: ['neutral', 'Skipped'],
  queued: ['active', 'Queued'], leased: ['active', 'Starting'], executing: ['active', 'Running'], retry_wait: ['attention', 'Waiting to retry'],
  budget_exhausted: ['danger', 'Out of budget'], error: ['danger', 'Error'],
};

export function statusOf(status) {
  return ACTION_STATUS[status] ?? ['neutral', String(status ?? '').replace(/_/g, ' ') || DASH];
}

export const AUTOPILOT_MODE = { paused: ['neutral', 'Paused'], dry_run: ['agent', 'Dry run'], live: ['success', 'Live'] };
export const AUTOPILOT_EXECUTION = { idle: ['neutral', 'Idle'], running: ['active', 'Running cycle'], degraded: ['attention', 'Degraded'], blocked: ['danger', 'Blocked'] };

export const MODE_EXPLANATION = {
  paused: 'The autopilot is off. Nothing runs on its own.',
  dry_run: 'Dry run: the autopilot works out what it would do and sends nothing.',
  live: 'Live: the autopilot may act within your policies. Anything your policies say to ask about waits for you.',
};

/** "who" for a row: the job it concerns, or a dash. */
export function jobLabel(row) {
  const text = [row.company, row.role].filter(Boolean).join(' — ');
  return text || DASH;
}

export const rowJobHref = (row) => jobHref(row.jobId);

/** A count, or a dash for a missing number. */
export const countText = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : DASH);

/** The one sentence announced to a screen reader after an update. */
export function liveSummary(data) {
  if (!data) return '';
  const running = data.running?.count ?? 0;
  const waiting = data.awaitingApproval?.count ?? 0;
  const failed = data.failures?.length ?? 0;
  return `Agent operations updated. ${running} running, ${waiting} awaiting your approval, ${failed} recent ${failed === 1 ? 'failure' : 'failures'}.`;
}
