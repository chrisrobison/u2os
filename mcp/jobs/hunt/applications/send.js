import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeCompany, normalizeRole } from '../jobs/normalize.js';

// Turns a job's outreach draft into a gated email.send proposal and keeps the
// emails ledger honest. This module never sends anything itself: `propose`
// is injected and is the agent's policy-gated pipeline, which decides whether
// the owner must approve. Everything here is restart-safe: the idempotency
// key is checked before any proposal, and an uncertain outcome blocks all
// further automatic sends for that job.

const BLOCKING = new Set(['proposing', 'proposed', 'sent', 'uncertain']);

export function idempotencyKey({ candidate, job, to, kind = 'application' }) {
  return crypto.createHash('sha256').update([candidate, normalizeCompany(job.company), normalizeRole(job.role), job.id, `email.send:${kind}`, String(to).toLowerCase()].join('\n')).digest('hex');
}

/** Reasons a send must not go ahead, from the ledger and the job (no side effects). */
export function sendBlockers({ store, job, score, minimumScore, kind = 'application' }) {
  const reasons = [];
  if (!score) reasons.push('the job has not been scored');
  else if (score.degraded) reasons.push('the score is degraded (no model)');
  else if (score.score < minimumScore) reasons.push(`score ${score.score} is below the threshold ${minimumScore}`);
  if (['applied', 'contacted', 'rejected', 'withdrawn', 'closed', 'skipped', 'interview'].includes(job.status)) reasons.push(`the job is already ${job.status}`);
  for (const email of store.listEmails(job.id).filter((entry) => entry.kind === kind && BLOCKING.has(entry.status))) {
    reasons.push(email.status === 'uncertain' ? `an earlier send to ${email.to} has an uncertain outcome: check Sent mail, then resolve it` : email.status === 'proposing' ? `an earlier attempt to email ${email.to} did not finish: check the approvals and Sent mail first` : `an email to ${email.to} is already ${email.status}`);
  }
  return reasons;
}

export async function proposeApplicationEmail({ store, job, candidateEmail, minimumScore, propose, force = false, followUpDays = 5, now = new Date() }) {
  const score = store.getScore(job.id);
  const artifacts = store.getArtifacts(job.id);
  if (!artifacts.email_json) throw new Error('No email draft for this job: run "job materials" first (the listing may have no contact address)');
  const draft = JSON.parse(fs.readFileSync(artifacts.email_json.path, 'utf8'));
  if (draft.needsInput?.length) throw new Error(`The listing asks for things your facts do not cover: ${draft.needsInput.join('; ')}. Add them to facts.md and rerun "job materials --force"`);
  const blockers = sendBlockers({ store, job, score, minimumScore });
  if (blockers.length && !force) throw Object.assign(new Error(`Not sending: ${blockers.join('; ')}`), { code: 'BLOCKED', blockers });
  if (blockers.length && force && blockers.some((reason) => /already|uncertain/.test(reason))) throw Object.assign(new Error(`Not sending even with --force: ${blockers.join('; ')}`), { code: 'BLOCKED', blockers });
  if (!Array.isArray(draft.attachments) || draft.attachments.length === 0) throw new Error('The draft has no staged attachments: rerun "job materials --force" so the resume is staged');

  const key = idempotencyKey({ candidate: candidateEmail, job, to: draft.to });
  // Record the intent before proposing: if the process dies between the two, the key is already taken
  // and the next run sees "proposed" instead of proposing a second time.
  const record = { to: draft.to, subject: draft.subject, body: draft.text, attachments: draft.attachments, status: 'proposing', idempotencyKey: key };
  // A failed or rejected earlier attempt (nothing was sent) is reused; any other existing row was already excluded by sendBlockers.
  const previous = store.findEmailByKey(key);
  let email;
  if (previous) { store.updateEmail(previous.id, { status: 'proposing', actionId: null, detail: { retryOf: previous.status } }, now); email = previous; } else email = store.addEmail(job.id, record, now);
  let outcome;
  try {
    outcome = await propose({ tool: 'email.send', arguments: { to: draft.to, subject: draft.subject, body: draft.text, attachments: draft.attachments }, requestText: `Application email for ${job.company} - ${job.role ?? ''}`.trim(), reasoning: `Score ${score.score}: ${score.reasons.slice(0, 2).join('; ')}` });
  } catch (error) {
    // The proposal itself failed before anything was queued; free the key.
    store.updateEmail(email.id, { status: 'failed', detail: { error: String(error.message).slice(0, 300) } }, now);
    throw error;
  }
  const status = outcome.status === 'executed' ? 'sent' : outcome.status === 'pending' ? 'proposed' : outcome.status === 'blocked' ? 'blocked' : 'failed';
  store.updateEmail(email.id, { status, actionId: outcome.id, detail: { gate: outcome.status, reason: outcome.reason ?? null } }, now);
  store.recordEvent(job.id, 'email_proposed', { detail: { emailId: email.id, actionId: outcome.id, gate: outcome.status, to: draft.to } }, now);
  if (status === 'sent') markContacted({ store, job, emailId: email.id, followUpDays, now });
  return { email: store.listEmails(job.id).find((entry) => entry.id === email.id), outcome };
}

function markContacted({ store, job, emailId, followUpDays, now }) {
  const due = new Date(now.getTime() + followUpDays * 86_400_000).toISOString();
  store.updateEmail(emailId, { status: 'sent', detail: { sentAt: now.toISOString(), followUpAfter: due } }, now);
  store.transition(job.id, 'contacted', { emailId, followUpAfter: due }, now);
}

/**
 * Moves proposed emails along using the gate's recorded outcome for each
 * action. `lookup(actionId)` returns { status, result } or null.
 */
export function reconcileEmails({ store, lookup, followUpDays = 5, now = new Date() }) {
  const changes = [];
  for (const email of store.listEmails().filter((entry) => entry.status === 'proposed' && entry.actionId)) {
    const action = lookup(email.actionId);
    if (!action) continue;
    const job = store.getJob(email.jobId);
    if (action.status === 'executed') { markContacted({ store, job, emailId: email.id, followUpDays, now }); changes.push({ email, to: 'sent' }); }
    else if (['rejected', 'cancelled', 'blocked'].includes(action.status)) { store.updateEmail(email.id, { status: 'rejected', detail: { gate: action.status } }, now); store.recordEvent(job.id, 'email_not_sent', { detail: { emailId: email.id, gate: action.status } }, now); changes.push({ email, to: 'rejected' }); }
    else if (action.status === 'failed') {
      const uncertain = /uncertain/i.test(JSON.stringify(action.result ?? ''));
      store.updateEmail(email.id, { status: uncertain ? 'uncertain' : 'failed', detail: { gate: 'failed', error: String(action.result?.error ?? '').slice(0, 300) } }, now);
      if (uncertain) store.transition(job.id, 'uncertain', { emailId: email.id }, now);
      changes.push({ email, to: uncertain ? 'uncertain' : 'failed' });
    }
  }
  return changes;
}
