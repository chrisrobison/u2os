import fs from 'node:fs';
import { jobAttention } from './attention.js';
import { milestones } from './dashboard.js';

// The Job Hunt Overview view model (#629): summary metrics, pipeline stage
// counts, the Needs Your Attention queue, recent activity and the autopilot
// indicator, all computed here from the hunt store so the page never
// recomputes counts from full job records. Documented in docs/job-hunt.md.

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

/**
 * "Strong match": a latest score of at least 80. This is the existing line in
 * the code: `scoreLabel()` in jobs/scorer.js calls 80+ "strong" and the Job
 * Leads "Strong (80+)" filter uses the same number. It is not the autonomous
 * threshold (`minimum_score`, default 82), which is a separate setting.
 */
export const STRONG_MATCH_SCORE = 80;

/**
 * The lifecycle stages of the Overview pipeline, in order. `flag: true` marks
 * Needs Input, which is an attention overlay and not a lifecycle stage.
 */
export const OVERVIEW_STAGES = [
  { id: 'discovered', label: 'Discovered', statuses: ['discovered', 'scored', 'researching'] },
  { id: 'qualified', label: 'Qualified', statuses: ['qualified'] },
  { id: 'preparing', label: 'Preparing', statuses: ['materials_generated', 'applying', 'needs_input'] },
  { id: 'needs_input', label: 'Needs Input', statuses: [], flag: true },
  { id: 'submitted', label: 'Submitted', statuses: ['applied', 'contacted', 'followup_due'] },
  { id: 'responded', label: 'Responded', statuses: ['screening'] },
  { id: 'interviewing', label: 'Interviewing', statuses: ['interview'] },
  { id: 'offer', label: 'Offer', statuses: ['offer'] },
];

// Statuses that belong to no stage: the job left the pipeline, or its outcome is unknown (uncertain: it may or may not
// have been sent, so it is not counted as submitted; it shows under Needs Your Attention instead).
export const OFF_PIPELINE_STATUSES = ['rejected', 'withdrawn', 'closed', 'skipped', 'error', 'uncertain'];

const STATUS_STAGE = new Map(OVERVIEW_STAGES.flatMap((stage) => stage.statuses.map((status) => [status, stage.id])));

/** The one place that maps a job status to an Overview stage; null when it is on none (see OFF_PIPELINE_STATUSES). */
export function overviewStageOf(status) {
  return STATUS_STAGE.get(status) ?? null;
}

// ---- autopilot ----------------------------------------------------------------

/**
 * Mode (what the autopilot is allowed to do) and execution (what it is doing
 * now) are separate. mode: paused | dry_run | live. execution: idle |
 * running | degraded (the last cycle reported errors) | blocked (the settings
 * file is invalid, so no cycle can start). Null in, null out.
 */
export function autopilotIndicator(status) {
  if (!status) return null;
  if (status.error || !status.config) return { mode: 'paused', execution: 'blocked', detail: status.error ? String(status.error).slice(0, 200) : 'The autopilot settings could not be read.', lastRunAt: null };
  const { enabled, mode } = status.config;
  const report = status.lastReport ?? null;
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const execution = status.running ? 'running' : errors.length ? 'degraded' : 'idle';
  return {
    mode: !enabled ? 'paused' : mode === 'live' ? 'live' : 'dry_run',
    execution,
    detail: execution === 'degraded' ? String(errors[0]).slice(0, 200) : null,
    lastRunAt: report?.finishedAt ?? report?.startedAt ?? null,
  };
}

// ---- attention ----------------------------------------------------------------

// Blocking severity (higher sorts first): 3 = a possibly sent application nobody has confirmed, 2 = U2OS cannot go on
// and the owner has to act outside U2OS or change settings, 1 = the owner can unblock it here with an answer.
const SEVERITY = { uncertain: 3, unconfirmed: 3, blocked: 2, failed: 2, review_rejected: 2, needs_answers: 1, listing_asks: 1 };
const APPLICATION_STATUSES = ['needs_input', 'manual_required', 'unconfirmed', 'failed', 'uncertain', 'submitting'];
const INTERVIEW_URGENT_DAYS = 7;
const ATTENTION_LIMIT = 20;

function draftNeedsInput(store, jobId) {
  const file = store.getArtifacts(jobId).email_json;
  if (!file) return [];
  try { return JSON.parse(fs.readFileSync(file.path, 'utf8')).needsInput ?? []; } catch { return []; }
}

/**
 * The attention queue: one item per job, from jobAttention(). Sorted by urgency
 * (an interview within 7 days first), then opportunity value (the job's score,
 * unscored last), then blocking severity, then longest waiting first.
 * `question` names the outstanding application question the Review link opens.
 */
export function buildAttention(store, { now = new Date() } = {}) {
  const nowMs = now.getTime();
  const soonest = new Map();
  for (const interview of store.listInterviews({ from: new Date(nowMs - 4 * 3_600_000).toISOString(), to: new Date(nowMs + INTERVIEW_URGENT_DAYS * DAY).toISOString() })) {
    if (!soonest.has(interview.jobId)) soonest.set(interview.jobId, interview.at);
  }
  const items = [];
  for (const id of store.listAttentionCandidateIds({ applicationStatuses: APPLICATION_STATUSES })) {
    const job = store.getJob(id);
    if (!job) continue;
    const applications = store.listApplications(id).reverse();
    const reviews = store.listReviews(id);
    const needsInput = job.status === 'needs_input' ? draftNeedsInput(store, id) : [];
    const attention = jobAttention({ job, applications, reviews, needsInput });
    if (!attention.needsYou) continue;
    const primary = [...attention.reasons].sort((a, b) => (SEVERITY[b.kind] ?? 0) - (SEVERITY[a.kind] ?? 0))[0];
    const unresolved = (applications[0]?.plan?.unresolved ?? []).find((item) => item.key);
    const score = store.getScore(id);
    const deadline = soonest.get(id) ?? null;
    items.push({
      jobId: id, company: job.company, role: job.role, status: job.status,
      score: score ? score.score : null,
      kind: primary.kind, kinds: attention.reasons.map((reason) => reason.kind),
      explanation: primary.title, detail: primary.items[0] ?? null, action: primary.action ?? null,
      severity: SEVERITY[primary.kind] ?? 0,
      urgency: deadline ? 1 : 0, deadline,
      since: applications[0]?.updatedAt ?? job.updatedAt,
      question: primary.kind === 'needs_answers' && unresolved ? { key: String(unresolved.key), label: String(unresolved.label ?? unresolved.key).slice(0, 300) } : null,
    });
  }
  items.sort((a, b) => b.urgency - a.urgency || (b.score ?? -1) - (a.score ?? -1) || b.severity - a.severity || (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) || (a.jobId < b.jobId ? -1 : 1));
  return { count: items.length, items: items.slice(0, ATTENTION_LIMIT) };
}

// ---- recent activity ----------------------------------------------------------

// Only events the owner would call something that happened. Scoring, sourcing, planning, review and dry-run chatter is
// left out; `autopilot_error` and `autopilot_proposed` are the diagnostics that need the owner to act.
const STATUS_ACTIVITY = {
  qualified: ['Qualified', 'agent'], materials_generated: ['Application materials prepared', 'agent'], needs_input: ['Needs your input', 'attention'],
  applied: ['Application sent', 'success'], contacted: ['Application emailed', 'success'], followup_due: ['Follow-up due', 'attention'],
  screening: ['Recruiter screen', 'active'], interview: ['Interviewing', 'active'], offer: ['Offer received', 'success'],
  rejected: ['Rejected', 'danger'], uncertain: ['Application outcome unknown', 'attention'],
};
const TYPE_ACTIVITY = {
  application_email_sent: ['Application email sent', 'success'], owner_approved: ['You approved an application', 'success'],
  interview_scheduled: ['Interview scheduled', 'active'], autopilot_proposed: ['Proposed for your approval', 'attention'], autopilot_error: ['Autopilot hit an error', 'danger'],
};
const ACTIVITY_LIMIT = 12;

export function buildActivity(store, { limit = ACTIVITY_LIMIT } = {}) {
  return store.listRecentActivity({ statuses: Object.keys(STATUS_ACTIVITY), types: Object.keys(TYPE_ACTIVITY), limit }).map((event) => {
    const [label, tone] = event.type === 'status' ? STATUS_ACTIVITY[event.toStatus] : TYPE_ACTIVITY[event.type];
    return { id: event.id, at: event.at, label, tone, jobId: event.jobId, company: event.company, role: event.role };
  });
}

// ---- the overview -------------------------------------------------------------

/**
 * Everything the Overview shows. `autopilot` is autopilot.status() (or null when
 * there is no autopilot). Counts are exact: the stage counts are the number of
 * jobs whose CURRENT status belongs to that stage (a job is in one stage, so
 * the stages add up; Needs Input is a flag over them, not a stage), while
 * Submitted and Responded in `metrics` are event-derived: jobs that have ever
 * been sent / answered, even if they have since moved on.
 */
export function buildOverview(store, { now = new Date(), autopilot = null, minimumScore = null } = {}) {
  const counts = store.counts();
  const total = Object.values(counts).reduce((n, value) => n + value, 0);
  const attention = buildAttention(store, { now });
  const stageCount = new Map(OVERVIEW_STAGES.map((stage) => [stage.id, 0]));
  let offPipeline = 0;
  for (const [status, n] of Object.entries(counts)) {
    const stage = overviewStageOf(status);
    if (stage) stageCount.set(stage, stageCount.get(stage) + n); else offPipeline += n;
  }
  stageCount.set('needs_input', attention.count);
  const since = new Date(now.getTime() - WEEK).toISOString();
  const marks = [...milestones(store.listStatusEvents()).values()];
  const sent = marks.filter((m) => m.sentAt);
  const replied = marks.filter((m) => m.sentAt && m.replyAt);
  const recently = (list, key) => list.filter((m) => m[key] >= since).length;
  const strong = store.countScoredAtLeast(STRONG_MATCH_SCORE);
  const stages = OVERVIEW_STAGES.map(({ id, label, statuses, flag }) => ({ id, label, statuses, count: stageCount.get(id), flag: Boolean(flag) }));
  const metrics = [
    { id: 'discovered', label: 'Jobs discovered', value: total, sub: `+${store.countFirstSeenSince(since)} this week`, filter: 'all', statuses: null },
    { id: 'strong', label: 'Strong matches', value: strong, sub: `score ${STRONG_MATCH_SCORE} or higher`, filter: 'strong', statuses: null },
    { id: 'attention', label: 'Need your attention', value: attention.count, sub: 'questions, reviews, decisions', filter: 'needs_input', statuses: null },
    { id: 'submitted', label: 'Applications submitted', value: sent.length, sub: `${recently(sent, 'sentAt')} in the last 7 days`, filter: null, statuses: ['applied', 'contacted', 'followup_due', 'screening', 'interview', 'offer', 'rejected'] },
    { id: 'responded', label: 'Employer responses', value: replied.length, sub: `${recently(replied, 'replyAt')} in the last 7 days`, filter: null, statuses: ['screening', 'interview', 'offer', 'rejected'] },
    { id: 'interviewing', label: 'Interviewing', value: stageCount.get('interviewing'), sub: 'active now', filter: null, statuses: ['interview'] },
  ];
  return {
    generatedAt: now.toISOString(), strongMatchScore: STRONG_MATCH_SCORE, minimumScore,
    metrics, stages, offPipeline, attention, activity: buildActivity(store), autopilot: autopilotIndicator(autopilot),
  };
}
