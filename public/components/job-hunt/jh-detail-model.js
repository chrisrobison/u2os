import { safeUrl, titleCase } from './jh-util.js';
import { JOB_ID, locationText, statusOf } from './jh-opportunities-model.js';

// Pure helpers for the job detail panel (#634): the selected job in the URL, the primary action chosen from real state,
// and the Match Analysis classification. DOM-free so they can be tested. Everything here reads the job detail from
// GET /api/job-hunt/jobs/:id and invents nothing: a section the data cannot support stays empty.

export { JOB_ID };
export const STRONG_MATCH = 80; // mirrors STRONG_MATCH_SCORE (mcp/jobs/hunt/overview.js)

// ---- the selected job in the URL hash ------------------------------------------

/** The `job` query value of a hash when it is a job id; null otherwise. */
export function jobFromHash(hash) {
  const value = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '').get('job');
  return JOB_ID.test(String(value ?? '')) ? value : null;
}

/** The hash with `job` set to `id` (or removed for null), leaving every other parameter exactly as it was. */
export function withJobInHash(hash, id) {
  const [path, query = ''] = String(hash ?? '').split('?');
  const params = new URLSearchParams(query);
  params.delete('job');
  if (JOB_ID.test(String(id ?? ''))) params.set('job', id);
  const text = params.toString().replace(/%2C/g, ',');
  return text ? `${path}?${text}` : path;
}

// ---- header ----------------------------------------------------------------------

export function headerFacts(job) {
  const posted = (job.sources ?? []).map((source) => source.postedAt).filter(Boolean).sort().at(-1) ?? null;
  return {
    where: locationText({ locations: job.locations, remote: job.remote }),
    compensation: job.salary || null,
    postedAt: posted,
    status: statusOf({ status: job.status, needsInput: Boolean(job.attention?.needsYou) }),
    postingUrl: safeUrl(job.applicationUrls?.[0]) ?? safeUrl(job.sources?.find((source) => safeUrl(source.url))?.url) ?? null,
  };
}

// ---- actions ---------------------------------------------------------------------

const ready = (job) => { const attempt = job?.applications?.[0]; return Boolean(attempt && attempt.status === 'planned' && attempt.plan?.ready); };

/**
 * The one action to offer first, from real state (`actions` is jobActions(job) from u2-job-actions.js):
 *  - settled jobs offer none (only the posting link);
 *  - unanswered questions: answer them;
 *  - a planned, ready application: review and approve (opens the Application tab; approval stays two-step);
 *  - a failed attempt or an error: plan again;
 *  - nothing prepared yet: prepare (plan the form, which sends nothing);
 *  - otherwise: open the posting.
 * Returns { key, label, type: 'answers' | 'review' | 'task' | 'link', href? } or null.
 */
export function primaryAction(job, actions) {
  if (!job || !actions) return null;
  const posting = headerFacts(job).postingUrl;
  const link = posting ? { key: 'posting', label: 'Open posting', type: 'link', href: posting } : null;
  if (actions.applied.why) return link; // settled: nothing left to start
  if (actions.answers.count) return { key: 'answers', label: `Answer questions (${actions.answers.count})`, type: 'answers' };
  if (ready(job)) return { key: 'review', label: 'Review and approve', type: 'review' };
  const attempt = job.applications?.[0] ?? null;
  if ((attempt?.status === 'failed' || job.status === 'error') && !actions.online.why) return { key: 'online', label: 'Retry planning', type: 'task' };
  if (!attempt && !job.draft && !(job.materials ?? []).length && !actions.online.why) return { key: 'online', label: 'Prepare application', type: 'task' };
  return link;
}

/** The "more" menu: [{ key, label, why, danger?, href? }] with the reason an item is unavailable. */
export function menuActions(job, actions, primary) {
  const items = [
    { key: 'prefill', label: 'Open and pre-fill application', why: actions.prefill.why },
    { key: 'online', label: 'Apply online (plan and review)', why: actions.online.why },
    { key: 'send', label: 'Apply via email', why: actions.send.why },
    { key: 'draft', label: 'Prepare email draft', why: actions.draft.why },
    { key: 'answers', label: actions.answers.count ? `Answer questions (${actions.answers.count})` : 'Answer questions', why: actions.answers.why },
    { key: 'applied', label: 'Mark applied', why: actions.applied.why },
    { key: 'reject', label: 'Mark not interested', why: actions.reject.why, danger: true },
  ];
  return items.filter((item) => item.key !== primary?.key);
}

// ---- Match Analysis ----------------------------------------------------------------

const DETERMINISTIC = { location: 'relocation_required', compensation: 'salary_below_threshold' };
const RULES = 'Your preferences compared with the posting (rules, no model)';
const EVIDENCE_CHECKS = {
  form_answers_supported_by_facts: ['Every form answer is supported by your facts', 'A form answer is not supported by your facts'],
  materials_claims_supported: ['The resume and letter claim nothing your facts do not support', 'The resume or letter makes a claim your facts do not support'],
};
const RULE_GAP_CHECKS = { no_relocation_unless_allowed: 'The role needs relocation', salary_not_below_minimum_unless_allowed: 'The salary is below your minimum' };
const CAVEAT_CONCERN = /Scored by rules without a model|Model unavailable/i;
const DETERMINISTIC_CONCERN = { location: /relocat|on-site|remote|location/i, compensation: /range|salary|compensation|minimum/i };

export const MATCH_LIMITATIONS = [
  'The posting is not split into individual requirements yet, so this lists the scorer\'s stored reasons and the review checks rather than a line-by-line comparison.',
  'No evidence from your facts is stored next to a model judgement, so a match the scorer judged stays unverified until evidence resolution exists (planned for Phase 5 of the redesign, #626).',
];

const dateText = (iso) => (iso ? String(iso).slice(0, 10) : '');

/**
 * Classifies what the stored data says about the fit, never more:
 *  - verified: backed by a stored source (a rule over the posting and your preferences, a project of yours with its link,
 *    a passing review check);
 *  - unverified: a model judgement with no stored source, a failed evidence check, a question with no answer on file, a
 *    concern nobody confirmed, or something the posting leaves out. This is missing evidence, not missing experience;
 *  - gaps: confirmed by a rule (relocation, pay below your minimum) and nothing else.
 * Each item: { text, source?, sourceUrl?, note?, kind }. Returns { scored, overall, verified, unverified, gaps, caveats }.
 */
export function matchAnalysis(job) {
  const score = job?.score ?? null;
  const result = { scored: Boolean(score), overall: null, verified: [], unverified: [], gaps: [], caveats: [] };
  if (!score) return result;
  result.overall = {
    score: score.score, label: score.label ?? null, degraded: Boolean(score.degraded), model: score.model ?? null, scoredAt: score.scoredAt ?? null,
    confidence: typeof score.confidence === 'number' && Number.isFinite(score.confidence) ? Math.round(score.confidence * 100) : null,
  };
  if (score.degraded) result.caveats.push('This score was estimated by rules without a model, so the model-judged parts below are rough.');

  const dims = job.dimensions ?? {};
  const flags = new Set(score.flags ?? []);
  const handled = new Set();
  for (const [key, flag] of Object.entries(DETERMINISTIC)) {
    const dim = dims[key];
    if (!dim?.reason || !Number.isFinite(dim.points) || !(dim.max > 0)) continue;
    handled.add(key);
    const ratio = dim.points / dim.max;
    if (/not stated/i.test(dim.reason)) result.unverified.push({ kind: 'missing', text: dim.reason, source: RULES, note: 'The posting does not say, so this is missing information, not a gap.' });
    else if (/unclear/i.test(dim.reason)) result.unverified.push({ kind: 'missing', text: dim.reason, source: RULES, note: 'The posting is unclear, so this is not confirmed either way.' });
    else if (flags.has(flag)) result.gaps.push({ kind: 'gap', text: dim.reason, source: RULES });
    else if (ratio >= 0.6) result.verified.push({ kind: 'rule', text: dim.reason, source: RULES });
    else result.unverified.push({ kind: 'missing', text: dim.reason, source: RULES, note: 'Only a partial match on the stored facts.' });
  }

  const modelNote = score.degraded ? 'Estimated by rules without a model.' : 'Judged by the scorer against your profile. No source for this claim is stored.';
  const dimEntries = Object.entries(dims).filter(([key, dim]) => !handled.has(key) && key !== 'projects' && dim?.reason && Number.isFinite(dim.points) && dim.max > 0);
  for (const [key, dim] of dimEntries.sort((a, b) => b[1].points / b[1].max - a[1].points / a[1].max)) {
    const ratio = dim.points / dim.max;
    const note = ratio >= 0.6 ? modelNote : ratio >= 0.3 ? `Partial match per the scorer. ${modelNote}` : `The scorer judged this weak. That is a judgement, not a confirmed gap, because it was not checked against your facts.`;
    result.unverified.push({ kind: 'judged', text: `${titleCase(key)}: ${dim.reason}`, note });
  }

  for (const project of (score.projects ?? []).filter((entry) => entry?.name)) {
    result.verified.push({ kind: 'project', text: `Related project of yours: ${project.name}${project.why ? `. ${project.why}` : ''}`, source: project.url ? 'Your GitHub project' : 'Your project list', sourceUrl: safeUrl(project.url) });
  }

  for (const concern of score.concerns ?? []) {
    const text = String(concern ?? '').trim();
    if (!text || CAVEAT_CONCERN.test(text)) continue;
    if ([...handled].some((key) => DETERMINISTIC_CONCERN[key].test(text))) continue; // shown from its rule above
    result.unverified.push({ kind: 'concern', text, note: 'Raised by the scorer. Nothing in your facts confirms it.' });
  }

  const review = job.reviews?.[0] ?? null;
  if (review) {
    const via = `Review of ${dateText(review.createdAt)} (${titleCase(review.kind)}${review.model ? `, ${review.model}` : ''})`;
    const checks = new Map((review.checks ?? []).map((check) => [check.name, check]));
    for (const [name, [good, bad]] of Object.entries(EVIDENCE_CHECKS)) {
      const check = checks.get(name);
      if (!check || check.informational) continue;
      if (check.pass) result.verified.push({ kind: 'review', text: good, source: via });
      else result.unverified.push({ kind: 'unsupported', text: `${bad}${check.detail ? `: ${check.detail}` : ''}`, source: via, note: 'Your facts do not cover this yet. That is missing evidence, not proof you lack the experience.' });
    }
    for (const [name, text] of Object.entries(RULE_GAP_CHECKS)) {
      const check = checks.get(name);
      if (check && !check.pass && !check.informational && !result.gaps.some((gap) => gap.text.toLowerCase().includes(name === 'no_relocation_unless_allowed' ? 'relocat' : 'range'))) result.gaps.push({ kind: 'gap', text: `${text}${check.detail ? ` (${check.detail})` : ''}`, source: via });
    }
    for (const concern of (review.concerns ?? []).filter((entry) => entry?.text && entry.severity !== 'blocking')) {
      result.unverified.push({ kind: 'concern', text: String(concern.text), source: via, note: `${titleCase(concern.severity || 'minor')} concern from the review agent.` });
    }
  }

  const attempt = job.applications?.[0] ?? null;
  for (const question of (attempt?.plan?.unresolved ?? []).slice(0, 8)) {
    result.unverified.push({ kind: 'missing', text: `No answer on file: ${question.label ?? question.key ?? 'a form question'}`, source: 'Latest application plan', note: 'Answering it adds the missing information. This is not a gap.' });
  }
  return result;
}

// ---- Overview tab ------------------------------------------------------------------

/** Strengths, gaps, uncertainties and blockers for the Overview tab, from stored data only. */
export function overviewModel(job) {
  const match = matchAnalysis(job);
  const score = job?.score ?? null;
  const blockers = [];
  for (const reason of job?.attention?.reasons ?? []) blockers.push({ title: reason.title, items: reason.items ?? [], action: reason.action ?? null });
  return {
    strengths: score?.reasons ?? [],
    gaps: [...match.gaps.map((gap) => gap.text), ...match.unverified.filter((item) => item.kind === 'concern').map((item) => item.text)],
    uncertainties: match.unverified.filter((item) => item.kind !== 'judged' && item.kind !== 'concern').map((item) => item.text),
    blockers,
    match,
  };
}
