import * as api from '../../services/api.js';
import { el, monogram, safeUrl, titleCase, formatStamp, emptyNote } from './jh-util.js';
import { fitRing } from './u2-job-details.js';

// #/job-hunt/jobs/<id>: everything U2OS knows about one job on one page, and,
// when the job needs the owner, what is needed. Read only: the owner's moves
// (send, move to a stage) stay where they are.

const JOB_ID = /^job_[0-9a-f]{16}$/;
const section = (title, ...body) => el('section', { class: 'jh-page__section' }, el('h3', { class: 'jh-section__title', text: title }), ...body);
const list = (items, className = 'jh-list') => el('ul', { class: className }, items.map((item) => el('li', { text: item })));

export class U2JobPage extends HTMLElement {
  constructor() {
    super();
    this._id = null;
    this._job = null;
    this._error = null;
    this._seq = 0;
  }

  /** The job id comes from the route: #/job-hunt/jobs/<id>. */
  set jobId(id) { this._id = id; if (this.isConnected) this._load(); }

  connectedCallback() {
    this.classList.add('jh-page');
    this._render();
    if (this._id) this._load();
  }

  async _load() {
    const seq = ++this._seq;
    this._job = null; this._error = null;
    this._render();
    if (!JOB_ID.test(String(this._id))) { this._error = 'That is not a job id.'; this._render(); return; }
    try {
      const job = await api.getJobHuntJob(this._id);
      if (seq !== this._seq) return;
      this._job = job;
    } catch (err) {
      if (seq !== this._seq) return;
      this._error = /No such job/.test(err.message) ? 'There is no such job.' : err.message;
    }
    this._render();
  }

  _render() {
    this.textContent = '';
    const back = el('a', { class: 'jh-link jh-page__back', href: '#/job-hunt/leads', text: '← Job Leads' });
    back.addEventListener('click', (event) => { if (history.length > 1 && document.referrer !== '') { event.preventDefault(); history.back(); } });
    this.append(back);
    const job = this._job;
    if (!job) {
      this.append(this._error ? el('p', { class: 'load-error', role: 'alert', text: this._error }) : emptyNote('Loading...'));
      return;
    }
    const where = [job.locations.join('; '), job.remote === true ? 'Remote' : job.remote === false ? 'On-site' : '', job.salary].filter(Boolean).join(' · ');
    const links = [['Company site', job.companyUrl], ...job.applicationUrls.map((url, index) => [index ? `Application link ${index + 1}` : 'Application link', url])]
      .map(([label, url]) => [label, safeUrl(url)]).filter(([, url]) => url);
    this.append(
      el('div', { class: 'jh-details__head' }, monogram(job.company, 'lg'),
        el('div', { class: 'jh-details__who' },
          el('div', { class: 'jh-details__company', text: job.company }),
          el('h2', { class: 'jh-details__role', text: job.role || '(no role stated)' }),
          el('div', { class: 'jh-details__line' }, el('span', { class: 'jh-tag', text: titleCase(job.status) }), where ? ` ${where}` : ''),
          links.length ? el('div', { class: 'jh-details__line' }, links.map(([label, url]) => el('a', { class: 'jh-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: `${label} ↗` }))) : null),
        fitRing(job.score, job.score?.label)),
      this._attention(job),
      this._posting(job),
      this._fit(job),
      this._applications(job),
      this._reviews(job),
      this._materials(job),
      this._people(job),
      this._history(job));
  }

  _attention(job) {
    const attention = job.attention;
    if (!attention?.needsYou) return el('p', { class: 'jh-page__ok', text: 'Nothing is waiting on you for this job.' });
    return el('section', { class: 'jh-page__attention', role: 'region', 'aria-label': 'Needs you', 'data-needs-you': '' },
      el('h3', { class: 'jh-page__attention-title', text: 'Needs you' }),
      attention.reasons.map((reason) => el('div', { class: 'jh-page__reason', 'data-reason': reason.kind },
        el('strong', { text: reason.title }),
        reason.items.length ? list(reason.items) : null,
        reason.action ? el('p', { class: 'jh-page__action', text: reason.action }) : null)));
  }

  _posting(job) {
    const sources = job.sources ?? [];
    return section('Posting',
      job.technologies.length ? el('p', { class: 'jh-details__line', text: `Technologies: ${job.technologies.join(', ')}` }) : null,
      job.contactEmails.length ? el('p', { class: 'jh-details__line', text: `Contact: ${job.contactEmails.join(', ')}` }) : null,
      el('p', { class: 'jh-details__line', text: `First seen ${formatStamp(job.firstSeenAt)}` }),
      sources.length ? sources.map((source) => el('details', { class: 'jh-page__source' },
        el('summary', { text: `${titleCase(source.source)}${source.author ? ` · ${source.author}` : ''}${source.postedAt ? ` · ${formatStamp(source.postedAt)}` : ''}` }),
        el('pre', { class: 'jh-page__text', text: source.rawText || '(no text stored)' }))) : emptyNote('No posting text stored.'));
  }

  _fit(job) {
    const score = job.score;
    if (!score) return section('Fit', emptyNote('Not scored yet.'));
    return section('Fit',
      el('p', { class: 'jh-details__line', text: `${score.score}% · ${titleCase(score.label)}${score.degraded ? ' (scored by rules only)' : ''}${job.strategy ? ` · approach: ${titleCase(job.strategy.name)}. ${job.strategy.reason}` : ''}` }),
      score.narrative ? el('p', { text: score.narrative }) : null,
      score.reasons?.length ? [el('h4', { class: 'jh-section__title', text: 'Why it fits' }), list(score.reasons)] : null,
      score.concerns?.length ? [el('h4', { class: 'jh-section__title', text: 'Concerns' }), list(score.concerns, 'jh-list jh-list--concerns')] : null);
  }

  _applications(job) {
    const attempts = job.applications ?? [];
    return section('Application attempts',
      attempts.length ? attempts.map((attempt) => this._attempt(job, attempt)) : emptyNote('No form application has been planned.'));
  }

  _attempt(job, attempt) {
    const { plan, result } = attempt;
    const shots = result.screenshots.map((file) => {
      const href = `/api/job-hunt/jobs/${encodeURIComponent(job.id)}/screenshot?path=${encodeURIComponent(file)}`;
      return el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'jh-page__shot' }, el('img', { src: href, alt: `Screenshot ${file.split('/').pop()}`, loading: 'lazy' }));
    });
    return el('article', { class: 'jh-page__attempt', 'data-application': String(attempt.id) },
      el('div', { class: 'jh-details__line' }, el('span', { class: 'jh-tag', text: titleCase(attempt.status) }), ` Attempt ${attempt.id} · ${formatStamp(attempt.updatedAt)} `,
        safeUrl(attempt.url) ? el('a', { class: 'jh-link', href: safeUrl(attempt.url), target: '_blank', rel: 'noopener noreferrer', text: 'Form ↗' }) : null),
      result.outcome || result.reason ? el('p', { class: 'jh-details__line', text: `Outcome: ${[result.outcome, result.reason].filter(Boolean).join(' · ')}` }) : null,
      result.errors.length ? list(result.errors.map(String), 'jh-list jh-list--concerns') : null,
      plan.unresolved.length ? [el('h4', { class: 'jh-section__title', text: 'Unanswered' }), list(plan.unresolved.map((item) => item.label ?? item.key))] : null,
      plan.fields.length ? el('details', { class: 'jh-page__source' }, el('summary', { text: `${plan.fields.length} planned answers` }),
        el('table', { class: 'jh-page__table' }, el('tbody', {}, plan.fields.map((field) => el('tr', {}, el('th', { scope: 'row', text: `${field.label}${field.required ? ' *' : ''}` }), el('td', { text: field.file ? `[file] ${field.file}` : String(field.value ?? '') })))))) : null,
      shots.length ? el('div', { class: 'jh-page__shots' }, shots) : null);
  }

  _reviews(job) {
    const reviews = job.reviews ?? [];
    return section('Reviews', reviews.length ? reviews.map((review) => {
      const failed = review.checks.filter((check) => !check.pass && !check.informational);
      const concerns = review.concerns ?? [];
      return el('article', { class: 'jh-page__attempt', 'data-review': String(review.id) },
        el('div', { class: 'jh-details__line' }, el('span', { class: review.decision === 'approve' ? 'jh-tag' : 'jh-tag jh-tag--flag', text: review.decision === 'approve' ? 'Approved' : 'Rejected' }), ` ${titleCase(review.kind)} · ${formatStamp(review.createdAt)}${review.model ? ` · ${review.model}` : ''}`),
        failed.length ? [el('h4', { class: 'jh-section__title', text: 'Failed checks' }), list(failed.map((check) => `${titleCase(check.name)}${check.detail ? `: ${check.detail}` : ''}`), 'jh-list jh-list--concerns')] : null,
        concerns.length ? [el('h4', { class: 'jh-section__title', text: 'Concerns' }), list(concerns.map((concern) => `${titleCase(concern.severity)}: ${concern.text}`), 'jh-list jh-list--concerns')] : null,
        review.notes ? el('p', { text: review.notes }) : null);
    }) : emptyNote('Not reviewed yet.'));
  }

  _materials(job) {
    return section('Materials and email',
      job.materials.length ? list(job.materials.map((item) => `${titleCase(item.kind)}: ${item.file}`)) : emptyNote('No materials yet.'),
      job.draft ? el('details', { class: 'jh-page__source' }, el('summary', { text: `Email draft to ${job.draft.to}: ${job.draft.subject}` }), el('pre', { class: 'jh-page__text', text: job.draft.text })) : null,
      job.emails.length ? list(job.emails.map((email) => `${titleCase(email.kind)} to ${email.to}: ${titleCase(email.status)} · ${formatStamp(email.updatedAt)}`)) : null);
  }

  _people(job) {
    const contacts = job.contacts ?? [];
    const tasks = job.tasks ?? [];
    const interviews = job.interviews ?? [];
    if (!contacts.length && !tasks.length && !interviews.length) return section('Contacts, tasks and interviews', emptyNote('None yet.'));
    return section('Contacts, tasks and interviews',
      contacts.length ? list(contacts.map((contact) => `${contact.name || contact.email} <${contact.email}> · ${titleCase(contact.roleKind)}`)) : null,
      tasks.length ? list(tasks.map((task) => `${task.doneAt ? '✓ ' : ''}${task.title}${task.dueAt ? ` (due ${formatStamp(task.dueAt)})` : ''}`)) : null,
      interviews.length ? list(interviews.map((interview) => `${formatStamp(interview.at)} · ${titleCase(interview.kind)}${interview.round ? ` · ${interview.round}` : ''}`)) : null);
  }

  _history(job) {
    const events = [...(job.events ?? [])].reverse();
    return section('History', events.length ? el('ol', { class: 'jh-list' }, events.map((event) => el('li', { text: `${formatStamp(event.at)} · ${titleCase(event.type)}${event.toStatus ? ` → ${titleCase(event.toStatus)}` : ''}` }))) : emptyNote('No history yet.'));
  }
}

if (!customElements.get('u2-job-page')) customElements.define('u2-job-page', U2JobPage);
