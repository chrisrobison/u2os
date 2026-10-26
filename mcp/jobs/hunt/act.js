import fs from 'node:fs';
import path from 'node:path';
import { JOB_HUNT_DIR } from '../profile.js';
import { huntDbPath, openStore } from './storage/store.js';
import { loadCandidate } from './candidate/load.js';
import { loadAutopilotConfig } from './autopilot/config.js';
import { loadSubject, reviewPolicy } from './review/subject.js';
import { failedChecks, runChecks } from './review/checks.js';
import { idempotencyKey, markContacted } from './applications/send.js';
import { submitApplication } from './applications/form/submit.js';

// The two things the autopilot is allowed to do to the outside world, and
// the only way it can: act on a job id. Neither takes a recipient, a body, a
// URL or a file from the caller. Each one:
//   1. needs a review approval for the job's CURRENT content (hash-bound)
//   2. re-runs the deterministic checks now (limits and duplicates may have
//      changed since the review)
//   3. in dry_run mode stops there and records what it would have done
//   4. records intent in the ledger before acting, and never retries an
//      uncertain outcome
// Because the arguments are only a job id, a policy that makes these tools
// autonomous grants far less than making email.send autonomous would.

export class Refused extends Error { constructor(message, code = 'REFUSED') { super(message); this.code = code; } }

export async function withLock(vaultDir, jobId, fn) {
  const dir = path.join(vaultDir, JOB_HUNT_DIR, 'state', 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobId}.lock`);
  try { if (Date.now() - fs.statSync(file).mtimeMs > 15 * 60_000) fs.rmSync(file, { force: true }); } catch { /* none */ }
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); } catch { throw new Refused('Another action for this job is in progress', 'IN_PROGRESS'); }
  try { return await fn(); } finally { fs.rmSync(file, { force: true }); }
}

export function prepare({ vaultDir, jobId, kind, now, resolveAttachments }) {
  const store = openStore(huntDbPath(vaultDir));
  const job = store.getJob(jobId);
  if (!job) { store.close(); throw new Refused(`Unknown job ${jobId}`, 'UNKNOWN_JOB'); }
  const candidate = loadCandidate(vaultDir);
  const config = loadAutopilotConfig(vaultDir);
  const subject = loadSubject({ store, job, kind, policy: reviewPolicy({ preferences: candidate.preferences, config }) });
  const approval = store.validApproval(job.id, kind, subject.contentHash);
  if (!approval) { store.close(); throw new Refused(`Not approved: there is no review approval for the current ${kind} content of this job (it was never reviewed, was rejected, or something changed since)`, 'NOT_APPROVED'); }
  const checks = runChecks({ store, job, subject, score: store.getScore(job.id), preferences: candidate.preferences, config, candidate, now, verifyAttachments: kind === 'email' && resolveAttachments ? (refs) => resolveAttachments(vaultDir, refs) : null });
  const failed = failedChecks(checks);
  if (failed.length) { store.close(); throw new Refused(`Refused by the checks run just now: ${failed.map((entry) => `${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`).join('; ')}`, 'CHECKS_FAILED'); }
  return { store, job, candidate, config, subject, approval };
}

/** Sends the job's reviewed, approved outreach email. */
export function sendApplication({ vaultDir, jobId, mailer, resolveAttachments = null, now = new Date(), followUpDays = 5 }) {
  return withLock(vaultDir, jobId, async () => {
    const { store, job, candidate, config, subject, approval } = prepare({ vaultDir, jobId, kind: 'email', now, resolveAttachments });
    try {
      const email = subject.email;
      if (config.mode !== 'live') {
        store.recordEvent(job.id, 'autopilot_dry_run', { detail: { action: 'send_application', to: email.to, reviewId: approval.id } }, now);
        return { status: 'dry_run', message: `Dry run: would email ${email.to}`, to: email.to };
      }
      if (!mailer) throw new Refused('No mail sender is configured for the autopilot', 'NO_MAILER');
      const key = idempotencyKey({ candidate: candidate.resume.basics.email, job, to: email.to });
      const previous = store.findEmailByKey(key);
      if (previous && !['failed', 'rejected'].includes(previous.status)) throw new Refused(`An email to ${email.to} is already ${previous.status}`, 'ALREADY');
      const record = { kind: 'application', to: email.to, subject: email.subject, body: email.text, attachments: email.attachments, status: 'proposing', idempotencyKey: key, detail: { by: 'autopilot', reviewId: approval.id } };
      let row;
      if (previous) { store.updateEmail(previous.id, { status: 'proposing', detail: { retryOf: previous.status } }, now); row = previous; } else row = store.addEmail(job.id, record, now);
      try {
        await mailer.send({ to: email.to, subject: email.subject, body: email.text, attachments: email.attachments });
      } catch (error) {
        const uncertain = /uncertain/i.test(error.message);
        store.updateEmail(row.id, { status: uncertain ? 'uncertain' : 'failed', detail: { error: String(error.message).slice(0, 300) } }, new Date());
        if (uncertain) store.transition(job.id, 'uncertain', { emailId: row.id }, new Date());
        throw error;
      }
      markContacted({ store, job, emailId: row.id, followUpDays, now: new Date() });
      store.recordEvent(job.id, 'application_email_sent', { detail: { emailId: row.id, to: email.to, by: 'autopilot', reviewId: approval.id } }, new Date());
      return { status: 'sent', to: email.to, company: job.company, role: job.role };
    } finally { store.close(); }
  });
}

/** Submits the job's reviewed, approved application form. */
export function submitApplicationForm({ vaultDir, jobId, execute = null, driver = null, owner = false, now = new Date() }) {
  return withLock(vaultDir, jobId, async () => {
    const { store, job, config, approval } = prepare({ vaultDir, jobId, kind: 'form', now });
    try {
      const artifacts = store.getArtifacts(job.id);
      const files = { ...(artifacts.resume_pdf ? { resume: { path: artifacts.resume_pdf.path } } : {}), ...(artifacts.cover_letter_pdf ? { cover_letter: { path: artifacts.cover_letter_pdf.path } } : {}), ...(artifacts.combined_pdf ? { resume_with_letter: { path: artifacts.combined_pdf.path } } : {}) };
      // The owner pressing the button is the consent to send, whatever the autopilot's mode.
      const live = owner || config.mode === 'live';
      const { result, application } = await submitApplication({ store, job, files, submit: live, headed: config.browser.headed, keepOpen: config.browser.keep_open, driver: driver ?? config.browser.driver, execute, screenshotDir: path.join(vaultDir, JOB_HUNT_DIR, 'state', 'screens', job.id), now });
      store.recordEvent(job.id, live ? 'application_form_submitted' : 'autopilot_dry_run', { detail: { action: 'submit_application', outcome: result.status, applicationId: application.id, by: owner ? 'owner' : 'autopilot', reviewId: approval.id } }, new Date());
      return { status: result.status, company: job.company, role: job.role, ...(result.reason ? { reason: result.reason } : {}), ...(result.errors ? { errors: result.errors } : {}) };
    } finally { store.close(); }
  });
}

/**
 * The owner looked at a planned application and chose to send it. Records the
 * owner's approval (bound to the exact content, like the review agent's) and
 * submits through the same guarded path, live whatever the autopilot's mode.
 * It overrides only the review agent's judgement: a failed deterministic check
 * (limits, duplicates, blocklist, a closed job) still refuses, and the plan
 * must still be the one the owner was shown.
 */
export async function ownerApproveAndSubmit({ vaultDir, jobId, planHash, execute = null, driver = null, now = new Date() }) {
  await withLock(vaultDir, jobId, async () => {
    const store = openStore(huntDbPath(vaultDir));
    try {
      const job = store.getJob(jobId);
      if (!job) throw new Refused(`Unknown job ${jobId}`, 'UNKNOWN_JOB');
      const application = store.listApplications(job.id).filter((entry) => entry.kind === 'form').at(-1);
      if (!application || application.status !== 'planned' || application.plan?.ready !== true) throw new Refused('There is no ready application plan to submit', 'NOT_READY');
      if (!planHash || application.planHash !== planHash) throw new Refused('The plan changed since you looked at it. Reload the page and look again.', 'STALE_PLAN');
      const candidate = loadCandidate(vaultDir);
      const config = loadAutopilotConfig(vaultDir);
      const subject = loadSubject({ store, job, kind: 'form', policy: reviewPolicy({ preferences: candidate.preferences, config }) });
      const checks = runChecks({ store, job, subject, score: store.getScore(job.id), preferences: candidate.preferences, config, candidate, now });
      const failed = failedChecks(checks);
      if (failed.length) throw new Refused(`Refused by the checks: ${failed.map((entry) => `${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`).join('; ')}`, 'CHECKS_FAILED');
      const review = store.addReview(job.id, { kind: 'form', decision: 'approve', contentHash: subject.contentHash, checks, concerns: [], notes: 'Approved by the owner from the app, after looking at the planned answers.', model: 'owner' }, now);
      store.recordEvent(job.id, 'owner_approved', { detail: { kind: 'form', reviewId: review.id, applicationId: application.id } }, now);
    } finally { store.close(); }
  });
  return submitApplicationForm({ vaultDir, jobId, execute, driver, owner: true, now });
}

/**
 * Opens the job's application form in a visible browser, fills the planned answers and leaves the window open.
 * Nothing is submitted and no approval is involved: the owner looks at the filled form and sends it themselves
 * (then marks the job applied). A form the plan could not answer is not filled with guesses; callers plan first.
 */
export function prefillApplicationForm({ vaultDir, jobId, execute = null, driver = null, now = new Date() }) {
  return withLock(vaultDir, jobId, async () => {
    const store = openStore(huntDbPath(vaultDir));
    try {
      const job = store.getJob(jobId);
      if (!job) throw new Refused(`Unknown job ${jobId}`, 'UNKNOWN_JOB');
      const application = store.listApplications(job.id).filter((entry) => entry.kind === 'form').at(-1);
      if (!application || application.status !== 'planned' || application.plan?.ready !== true) throw new Refused('There is no ready application plan to fill in', 'NOT_READY');
      const config = loadAutopilotConfig(vaultDir);
      const artifacts = store.getArtifacts(job.id);
      const files = { ...(artifacts.resume_pdf ? { resume: { path: artifacts.resume_pdf.path } } : {}), ...(artifacts.cover_letter_pdf ? { cover_letter: { path: artifacts.cover_letter_pdf.path } } : {}), ...(artifacts.combined_pdf ? { resume_with_letter: { path: artifacts.combined_pdf.path } } : {}) };
      const { result } = await submitApplication({ store, job, files, submit: false, prefill: true, headed: true, keepOpen: true, driver: driver ?? config.browser.driver, execute, screenshotDir: path.join(vaultDir, JOB_HUNT_DIR, 'state', 'screens', job.id), now });
      return { status: result.status, company: job.company, role: job.role, url: application.url, ...(result.reason ? { reason: result.reason } : {}), ...(result.missing?.length ? { missing: result.missing } : {}) };
    } finally { store.close(); }
  });
}
