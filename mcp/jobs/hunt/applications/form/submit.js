import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeCompany, normalizeRole, canonicalUrl } from '../../jobs/normalize.js';
import { buildApplicationPlan } from './plan.js';
import { resolveDriver } from './driver.js';

// The form application lifecycle against the store: plan, submit, recover.
// Exactly-once is the point: intent is recorded before the click, an
// interrupted submit is "uncertain" and never retried, and one application
// exists per job and form URL.

const FORM_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|breezy\.hr|recruitee\.com|jobvite\.com|applytojob\.com|teamtailor\.com|personio\.|comeet\.com|bamboohr\.com)/i;
const BLOCKING = new Set(['submitting', 'submitted', 'unconfirmed', 'uncertain']);
export const STALE_SUBMITTING_MS = 10 * 60_000;

/** The link most likely to be the application form itself. */
export function chooseApplyUrl(job) {
  const urls = (job.applicationUrls ?? []).filter((url) => /^https?:\/\//i.test(url));
  const rank = (url) => (/\/(apply|application)\b/i.test(url) ? 0 : FORM_HOSTS.test(url) ? 1 : /apply|careers|jobs/i.test(url) ? 2 : 3);
  return urls.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export function formKey({ candidate, job, url }) {
  return crypto.createHash('sha256').update([candidate, normalizeCompany(job.company), normalizeRole(job.role), job.id, 'form_apply', canonicalUrl(url) ?? url].join('\n')).digest('hex');
}

/** The cover letter body only: the system adds the header block; a form field wants the paragraphs. */
function letterBody(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\n\n/).slice(3, -1).join('\n\n').trim() || null; } catch { return null; }
}

function materialsFor(store, job) {
  const artifacts = store.getArtifacts(job.id);
  const pick = (kind) => (artifacts[kind] ? { path: artifacts[kind].path, sha256: artifacts[kind].sha256 } : undefined);
  return { resume: pick('resume_pdf'), cover_letter: pick('cover_letter_pdf'), combined: pick('combined_pdf'), coverLetterText: artifacts.cover_letter_txt ? letterBody(artifacts.cover_letter_txt.path) : null };
}

/** Plans an application for a job: reads its form (read-only) and stores the plan. */
export async function planApplication({ store, job, candidate, llm = null, driver = null, inspect = null, ensureCombined = null, nameStyle = 'plain', url = null, now = new Date() }) {
  const target = url ?? chooseApplyUrl(job);
  if (!target) throw new Error('This job has no application link');
  const key = formKey({ candidate: candidate.resume.basics.email, job, url: target });
  const existing = store.findApplicationByKey(key);
  if (existing && BLOCKING.has(existing.status)) throw Object.assign(new Error(`An application for this job is already ${existing.status}`), { code: 'BLOCKED' });
  const source = store.listSources(job.id)[0] ?? null;
  const schema = await (inspect ?? ((url) => resolveDriver(driver).inspect({ url })))(target);
  // A form with no cover-letter upload gets the letter and resume as one file: build it now if the materials predate it.
  const hasCoverUpload = (schema.fields ?? []).some((field) => field.type === 'file' && /cover/i.test(`${field.label} ${field.key}`));
  if (!hasCoverUpload && ensureCombined && !store.getArtifacts(job.id).combined_pdf) await ensureCombined({ store, job, now });
  const plan = await buildApplicationPlan({ url: target, schema, job, source, candidate, materials: materialsFor(store, job), llm, nameStyle, now });
  const status = plan.blockers.length ? 'manual_required' : plan.ready ? 'planned' : 'needs_input';
  let application;
  if (existing) { store.updateApplication(existing.id, { status, plan, result: { replanned: now.toISOString() } }, now); application = store.listApplications(job.id).find((entry) => entry.id === existing.id); }
  else application = store.addApplication(job.id, { url: target, status, plan, idempotencyKey: key }, now);
  store.recordEvent(job.id, 'application_planned', { detail: { applicationId: application.id, status, needs: plan.needs, blockers: plan.blockers, unresolved: plan.unresolved.length } }, now);
  return application;
}

/** Marks submits that were interrupted (no outcome recorded) as uncertain. */
export function recoverInterrupted({ store, now = new Date(), staleMs = STALE_SUBMITTING_MS }) {
  const recovered = [];
  for (const application of store.listApplications().filter((entry) => entry.status === 'submitting' && now - Date.parse(entry.updatedAt) > staleMs)) {
    store.updateApplication(application.id, { status: 'uncertain', result: { reason: 'interrupted after the click; outcome unknown' } }, now);
    const job = store.getJob(application.jobId);
    if (job && !['applied', 'contacted'].includes(job.status)) store.transition(job.id, 'uncertain', { applicationId: application.id }, now);
    recovered.push(application);
  }
  return recovered;
}

/**
 * Submits a planned application. `files` resolve plan.files; `driver` (a FormDriver or
 * registered name) does the browser work; `execute` still overrides it. Refuses anything not in a submittable state.
 */
export async function submitApplication({ store, job, files, submit = true, headed = false, driver = null, execute = null, screenshotDir = null, now = new Date(), applicationId = null }) {
  recoverInterrupted({ store, now });
  const application = store.listApplications(job.id).filter((entry) => !applicationId || entry.id === applicationId).at(-1);
  if (!application) throw new Error('No application plan for this job: run "job plan" first');
  if (BLOCKING.has(application.status)) throw Object.assign(new Error(`Not submitting: the application is already ${application.status}${application.status === 'uncertain' ? ' (check the company\'s confirmation email before anything else)' : ''}`), { code: 'BLOCKED' });
  if (application.status !== 'planned') throw Object.assign(new Error(`Not submitting: the plan is ${application.status}${application.plan.needs?.length ? ` (${application.plan.needs.join(', ')})` : ''}`), { code: 'BLOCKED' });
  if (['applied', 'contacted', 'rejected', 'withdrawn', 'closed', 'skipped', 'interview'].includes(job.status)) throw Object.assign(new Error(`Not submitting: the job is already ${job.status}`), { code: 'BLOCKED' });

  const result = await (execute ?? resolveDriver(driver).execute)({
    plan: application.plan, files, submit, headed, screenshotDir,
    beforeSubmit: async () => {
      // Intent first: from here a crash means "uncertain", never "try again".
      store.updateApplication(application.id, { status: 'submitting' }, new Date());
      store.recordEvent(job.id, 'application_submitting', { detail: { applicationId: application.id, url: application.url } }, new Date());
    },
  });
  const done = new Date();
  const map = { submitted: 'submitted', unconfirmed: 'unconfirmed', failed: 'planned', dry_run: 'planned', manual_required: 'manual_required', schema_changed: 'needs_input', files_changed: 'needs_input', fill_incomplete: 'needs_input' };
  const status = map[result.status] ?? 'uncertain';
  store.updateApplication(application.id, { status, result: { outcome: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.errors ? { errors: result.errors } : {}), ...(result.missing?.length ? { missing: result.missing } : {}), ...(result.failed?.length ? { failedFields: result.failed } : {}), screenshots: result.screenshots ?? [], at: done.toISOString() } }, done);
  store.recordEvent(job.id, 'application_result', { detail: { applicationId: application.id, outcome: result.status } }, done);
  if (result.status === 'submitted') store.transition(job.id, 'applied', { applicationId: application.id, url: application.url }, done);
  else if (result.status === 'unconfirmed') store.transition(job.id, 'uncertain', { applicationId: application.id }, done);
  else if (['manual_required', 'schema_changed', 'files_changed', 'fill_incomplete'].includes(result.status)) store.transition(job.id, 'needs_input', { applicationId: application.id, reason: result.reason ?? result.status }, done);
  return { application: store.listApplications(job.id).find((entry) => entry.id === application.id), result };
}
