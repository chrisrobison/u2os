import { leadsHref } from './leads-filter.js';

// Pure helpers for the Job Hunt Overview (#629): links, labels and number formats. DOM-free so they can be tested.

const JOB_ID = /^job_[0-9a-f]{16}$/;

/** A count for display; null (unknown) is a dash, never a made-up zero. */
export function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
}

/** The job page link, optionally opening one outstanding question. Null when the id is not a job id. */
export function jobHref(jobId, question = null) {
  if (!JOB_ID.test(String(jobId ?? ''))) return null;
  return `#/job-hunt/jobs/${jobId}${question?.key ? `?question=${encodeURIComponent(question.key)}` : ''}`;
}

/** The filtered Job Leads list for a metric or a stage from the overview payload. */
export function filterHref(entry) {
  if (entry.statuses?.length) return leadsHref({ statuses: entry.statuses });
  return leadsHref({ filter: entry.filter ?? (entry.flag ? 'needs_input' : 'all') });
}

/** "in 2d", "in 5h", "now" for a deadline; empty for a missing time. */
export function until(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (Number.isNaN(at)) return '';
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

export const MODE_LABELS = { paused: ['neutral', 'Paused'], dry_run: ['agent', 'Dry run'], live: ['success', 'Live'] };
export const EXECUTION_LABELS = { idle: ['neutral', 'Idle'], running: ['active', 'Running cycle'], degraded: ['attention', 'Degraded'], blocked: ['danger', 'Blocked'] };
export const STAGE_TONES = { discovered: 'neutral', qualified: 'neutral', preparing: 'agent', needs_input: 'attention', submitted: 'active', responded: 'active', interviewing: 'success', offer: 'success' };
export const METRIC_TONES = { discovered: 'active', strong: 'success', attention: 'attention', submitted: 'agent', responded: 'active', interviewing: 'success' };

/** The explanation of what the stage counts mean, shown under the pipeline. */
export const STAGE_NOTE = 'Each job is counted once, in the stage its current status belongs to, so the stages are not an overlapping funnel. Needs Input flags jobs waiting on you and overlaps the stages.';
