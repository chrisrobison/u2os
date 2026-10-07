// How to approach a job, from structured facts only (never from model text).

export const STRATEGIES = ['FORM_APPLICATION', 'DIRECT_EMAIL', 'FORM_AND_EMAIL', 'CONTACT_EMPLOYEE', 'MANUAL_REQUIRED', 'SKIP'];

const NO_REPLY = /^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|privacy|legal|unsubscribe)@/i;

export function contactEmailsFor(job) {
  return (job.contactEmails ?? []).filter((email) => !NO_REPLY.test(email));
}

export function chooseStrategy(job, { score = null, minimumScore = 82 } = {}) {
  if (score && score.score < minimumScore) return { strategy: 'SKIP', reason: `Score ${score.score} is below ${minimumScore}` };
  const emails = contactEmailsFor(job);
  const forms = job.applicationUrls ?? [];
  if (emails.length && forms.length) return { strategy: 'FORM_AND_EMAIL', reason: 'The listing has both an application form and an invited direct contact', email: emails[0], url: forms[0] };
  if (emails.length) return { strategy: 'DIRECT_EMAIL', reason: 'The listing gives an email address to write to', email: emails[0], url: null };
  if (forms.length) return { strategy: 'FORM_APPLICATION', reason: 'The listing links an application page', email: null, url: forms[0] };
  return { strategy: 'MANUAL_REQUIRED', reason: 'The listing has no email address or application link', email: null, url: null };
}

export function needsCoverLetter({ strategy, score }) {
  return ['DIRECT_EMAIL', 'FORM_AND_EMAIL', 'CONTACT_EMPLOYEE'].includes(strategy) || (score?.score ?? 0) >= 80;
}
