import { el, fitBand, formatDay, formatStamp, monogram, safeUrl, titleCase } from './jh-util.js';
import { answersTable } from './u2-job-submit.js';
import { answerableQuestions, sensitiveQuestions } from './jh-answers.js';
import { MATCH_LIMITATIONS, STRONG_MATCH, headerFacts, matchAnalysis, overviewModel } from './jh-detail-model.js';
import './jh-all.js';

// The tabs of the job detail panel (#634), each a function from the job detail (GET /api/job-hunt/jobs/:id) to DOM. Every
// string from the data is written with textContent (through el()) and every link goes through safeUrl or a validated id,
// so a hostile posting cannot become markup. A section with nothing stored says so instead of guessing.

export const TABS = [['overview', 'Overview'], ['match', 'Match Analysis'], ['application', 'Application'], ['company', 'Company'], ['notes', 'Notes']];

const section = (title, ...body) => el('section', { class: 'jh-detail__section' }, el('h3', { class: 'jh-detail__h', text: title }), ...body);
const list = (items, className = 'jh-list') => el('ul', { class: className }, items.map((item) => el('li', { text: item })));
const empty = (text) => el('p', { class: 'jh-empty', text });

/** Company, role, fit score, status, location, pay, posted date and a link to the posting. The heading takes focus on open. */
export function detailHeader(job, headingId) {
  const facts = headerFacts(job);
  const [tone, statusLabel] = facts.status;
  const score = job.score?.score;
  const fit = typeof score === 'number'
    ? el('span', { class: `jh-fit jh-fit--${fitBand(score)}`, 'data-part': 'fit', 'aria-label': `Fit score ${score}`, text: `${score}% fit` })
    : el('span', { class: 'jh-fit jh-fit--none', 'data-part': 'fit', text: 'Not scored' });
  const meta = [facts.where, facts.compensation, facts.postedAt ? `Posted ${formatDay(facts.postedAt)}` : null].filter((part) => part && part !== '—');
  return el('div', { class: 'jh-detail__head' },
    monogram(job.company, 'lg'),
    el('div', { class: 'jh-detail__who' },
      el('div', { class: 'jh-detail__company', 'data-part': 'company', text: job.company }),
      el('h2', { class: 'jh-detail__title', id: headingId, tabindex: '-1', 'data-part': 'heading', text: job.role || '(no role stated)' }),
      el('div', { class: 'jh-detail__badges' }, fit, el('jh-status-label', { tone, label: statusLabel, 'data-part': 'status' })),
      el('p', { class: 'jh-detail__meta', 'data-part': 'meta', text: meta.length ? meta.join(' · ') : 'No location, pay or date stored.' }),
      facts.postingUrl ? el('a', { class: 'jh-link', 'data-part': 'posting', href: facts.postingUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Original posting ↗' }) : null));
}

// ---- Overview ------------------------------------------------------------------------

export function overviewTab(job) {
  const model = overviewModel(job);
  const score = job.score?.score;
  const strongTitle = typeof score === 'number' && score >= STRONG_MATCH ? 'Why this is a strong match' : 'Why it fits';
  const tech = (job.technologies ?? []).slice(0, 14);
  return el('div', { class: 'jh-detail__tab', 'data-tab-body': 'overview' },
    section('Summary',
      el('p', { class: 'jh-detail__line', text: `${job.role || 'This role'} at ${job.company}${job.score ? ` · scored ${job.score.score}% (${titleCase(job.score.label)})` : ' · not scored yet'}.` }),
      job.strategy?.reason ? el('p', { class: 'jh-detail__line', text: `Approach: ${titleCase(job.strategy.name)}. ${job.strategy.reason}` }) : null,
      tech.length ? el('ul', { class: 'jh-tags' }, tech.map((name) => el('li', { class: 'jh-tag', text: name }))) : null),
    section(strongTitle, model.strengths.length ? list(model.strengths) : empty(job.score ? 'The scorer stored no reasons.' : 'This job has not been scored yet.')),
    section('Gaps to address', model.gaps.length ? list(model.gaps, 'jh-list jh-list--concerns') : empty(job.score ? 'No gaps or concerns are recorded.' : 'Nothing to show until the job is scored.')),
    section('Uncertainties', model.uncertainties.length
      ? [list(model.uncertainties.slice(0, 5)), el('button', { type: 'button', class: 'jh-linkbtn', 'data-goto-tab': 'match', text: model.uncertainties.length > 5 ? `See all ${model.uncertainties.length} in Match Analysis` : 'See Match Analysis' })]
      : empty('Nothing is flagged as unverified.')),
    section('Blockers', model.blockers.length
      ? model.blockers.map((blocker) => el('div', { class: 'jh-detail__blocker', 'data-blocker': '' }, el('strong', { text: blocker.title }), blocker.items.length ? list(blocker.items.map(String)) : null, blocker.action ? el('p', { class: 'jh-detail__line', text: blocker.action }) : null))
      : empty('Nothing is blocking this job.')));
}

// ---- Match Analysis --------------------------------------------------------------------

function matchGroup(id, title, items, emptyText) {
  return el('section', { class: 'jh-detail__section jh-match', 'data-match': id, 'aria-labelledby': `jh-match-${id}` },
    el('h3', { class: 'jh-detail__h', id: `jh-match-${id}` }, title, el('span', { class: 'jh-opp__count', 'data-count': id, text: String(items.length) })),
    items.length ? el('ul', { class: 'jh-match__list' }, items.map((item) => el('li', { class: 'jh-match__item', 'data-kind': item.kind },
      el('span', { class: 'jh-match__glyph', 'aria-hidden': 'true', text: id === 'verified' ? '✓' : id === 'gaps' ? '✕' : '?' }),
      el('div', {},
        el('div', { class: 'jh-match__text', text: item.text }),
        item.note ? el('div', { class: 'jh-detail__muted', text: item.note }) : null,
        item.source ? el('div', { class: 'jh-detail__muted', 'data-part': 'source' }, 'Source: ', item.sourceUrl ? el('a', { class: 'jh-link', href: item.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: `${item.source} ↗` }) : item.source) : null)))) : empty(emptyText));
}

export function matchTab(job) {
  const match = matchAnalysis(job);
  if (!match.scored) {
    return el('div', { class: 'jh-detail__tab', 'data-tab-body': 'match' }, el('jh-state', { kind: 'empty', title: 'Not scored yet', message: 'The match analysis is built from the job\'s score, which has not been stored. Nothing is guessed in its place.' }));
  }
  const overall = match.overall;
  const facts = [
    `Overall fit ${overall.score}%${overall.label ? ` (${titleCase(overall.label)})` : ''}`,
    overall.confidence != null ? `scorer confidence ${overall.confidence}%` : null,
    overall.model ? `model ${overall.model}` : (overall.degraded ? 'rules only' : null),
    overall.scoredAt ? `scored ${formatDay(overall.scoredAt)}` : null,
  ].filter(Boolean);
  return el('div', { class: 'jh-detail__tab', 'data-tab-body': 'match' },
    el('p', { class: 'jh-detail__line', 'data-part': 'overall', text: facts.join(' · ') }),
    ...match.caveats.map((text) => el('p', { class: 'jh-note', text })),
    matchGroup('verified', 'Verified match', match.verified, 'Nothing is verified from a stored source yet.'),
    matchGroup('unverified', 'Unverified or insufficient evidence', match.unverified, 'Nothing is flagged as unverified.'),
    matchGroup('gaps', 'Confirmed gap', match.gaps, 'No gap is confirmed by a rule.'),
    el('details', { class: 'jh-detail__limits' }, el('summary', { text: 'What this analysis cannot do yet' }), list(MATCH_LIMITATIONS)));
}

// ---- Application ------------------------------------------------------------------------

/** ctx: { submitEl } the shared "Ready to submit" element (its two-step approval is untouched), { onAnswers(opener) }. */
export function applicationTab(job, ctx) {
  const attempt = job.applications?.[0] ?? null;
  const questions = answerableQuestions(job);
  const sensitive = sensitiveQuestions(job);
  const review = job.reviews?.[0] ?? null;
  const events = [...(job.events ?? [])].reverse().slice(0, 25);
  const answers = el('button', { type: 'button', class: 'btn', 'data-detail-action': 'answers', text: `Answer questions (${questions.length})` });
  answers.addEventListener('click', () => ctx.onAnswers?.(answers));
  return el('div', { class: 'jh-detail__tab', 'data-tab-body': 'application' },
    section('Status', el('p', { class: 'jh-detail__line' }, `${titleCase(job.status)}${attempt ? ` · latest attempt ${titleCase(attempt.status)}` : ' · no application planned'}`),
      attempt && (attempt.result.outcome || attempt.result.reason) ? el('p', { class: 'jh-detail__line', text: `Outcome: ${[attempt.result.outcome, attempt.result.reason].filter(Boolean).join(' · ')}` }) : null,
      attempt?.result.errors?.length ? list(attempt.result.errors.map(String), 'jh-list jh-list--concerns') : null),
    section('Questions', questions.length
      ? [list(questions.map((question) => `${question.label}${question.required ? ' *' : ''}`)), answers]
      : empty('No question is waiting for an answer.'),
    sensitive.length ? el('p', { class: 'jh-detail__muted', text: `${sensitive.length} sensitive question${sensitive.length === 1 ? '' : 's'} U2OS never answers for you.` }) : null),
    section('Approval', ctx.submitEl, review
      ? el('p', { class: 'jh-detail__line', 'data-part': 'review', text: `Latest review: ${review.decision === 'approve' ? 'approved' : 'rejected'} (${titleCase(review.kind)}, ${formatStamp(review.createdAt)}).` })
      : empty('No review has run yet.')),
    section('Materials and draft',
      job.materials?.length ? list(job.materials.map((item) => `${titleCase(item.kind)}: ${item.file}`)) : empty('No resume or letter has been written yet.'),
      job.draft ? el('details', { class: 'jh-page__source' }, el('summary', { text: `Email draft to ${job.draft.to}: ${job.draft.subject}` }), el('pre', { class: 'jh-page__text', text: job.draft.text })) : null,
      job.emails?.length ? list(job.emails.map((email) => `${titleCase(email.kind)} to ${email.to}: ${titleCase(email.status)} · ${formatStamp(email.updatedAt)}`)) : null),
    attempt?.plan.fields.length ? section('Planned answers', el('details', { class: 'jh-page__source' }, el('summary', { text: `${attempt.plan.fields.length} planned answers` }), answersTable(attempt.plan))) : null,
    section('History', events.length ? el('ol', { class: 'jh-list', 'data-part': 'history' }, events.map((event) => el('li', { text: `${formatStamp(event.at)} · ${titleCase(event.type)}${event.toStatus ? ` → ${titleCase(event.toStatus)}` : ''}` }))) : empty('No history yet.')));
}

// ---- Company ----------------------------------------------------------------------------

export function companyTab(job) {
  const site = safeUrl(job.companyUrl);
  const sources = job.sources ?? [];
  const contacts = job.contacts ?? [];
  return el('div', { class: 'jh-detail__tab', 'data-tab-body': 'company' },
    section(job.company,
      site ? el('p', {}, el('a', { class: 'jh-link', href: site, target: '_blank', rel: 'noopener noreferrer', text: 'Company site ↗' })) : empty('No company site is stored.'),
      job.locations?.length ? el('p', { class: 'jh-detail__line', text: `Locations: ${job.locations.join('; ')}` }) : null),
    section('Where U2OS saw this job', sources.length ? el('ul', { class: 'jh-list', 'data-part': 'sources' }, sources.map((source) => {
      const url = safeUrl(source.url);
      const label = `${titleCase(source.source)}${source.author ? ` · ${source.author}` : ''}${source.postedAt ? ` · ${formatDay(source.postedAt)}` : ''}`;
      return el('li', {}, url ? el('a', { class: 'jh-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: `${label} ↗` }) : label);
    })) : empty('No source is stored for this job.')),
    section('Contacts', contacts.length ? list(contacts.map((contact) => `${contact.name || contact.email} <${contact.email}> · ${titleCase(contact.roleKind)}`)) : empty('No contact is stored for this job.')),
    section('Company research', empty('U2OS does not store research about a company yet, so there is nothing to show here. Research you run from Goals is not attached to jobs.'),
      el('a', { class: 'jh-link', href: '#/goals', text: 'Open Goals' })));
}
