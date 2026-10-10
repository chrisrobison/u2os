// Interviews and follow-up tasks tied to jobs (#536). Data lives in the hunt
// store (`interviews`, `job_tasks`); nothing is mirrored into the core
// calendar or tasks tables, so the job hunt stays extractable.
//
// Follow-ups: an email recorded as sent carries `detail.followUpAfter`, and a
// job can sit in `followup_due`. Both are MATERIALIZED as `job_tasks` rows
// (kind `follow_up`) the first time the dashboard is built, keyed by
// `email:<id>` / `status:<jobId>` under a UNIQUE source_key. Materializing is
// INSERT OR IGNORE, so repeated reads never duplicate, and because the row
// persists, completing or snoozing a generated follow-up sticks (a row that
// was completed is never regenerated). An open generated follow-up is hidden
// once its job moves past the sent stage (the company answered).

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const UPCOMING_DAYS = 30;
const OPEN_TASK_LIMIT = 200;
const DONE_TASK_LIMIT = 20;
const RECENT_DONE_DAYS = 7;
const INTERVIEW_LIMIT = 50;

export const INTERVIEW_KINDS = ['phone', 'video', 'onsite', 'other'];
export const LIMITS = { title: 200, round: 80, location: 500, notes: 2000 };
// Statuses from which recording an interview moves the job to `interview`.
export const INTERVIEW_FROM = ['applied', 'contacted', 'followup_due', 'screening', 'uncertain'];
const FOLLOW_UP_OPEN = new Set(['applied', 'contacted', 'followup_due']);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

/** An ISO-8601 instant with an explicit zone, normalized to UTC; throws BAD_INPUT. */
function instant(value, name, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw fail('BAD_INPUT', `${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) throw fail('BAD_INPUT', `${name} must be an ISO 8601 time with a zone, like 2026-10-12T15:00:00Z`);
  return new Date(value).toISOString();
}

function text(value, name, max, { required = false } = {}) {
  if (value == null) {
    if (required) throw fail('BAD_INPUT', `${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw fail('BAD_INPUT', `${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw fail('BAD_INPUT', `${name} is required`);
    return null;
  }
  if (trimmed.length > max) throw fail('BAD_INPUT', `${name} must be at most ${max} characters`);
  return trimmed;
}

function requireJob(store, jobId) {
  const job = store.getJob(jobId);
  if (!job) throw fail('UNKNOWN_JOB', 'No such job');
  return job;
}

function interviewFields(input, { partial = false } = {}) {
  const has = (key) => !partial || Object.hasOwn(input, key);
  const out = {};
  if (has('at')) out.at = instant(input.at, 'at', { required: true });
  if (has('endsAt')) out.endsAt = instant(input.endsAt, 'endsAt');
  if (has('kind')) {
    const kind = input.kind ?? 'video';
    if (!INTERVIEW_KINDS.includes(kind)) throw fail('BAD_INPUT', `kind must be one of ${INTERVIEW_KINDS.join(', ')}`);
    out.kind = kind;
  }
  if (has('round')) out.round = text(input.round, 'round', LIMITS.round);
  if (has('locationOrLink')) out.locationOrLink = text(input.locationOrLink, 'locationOrLink', LIMITS.location);
  if (has('notes')) out.notes = text(input.notes, 'notes', LIMITS.notes);
  return out;
}

function checkOrder(at, endsAt) {
  if (endsAt && endsAt <= at) throw fail('BAD_INPUT', 'endsAt must be after at');
}

/**
 * Records an interview. The job moves to `interview` when its status allows it
 * (INTERVIEW_FROM; same status-event path as every transition, by the owner);
 * otherwise the interview is still recorded and the status is left alone.
 * Idempotent per job and start time: repeating returns the existing row with
 * created: false. Every new interview also logs an `interview_scheduled`
 * application event.
 */
export function addInterview(store, jobId, input, now = new Date()) {
  const fields = interviewFields(input ?? {});
  checkOrder(fields.at, fields.endsAt);
  return store.transaction(() => {
    const job = requireJob(store, jobId);
    const existing = store.findInterview(jobId, fields.at);
    if (existing) return { created: false, moved: false, interview: existing, status: job.status };
    const interview = store.addInterview(jobId, fields, now);
    store.recordEvent(jobId, 'interview_scheduled', { detail: { interviewId: interview.id, at: interview.at, kind: interview.kind, round: interview.round, by: 'owner' } }, now);
    let status = job.status;
    let moved = false;
    if (INTERVIEW_FROM.includes(job.status) && job.status !== 'interview') {
      status = store.transition(jobId, 'interview', { by: 'owner', interviewId: interview.id }, now).status;
      moved = true;
    }
    return { created: true, moved, interview, status };
  });
}

export function updateInterview(store, id, input, now = new Date()) {
  const fields = interviewFields(input ?? {}, { partial: true });
  return store.transaction(() => {
    const current = store.getInterview(id);
    if (!current) throw fail('UNKNOWN_INTERVIEW', 'No such interview');
    const next = { ...current, ...fields };
    checkOrder(next.at, next.endsAt);
    const clash = store.findInterview(current.jobId, next.at);
    if (clash && clash.id !== id) throw fail('CONFLICT', 'This job already has an interview at that time');
    const interview = store.updateInterview(id, fields, now);
    store.recordEvent(current.jobId, 'interview_updated', { detail: { interviewId: id, at: interview.at, by: 'owner' } }, now);
    return { interview };
  });
}

/** Removes an interview. Idempotent: a missing one answers removed: false. The job's status is not rolled back. */
export function deleteInterview(store, id, now = new Date()) {
  return store.transaction(() => {
    const current = store.getInterview(id);
    if (!current) return { removed: false };
    store.deleteInterview(id);
    store.recordEvent(current.jobId, 'interview_removed', { detail: { interviewId: id, at: current.at, by: 'owner' } }, now);
    return { removed: true };
  });
}

export function addTask(store, jobId, input, now = new Date()) {
  const title = text(input?.title, 'title', LIMITS.title, { required: true });
  const dueAt = instant(input?.dueAt, 'dueAt');
  return store.transaction(() => {
    requireJob(store, jobId);
    return { task: store.addTask(jobId, { title, dueAt, kind: 'task' }, now) };
  });
}

function requireTask(store, id) {
  const task = store.getTask(id);
  if (!task) throw fail('UNKNOWN_TASK', 'No such task');
  return task;
}

/** Idempotent: completing a done task keeps its original completion time. */
export function completeTask(store, id, now = new Date()) {
  return store.transaction(() => {
    const task = requireTask(store, id);
    if (task.doneAt) return { changed: false, task };
    return { changed: true, task: store.updateTask(id, { doneAt: now.toISOString() }, now) };
  });
}

export function uncompleteTask(store, id, now = new Date()) {
  return store.transaction(() => {
    const task = requireTask(store, id);
    if (!task.doneAt) return { changed: false, task };
    return { changed: true, task: store.updateTask(id, { doneAt: null }, now) };
  });
}

/**
 * Pushes a task out: `until` (an ISO time in the future, which becomes its new
 * due time) or `days` (1-30), which moves the due time that many days past the
 * later of now and its current due time, so an overdue task lands `days` from
 * now. A done task cannot be snoozed (CONFLICT).
 */
export function snoozeTask(store, id, input, now = new Date()) {
  let until = null;
  let days = null;
  if (input?.until != null) {
    until = instant(input.until, 'until');
    if (until <= now.toISOString()) throw fail('BAD_INPUT', 'until must be in the future');
  } else {
    days = input?.days;
    if (!Number.isInteger(days) || days < 1 || days > 30) throw fail('BAD_INPUT', 'give until (an ISO time) or days (a whole number from 1 to 30)');
  }
  return store.transaction(() => {
    const task = requireTask(store, id);
    if (task.doneAt) throw fail('CONFLICT', 'A completed task cannot be snoozed');
    if (days != null) {
      const base = Math.max(now.getTime(), Date.parse(effectiveDue(task) ?? '') || 0);
      until = new Date(base + days * DAY).toISOString();
    }
    return { task: store.updateTask(id, { snoozedUntil: until }, now) };
  });
}

/** Creates the generated follow-up rows that do not exist yet. Safe to call on every read. */
export function materializeFollowUps(store, now = new Date()) {
  const jobs = new Map(store.listJobs({ limit: 5000 }).map((job) => [job.id, job]));
  const withEmailTask = new Set();
  store.transaction(() => {
    for (const email of store.listEmails()) {
      const job = jobs.get(email.jobId);
      let due = null;
      try { due = email.status === 'sent' ? instant(email.detail?.followUpAfter, 'followUpAfter') : null; } catch { /* an unreadable date is not a follow-up */ }
      if (!job || !due) continue;
      withEmailTask.add(job.id);
      store.addTask(job.id, { title: `Follow up with ${job.company}`, dueAt: due, kind: 'follow_up', sourceKey: `email:${email.id}` }, now);
    }
    // A job marked follow-up due with no emailed follow-up behind it: due since the status changed.
    const since = new Map();
    for (const event of store.listStatusEvents()) if (event.toStatus === 'followup_due') since.set(event.jobId, event.at);
    for (const job of jobs.values()) {
      if (job.status !== 'followup_due' || withEmailTask.has(job.id)) continue;
      store.addTask(job.id, { title: `Follow up with ${job.company}`, dueAt: since.get(job.id) ?? job.updatedAt, kind: 'follow_up', sourceKey: `status:${job.id}` }, now);
    }
  });
}

function ref(job) {
  return { jobId: job.id, company: job.company, role: job.role };
}

/** The dashboard's `interviews`: starting within the next 30 days (or still in progress), soonest first. */
export function upcomingInterviews(store, now = new Date()) {
  const from = new Date(now.getTime() - 4 * HOUR).toISOString(); // an interview that started a moment ago is still on
  const to = new Date(now.getTime() + UPCOMING_DAYS * DAY).toISOString();
  const nowIso = now.toISOString();
  const out = [];
  for (const interview of store.listInterviews({ from, to })) {
    const end = interview.endsAt ?? new Date(Date.parse(interview.at) + HOUR).toISOString();
    if (end < nowIso) continue;
    const job = store.getJob(interview.jobId);
    if (!job) continue;
    out.push({ id: interview.id, ...ref(job), at: interview.at, endsAt: interview.endsAt, kind: interview.kind, round: interview.round, locationOrLink: interview.locationOrLink, notes: interview.notes });
    if (out.length >= INTERVIEW_LIMIT) break;
  }
  return out;
}

const effectiveDue = (task) => (task.snoozedUntil && (!task.dueAt || task.snoozedUntil > task.dueAt) ? task.snoozedUntil : task.dueAt);

/**
 * The dashboard's `tasks`: every open task plus those completed in the last 7
 * days, sorted by due time (undated last). `dueAt` is the effective due time
 * (a snooze pushes it out); `generated` marks follow-ups the system derived.
 */
export function dashboardTasks(store, now = new Date()) {
  materializeFollowUps(store, now);
  const nowIso = now.toISOString();
  const doneSince = new Date(now.getTime() - RECENT_DONE_DAYS * DAY).toISOString();
  const jobs = new Map(store.listJobs({ limit: 5000 }).map((job) => [job.id, job]));
  const rows = [];
  for (const task of store.listTasks()) {
    const job = jobs.get(task.jobId);
    if (!job) continue;
    if (task.doneAt ? task.doneAt < doneSince : task.sourceKey && !FOLLOW_UP_OPEN.has(job.status)) continue;
    rows.push({
      id: task.id, ...ref(job), title: task.title, kind: task.kind, generated: task.sourceKey != null,
      dueAt: effectiveDue(task), snoozedUntil: task.snoozedUntil && task.snoozedUntil > nowIso ? task.snoozedUntil : null, doneAt: task.doneAt,
    });
  }
  const byDue = (a, b) => (a.dueAt === b.dueAt ? a.id - b.id : a.dueAt == null ? 1 : b.dueAt == null ? -1 : a.dueAt < b.dueAt ? -1 : 1);
  const open = rows.filter((row) => !row.doneAt).sort(byDue).slice(0, OPEN_TASK_LIMIT);
  const done = rows.filter((row) => row.doneAt).sort((a, b) => (a.doneAt < b.doneAt ? 1 : -1)).slice(0, DONE_TASK_LIMIT);
  return [...open, ...done];
}
