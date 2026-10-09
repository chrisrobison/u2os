import { buildCorpus, unsupportedClaims } from '../applications/guard.js';
import { extractEmails } from '../jobs/parser.js';
import { candidateCorpus } from '../applications/resume-generator.js';

// The review's deterministic checks. Each is a hard rule: a failure rejects
// the job whatever any model thinks, and no model is consulted to override it.
// They are the same kind of policy as the claim guard and the idempotency
// keys: code, outside the LLM.

const ACTED = new Set(['contacted', 'applied', 'interview', 'rejected', 'withdrawn', 'closed', 'skipped', 'uncertain', 'error']);
const STAFFING = /\b(our client|on behalf of (our|a) client|staffing|recruit(ing|ment) (agency|firm)|c2c|corp[- ]to[- ]corp|w-?2 only|1099 only|commission[- ]only|unpaid|training fee|pay (a|the) fee|work from home and earn|multi[- ]level)\b/i;
// Part-time and token-pay postings: "~10-15 hrs/wk", "part-time", "equity + discretionary cash", "stipend". Not a job the autopilot should apply to unprompted.
const PART_TIME = /\b(part[- ]time|\d+\s*[-\u2013]\s*\d+\s*(hrs?|hours)\s*(\/|per|a)\s*(wk|week)|\d+\s*(hrs?|hours)\s*(\/|per|a)\s*(wk|week)|discretionary (cash|bonus|pay|compensation)|stipend|side project|moonlight|fractional)\b/i;
const EQUITY_ONLY = /\bequity[- ]only\b/i;
const INJECTION = /ignore (all |any )?(previous|prior|above) instructions|disregard (the )?(above|previous)|you are (now )?an? (ai|assistant|language model)|system prompt|as an ai\b|if you are an ai|include the (word|phrase)/i;
const BAD_DOMAINS = /(^|\.)(example|test|invalid|localhost)$|^(example\.(com|org|net))$/i;

const check = (name, pass, detail = '') => ({ name, pass: Boolean(pass), detail: String(detail) });

export function runChecks({ store, job, subject, score, preferences, config, candidate, now = new Date(), verifyAttachments = null }) {
  const out = [];
  const kind = subject.kind;

  // The job and its score.
  out.push(check('scored_by_model', score && !score.degraded, score ? (score.degraded ? 'the score is a rule-based estimate' : '') : 'the job has not been scored'));
  const minimum = preferences.minimum_score ?? 82;
  out.push(check('score_meets_threshold', score && score.score >= minimum, score ? `score ${score.score}, threshold ${minimum}` : ''));
  out.push(check('job_still_open_for_us', !ACTED.has(job.status), `job is ${job.status}`));
  const flags = score?.flags ?? [];
  out.push(check('no_relocation_unless_allowed', !flags.includes('relocation_required') || config.allow.relocation, flags.includes('relocation_required') ? 'the job requires relocation' : ''));
  out.push(check('salary_not_below_minimum_unless_allowed', !flags.includes('salary_below_threshold') || config.allow.below_salary_minimum, flags.includes('salary_below_threshold') ? 'pay is below your minimum' : ''));

  // Duplicates and limits.
  const sentEmails = store.listEmails(job.id).filter((email) => email.kind === 'application' && ['proposing', 'proposed', 'sent', 'uncertain'].includes(email.status));
  const forms = store.listApplications(job.id).filter((application) => ['submitting', 'submitted', 'unconfirmed', 'uncertain'].includes(application.status));
  out.push(check('not_already_contacted', !sentEmails.length && !forms.length, [...sentEmails.map((email) => `email ${email.status}`), ...forms.map((application) => `form ${application.status}`)].join('; ')));
  const dayAgo = now.getTime() - 86_400_000;
  const recentEmails = store.listEmails().filter((email) => email.kind === 'application' && ['sent', 'proposed'].includes(email.status) && Date.parse(email.updatedAt) > dayAgo).length;
  const recentForms = store.listApplications().filter((application) => ['submitted', 'unconfirmed', 'submitting'].includes(application.status) && Date.parse(application.updatedAt) > dayAgo).length;
  out.push(check(kind === 'email' ? 'under_daily_email_limit' : 'under_daily_application_limit', kind === 'email' ? recentEmails < config.limits.emails_per_day : recentForms < config.limits.applications_per_day, kind === 'email' ? `${recentEmails} of ${config.limits.emails_per_day} emails today` : `${recentForms} of ${config.limits.applications_per_day} applications today`));
  const company = job.company.toLowerCase();
  const cutoff = now.getTime() - config.limits.per_company_days * 86_400_000;
  const sameCompany = store.listJobs({ limit: 20000 }).filter((other) => other.id !== job.id && other.company.toLowerCase() === company && ['contacted', 'applied', 'interview'].includes(other.status) && Date.parse(other.updatedAt) > cutoff);
  out.push(check('no_recent_application_to_same_company', !sameCompany.length || config.limits.per_company_days === 0, sameCompany.map((other) => `${other.role ?? 'another role'} (${other.status})`).join('; ')));

  // The posting: staffing/scam shapes and the owner's blocklist.
  const text = `${subject.posting}\n${job.company}`.toLowerCase();
  const staffing = subject.posting.match(STAFFING);
  out.push(check('not_staffing_spam_or_unpaid', !staffing, staffing ? `the posting says "${staffing[0]}"` : ''));
  const partTime = subject.posting.match(PART_TIME);
  out.push(check('not_part_time_or_token_pay_unless_allowed', !partTime || config.allow.part_time, partTime ? `the posting reads as part-time or token pay ("${partTime[0]}"); allow.part_time in autopilot.yaml lets it through` : ''));
  const equityOnly = subject.posting.match(EQUITY_ONLY);
  out.push(check('not_equity_only_unless_allowed', !equityOnly || config.allow.equity_only, equityOnly ? 'the posting says it is equity-only (unpaid until funded); allow.equity_only in autopilot.yaml lets it through' : ''));
  const blocked = config.blocklist.companies.some((name) => company.includes(name)) || config.blocklist.keywords.some((word) => text.includes(word));
  out.push(check('not_on_blocklist', !blocked, blocked ? 'matches your blocklist' : ''));
  const injected = subject.posting.match(INJECTION);
  // Informational: the text is data and is never obeyed, but a human may like to know it tried.
  out.push({ ...check('posting_contains_instructions_for_ai', true, injected ? `the posting contains text aimed at an AI ("${injected[0]}"); it was treated as data` : ''), informational: true });

  if (kind === 'email') {
    const email = subject.email;
    out.push(check('email_draft_present', email && email.to && email.text, email ? '' : 'no email draft'));
    if (email) {
      out.push(check('email_needs_no_input', !email.needsInput.length, email.needsInput.join('; ')));
      const domain = String(email.to).split('@')[1] ?? '';
      out.push(check('recipient_plausible', /^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(email.to) && !BAD_DOMAINS.test(domain) && !config.blocklist.domains.some((d) => domain.toLowerCase().endsWith(d)), email.to));
      out.push(check('recipient_was_invited', extractEmails(subject.invitingText).includes(String(email.to).toLowerCase()), 'the address must appear in the poster\'s own text, written out or obfuscated (not only in stored data)'));
      out.push(check('has_attachments', email.attachments.length > 0, email.attachments.length ? '' : 'no resume attached'));
      if (verifyAttachments && email.attachments.length) {
        let verified = true; let detail = '';
        try { verifyAttachments(email.attachments); } catch (error) { verified = false; detail = error.message; }
        out.push(check('attachments_verify', verified, detail));
      }
    }
  } else {
    const application = subject.application;
    out.push(check('application_plan_present', application, application ? '' : 'no application plan'));
    if (application) {
      out.push(check('plan_ready', application.status === 'planned' && application.plan.ready, `plan is ${application.status}${application.plan.needs?.length ? ` (${application.plan.needs.join(', ')})` : ''}`));
      out.push(check('no_blockers', !(application.plan.blockers ?? []).length, (application.plan.blockers ?? []).join(', ')));
      const modelAnswers = application.plan.fields.filter((field) => field.origin === 'model');
      const corpus = candidateCorpus(candidate);
      const jobCorpus = buildCorpus(`${job.company} ${job.role ?? ''} ${(job.technologies ?? []).join(' ')} ${subject.posting}`);
      const bad = modelAnswers.flatMap((field) => unsupportedClaims(field.value, corpus, jobCorpus));
      out.push(check('form_answers_supported_by_facts', !bad.length, bad.slice(0, 5).join(', ')));
    }
  }

  // Everything generated must still be supported by the owner's facts (catches edited files too).
  const corpus = candidateCorpus(candidate);
  const jobCorpus = buildCorpus(`${job.company} ${job.role ?? ''} ${(job.technologies ?? []).join(' ')} ${subject.posting} ${subject.author ?? ''}`);
  // The letter's header block (name, contact line, date, greeting, sign-off) is written by code from the resume;
  // only the paragraphs and the email body are model text.
  const letterParagraphs = subject.letterText ? subject.letterText.split('\n\n').slice(3, -1).join('\n\n') : '';
  const basics = candidate.resume.basics;
  const basicsCorpus = buildCorpus(JSON.stringify(basics));
  const generated = [letterParagraphs, subject.email?.text, subject.email?.subject].filter(Boolean).join('\n');
  const bad = unsupportedClaims(generated, corpus, jobCorpus, basicsCorpus);
  out.push(check('materials_claims_supported', !bad.length, bad.slice(0, 6).join(', ')));
  out.push(check('resume_present', Boolean(subject.resumeText), subject.resumeText ? '' : 'no tailored resume'));
  return out;
}

export const failedChecks = (checks) => checks.filter((entry) => !entry.pass && !entry.informational);
