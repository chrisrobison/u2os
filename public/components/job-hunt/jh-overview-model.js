import { opportunitiesHref } from './jh-opportunities-model.js';

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

/**
 * The Opportunities table filtered for a summary metric, so the table total equals the number on the card: an explicit
 * status list, the strong-match score floor, Needs Input, or everything. `strongScore` is the payload's strongMatchScore.
 */
export function filterHref(entry, strongScore = 80) {
  if (entry.statuses?.length) return opportunitiesHref({ statuses: entry.statuses });
  if (entry.filter === 'strong') return opportunitiesHref({ minScore: strongScore });
  if (entry.filter === 'needs_input' || entry.flag) return opportunitiesHref({ filter: 'needs_input' });
  return opportunitiesHref();
}

/** The Opportunities table for a pipeline stage: the same status mapping the stage count uses (Needs Input is the flag). */
export function stageHref(stage) {
  return stage.flag || stage.id === 'needs_input' ? opportunitiesHref({ filter: 'needs_input' }) : opportunitiesHref({ stage: stage.id });
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
