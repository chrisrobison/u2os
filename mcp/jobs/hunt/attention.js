// Why a job needs the owner, in words. Pure: built from what is already
// stored (the job, its application attempts and its reviews), so the Job
// details page and the lists can say the same thing.

const SETTLED = new Set(['applied', 'contacted', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'closed', 'skipped']);

const UNRESOLVED = {
  unknown_required_field: 'U2OS has no answer for this required question',
  options_do_not_match_yes_no: 'the choices do not read as yes or no, so U2OS will not guess',
  sensitive_never_inferred: 'a sensitive question U2OS never answers for you',
};
const BLOCKERS = {
  captcha: 'The form shows a CAPTCHA. U2OS never solves or evades one; finish this application yourself.',
  login_required: 'The form needs you to sign in. Finish this application yourself.',
  no_form: 'No application form could be read on that page (an embedded or unsupported form). Apply yourself, or use the Chrome extension.',
  password: 'The form needs you to sign in. Finish this application yourself.',
};
const CHECKS = {
  scored_by_model: 'The score came from rules, not a model',
  score_meets_threshold: 'The score is below your minimum',
  job_still_open_for_us: 'The job is no longer open for an application',
  no_relocation_unless_allowed: 'The role needs relocation',
  salary_not_below_minimum_unless_allowed: 'The salary is below your minimum',
  not_already_contacted: 'You have already contacted or applied to this job',
  under_daily_application_limit: 'The daily application limit is reached',
  under_daily_email_limit: 'The daily email limit is reached',
  no_recent_application_to_same_company: 'You applied to this company recently',
  not_staffing_spam_or_unpaid: 'It looks like a staffing, spam or unpaid posting',
  not_part_time_or_token_pay_unless_allowed: 'It reads as part-time or token pay',
  not_equity_only_unless_allowed: 'It reads as equity-only pay',
  not_on_blocklist: 'The company, domain or a keyword is on your blocklist',
  application_plan_present: 'There is no application plan',
  plan_ready: 'The application plan is not ready',
  no_blockers: 'The form has a blocker',
  form_answers_supported_by_facts: 'A form answer is not supported by your facts',
  materials_claims_supported: 'The resume or letter makes a claim your facts do not support',
  resume_present: 'The resume is missing or changed since it was approved',
};

const label = (item) => String(item?.label ?? item?.key ?? 'A field').slice(0, 300);

/**
 * { needsYou, reasons: [{ kind, title, items, action }] } for one job.
 * `applications` and `reviews` are newest first.
 */
export function jobAttention({ job, applications = [], reviews = [], needsInput = [] }) {
  const reasons = [];
  const app = applications[0] ?? null;
  const review = reviews[0] ?? null;

  if (job.status === 'uncertain' || app?.status === 'uncertain' || app?.status === 'submitting') {
    reasons.push({ kind: 'uncertain', title: 'An application may have been sent, but the outcome is unknown',
      items: [app?.result?.reason ? String(app.result.reason).slice(0, 200) : 'U2OS did not see the board confirm it.'],
      action: 'Check your email for the company\'s confirmation. U2OS never retries an uncertain application on its own.' });
  }
  if (SETTLED.has(job.status) && !reasons.length) return { needsYou: false, reasons: [] };

  if (app?.status === 'needs_input') {
    const unresolved = app.plan?.unresolved ?? [];
    reasons.push({ kind: 'needs_answers', title: `${unresolved.length || 'Some'} required question${unresolved.length === 1 ? '' : 's'} could not be answered`,
      items: unresolved.map((item) => `${label(item)}: ${UNRESOLVED[item.reason] ?? item.reason ?? 'unanswered'}`),
      action: 'Answer the standard ones once in job-hunt/answers.yaml, or fill the form in yourself.' });
  } else if (app?.status === 'manual_required') {
    const blockers = app.plan?.blockers ?? [];
    reasons.push({ kind: 'blocked', title: 'The form cannot be filled automatically',
      items: (blockers.length ? blockers : [app.result?.reason]).filter(Boolean).map((code) => BLOCKERS[code] ?? String(code)),
      action: 'Open the application and finish it yourself.' });
  } else if (app?.status === 'unconfirmed') {
    reasons.push({ kind: 'unconfirmed', title: 'The form was filled but no confirmation appeared',
      items: ['The screenshots below show what the board displayed.'],
      action: 'If the form was not actually sent and it read zero fields, it can be replanned with `job plan <job-id> --verified-no-click`. Otherwise check your email before trying again.' });
  } else if (app?.status === 'failed') {
    reasons.push({ kind: 'failed', title: 'The board showed validation errors; nothing was sent', items: (app.result?.errors ?? []).slice(0, 10).map(String), action: 'Fix the plan, then plan and submit again.' });
  }

  if (review?.decision === 'reject') {
    const failed = (review.checks ?? []).filter((check) => !check.pass && !check.informational).map((check) => `${CHECKS[check.name] ?? check.name}${check.detail ? ` (${check.detail})` : ''}`);
    const blocking = (review.concerns ?? []).filter((concern) => concern.severity === 'blocking').map((concern) => String(concern.text));
    reasons.push({ kind: 'review_rejected', title: `The review agent said no (${review.kind})`,
      items: [...failed, ...blocking, ...(!failed.length && !blocking.length && review.notes ? [String(review.notes).slice(0, 400)] : [])],
      action: failed.length ? 'A rule blocked this. Change your settings or skip the job.' : 'Fix the objections (answers, letter) or apply yourself.' });
  }

  if (!reasons.length && job.status === 'needs_input' && needsInput.length) {
    reasons.push({ kind: 'listing_asks', title: 'The listing asks for something your facts do not cover', items: needsInput.map(String), action: 'Add it to your facts or answers, or apply yourself.' });
  }
  return { needsYou: reasons.length > 0, reasons };
}
