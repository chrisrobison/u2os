import path from 'node:path';
import { upcomingInterviews, dashboardTasks } from './schedule.js';

// The job-hunt dashboard: pipeline stages with cards, search analytics derived
// from application_events, and resume / cover-letter versions. Self-contained
// on purpose (the job hunt is expected to move to its own repo): it reads only
// the hunt store, and the route that serves it stays thin.

export const STAGES = [
  { id: 'saved', label: 'Saved' },
  { id: 'applied', label: 'Applied' },
  { id: 'screening', label: 'Recruiter Screen' },
  { id: 'interviewing', label: 'Interviewing' },
  { id: 'offer', label: 'Offer' },
  { id: 'rejected', label: 'Rejected' },
];

const STAGE_STATUSES = {
  saved: ['qualified', 'materials_generated'],
  applied: ['applied', 'contacted', 'followup_due'],
  screening: ['screening'],
  interviewing: ['interview'],
  offer: ['offer'],
  rejected: ['rejected'],
};

/**
 * The one place that maps a job status to a pipeline stage. Statuses that are
 * not on the board (discovered, scored, withdrawn, error, uncertain ...) map
 * to null.
 */
export function stageOf(status) {
  for (const [stage, statuses] of Object.entries(STAGE_STATUSES)) if (statuses.includes(status)) return stage;
  return null;
}

const SENT = new Set(['applied', 'contacted']);          // first entry = the application was sent
const REPLIED = new Set(['screening', 'interview', 'offer', 'rejected']); // the company answered
const INTERVIEWED = new Set(['screening', 'interview', 'offer']);         // got past the first filter

const STATUS_LINES = {
  qualified: 'Qualified', materials_generated: 'Materials ready', applied: 'Applied', contacted: 'Emailed',
  followup_due: 'Follow-up due', screening: 'Recruiter screen', interview: 'Interviewing', offer: 'Offer received', rejected: 'Rejected',
};

const DAY = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 30;
const CARDS_PER_STAGE = 100;
const VERSIONS_LIMIT = 50;

function location(job) {
  if (job.locations?.length) return job.locations.join(', ');
  return job.remote ? 'Remote' : null;
}

function card(store, job, at) {
  const score = store.getScore(job.id);
  return {
    id: job.id, company: job.company, role: job.role, location: location(job),
    fit: score ? score.score : null, status: job.status, statusLine: STATUS_LINES[job.status] ?? job.status,
    timestamp: at ?? job.updatedAt, companyUrl: job.companyUrl ?? null,
  };
}

/**
 * Per job, the first time it was sent, the first time it got a reply or an
 * interview-stage status after that, and the first offer. Event-derived, so
 * it works for any job whose transitions were recorded.
 */
function milestones(events) {
  const byJob = new Map();
  for (const event of events) {
    const m = byJob.get(event.jobId) ?? { sentId: null, sentAt: null, replyAt: null, interviewAt: null, offerAt: null, lastAt: null };
    byJob.set(event.jobId, m);
    m.lastAt = event.at;
    if (m.sentId == null && SENT.has(event.toStatus)) { m.sentId = event.id; m.sentAt = event.at; continue; }
    if (m.sentId != null) {
      if (m.replyAt == null && REPLIED.has(event.toStatus)) m.replyAt = event.at;
      if (m.interviewAt == null && INTERVIEWED.has(event.toStatus)) m.interviewAt = event.at;
    }
    if (m.offerAt == null && event.toStatus === 'offer') m.offerAt = event.at;
  }
  return byJob;
}

const inWindow = (at, from, to) => at != null && at >= from && at < to;
const rate = (n, d) => (d > 0 ? n / d : null);

function count(current, previous) {
  return { value: current, previous, change: current - previous };
}

function ratio(n, d, pn, pd) {
  const value = rate(n, d);
  const previous = rate(pn, pd);
  return { value, previous, change: value == null || previous == null ? null : value - previous, numerator: n, denominator: d, previousNumerator: pn, previousDenominator: pd };
}

/**
 * Analytics over [now - days, now) compared with the window before it. Rates
 * are cohort-based: of the jobs first sent in the window, the share that has
 * since been answered (response) or reached a recruiter screen, interview or
 * offer (interview rate). Zero denominators give null, never NaN. See
 * docs/job-hunt.md.
 */
export function computeAnalytics(events, { days = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * DAY).toISOString();
  const prevFrom = new Date(now.getTime() - 2 * days * DAY).toISOString();
  const jobs = [...milestones(events).values()];
  const sentIn = (a, b) => jobs.filter((m) => inWindow(m.sentAt, a, b));
  const cur = sentIn(from, to);
  const prev = sentIn(prevFrom, from);
  const offers = (a, b) => jobs.filter((m) => inWindow(m.offerAt, a, b)).length;
  const sentByDay = {};
  for (const m of cur) { const day = m.sentAt.slice(0, 10); sentByDay[day] = (sentByDay[day] ?? 0) + 1; }
  return {
    window: { days, from, to, previousFrom: prevFrom },
    applicationsSent: count(cur.length, prev.length),
    responseRate: ratio(cur.filter((m) => m.replyAt).length, cur.length, prev.filter((m) => m.replyAt).length, prev.length),
    interviewRate: ratio(cur.filter((m) => m.interviewAt).length, cur.length, prev.filter((m) => m.interviewAt).length, prev.length),
    offers: count(offers(from, to), offers(prevFrom, from)),
    sentByDay: Object.entries(sentByDay).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, n]) => ({ date, count: n })),
  };
}

function resumeVersions(store, jobsById) {
  const groups = new Map();
  for (const artifact of store.listArtifactsByKind(['resume_pdf', 'cover_letter_pdf'])) {
    const key = `${artifact.kind}:${artifact.sha256}`;
    const group = groups.get(key) ?? { kind: artifact.kind, file: path.basename(artifact.path), sha256: artifact.sha256.slice(0, 12), updatedAt: artifact.createdAt, job: artifact.jobId, usedBy: new Set() };
    groups.set(key, group);
    group.usedBy.add(artifact.jobId);
    if (artifact.createdAt > group.updatedAt) { group.updatedAt = artifact.createdAt; group.job = artifact.jobId; }
  }
  const ref = (id) => { const job = jobsById.get(id); return job ? { id, company: job.company, role: job.role } : { id, company: null, role: null }; };
  return [...groups.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, VERSIONS_LIMIT)
    .map((g) => ({ kind: g.kind, file: g.file, sha256: g.sha256, updatedAt: g.updatedAt, job: ref(g.job), usedBy: [...g.usedBy].map(ref) }));
}

export function buildDashboard(store, { days = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const events = store.listStatusEvents();
  const lastStatusAt = new Map();
  for (const event of events) lastStatusAt.set(event.jobId, event.at);
  const jobs = store.listJobs({ limit: 5000 });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const stages = STAGES.map(({ id, label }) => {
    const members = jobs.filter((job) => stageOf(job.status) === id)
      .map((job) => ({ job, at: lastStatusAt.get(job.id) ?? job.updatedAt }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.job.id < b.job.id ? -1 : 1));
    return { id, label, statuses: STAGE_STATUSES[id], count: members.length, jobs: members.slice(0, CARDS_PER_STAGE).map(({ job, at }) => card(store, job, at)) };
  });
  return { generatedAt: now.toISOString(), stages, analytics: computeAnalytics(events, { days, now }), resumeVersions: resumeVersions(store, jobsById), interviews: upcomingInterviews(store, now), tasks: dashboardTasks(store, now) };
}

// Owner moves. Targets are limited to what only the owner can know (the
// company's answer); everything else is recorded by the pipeline itself.
const PIPELINE = ['qualified', 'materials_generated', 'applied', 'contacted', 'followup_due', 'screening', 'interview', 'offer', 'uncertain', 'needs_input'];
export const MOVE_RULES = {
  screening: ['applied', 'contacted', 'followup_due', 'uncertain'],
  offer: ['applied', 'contacted', 'followup_due', 'screening', 'interview', 'uncertain'],
  rejected: PIPELINE,
};

/**
 * Moves a job to screening, offer or rejected and records the status event.
 * Idempotent: a job already there is returned unchanged with changed: false.
 * Throws an error with code UNKNOWN_JOB, BAD_TARGET or BAD_TRANSITION.
 */
export function moveJob(store, jobId, toStatus, now = new Date()) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!Object.hasOwn(MOVE_RULES, toStatus)) throw fail('BAD_TARGET', `status must be one of ${Object.keys(MOVE_RULES).join(', ')}`);
  return store.transaction(() => {
    const job = store.getJob(jobId);
    if (!job) throw fail('UNKNOWN_JOB', 'No such job');
    if (job.status === toStatus) return { changed: false, job: card(store, job, null) };
    if (!MOVE_RULES[toStatus].includes(job.status)) throw fail('BAD_TRANSITION', `A job that is ${job.status} cannot move to ${toStatus}`);
    const moved = store.transition(jobId, toStatus, { by: 'owner' }, now);
    return { changed: true, job: card(store, moved, now.toISOString()) };
  });
}
