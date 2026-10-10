import * as api from '../../services/api.js';
import { interviewForm, taskForm } from './jh-forms.js';
import { el, svg, monogram, safeUrl, titleCase, formatDay, formatStamp, fitBand } from './jh-util.js';

// Job details for the selected card: header with a fit ring, tabs (Overview,
// Fit & Skills, Notes, Activity) and the owner's moves. The server decides
// which moves are allowed (409 otherwise); MOVES only mirrors its rules so
// the buttons offered make sense.

const FROM_SENT = ['applied', 'contacted', 'followup_due', 'uncertain'];
const MOVES = [
  { to: 'screening', label: 'Move to Recruiter Screen', from: FROM_SENT },
  { to: 'offer', label: 'Move to Offer', from: [...FROM_SENT, 'screening', 'interview'] },
  { to: 'rejected', label: 'Mark rejected', from: ['qualified', 'materials_generated', ...FROM_SENT, 'screening', 'interview', 'offer', 'needs_input'] },
];
const MOVED_LABELS = { screening: 'Recruiter Screen', offer: 'Offer', rejected: 'Rejected' };
const TABS = [['overview', 'Overview'], ['fit', 'Fit & Skills'], ['notes', 'Notes'], ['activity', 'Activity']];
const RING_RADIUS = 34;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function fitRing(score, label) {
  const band = fitBand(score?.score);
  const value = score ? Math.max(0, Math.min(100, score.score)) : 0;
  const name = score ? `Fit ${value} percent, ${label || 'scored'}` : 'Not scored yet';
  const root = svg('svg', { class: `jh-ring jh-ring--${band}`, viewBox: '0 0 80 80', role: 'img', 'aria-label': name });
  root.append(
    svg('circle', { class: 'jh-ring__track', cx: 40, cy: 40, r: RING_RADIUS, fill: 'none', 'stroke-width': 7 }),
    svg('circle', { class: 'jh-ring__value', cx: 40, cy: 40, r: RING_RADIUS, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round',
      'stroke-dasharray': `${(CIRCUMFERENCE * value) / 100} ${CIRCUMFERENCE}`, transform: 'rotate(-90 40 40)' }),
    svg('text', { class: 'jh-ring__num', x: 40, y: score ? 41 : 45, 'text-anchor': 'middle' }, score ? `${value}%` : '–'),
    score ? svg('text', { class: 'jh-ring__label', x: 40, y: 54, 'text-anchor': 'middle' }, titleCase(label)) : null);
  return root;
}

// Inline style attributes are not allowed by the page's CSP; the CSSOM is.
function fill(ratio) {
  const node = el('span', { class: 'jh-dim__fill' });
  node.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  return node;
}

const list = (items, className = 'jh-list') => el('ul', { class: className }, items.map((item) => el('li', { text: item })));
const section = (title, ...body) => el('div', { class: 'jh-section' }, el('h4', { class: 'jh-section__title', text: title }), ...body);

export class U2JobDetails extends HTMLElement {
  constructor() {
    super();
    this._built = false;
    this._id = null;
    this._job = null;
    this._tab = 'overview';
    this._seq = 0;
    this._busy = false;
    this._message = null;
    this._shown = '';
    this._form = null;
  }

  connectedCallback() {
    if (!this._built) {
      this._built = true;
      this.classList.add('jh-panel');
      this.setAttribute('role', 'region');
      this.setAttribute('aria-labelledby', 'jh-details-title');
      this._link = el('a', { class: 'jh-link', hidden: true, target: '_blank', rel: 'noopener noreferrer' });
      this._body = el('div', { class: 'jh-details' });
      // The add forms live outside the re-rendered body so a refresh never wipes what is being typed.
      this._formHost = el('div', { class: 'jh-formhost', id: 'jh-formhost' });
      this.append(el('div', { class: 'jh-panel__head' }, el('h2', { id: 'jh-details-title', class: 'jh-panel__title', text: 'Job Details' }), this._link), this._body, this._formHost);
    }
    this._render();
  }

  /** Shows a job, fetching it. Stale responses (the owner clicked elsewhere meanwhile) are dropped. */
  async show(id) {
    if (id !== this._id) { this._id = id; this._job = null; this._message = null; this._shown = ''; this._tab = 'overview'; this._closeForm(); }
    await this._fetch(true);
  }

  /** Re-reads the current job quietly after a refresh or a move. */
  async refresh() { if (this._id) await this._fetch(false); }

  clear() { this._seq += 1; this._id = null; this._job = null; this._shown = ''; this._closeForm(); this._render(); }

  async _fetch(visible) {
    const seq = ++this._seq;
    const id = this._id;
    if (visible) { this._error = null; this._render(); }
    try {
      const job = await api.getJobHuntJob(id);
      if (seq !== this._seq) return;
      this._job = job; this._error = null;
    } catch (err) {
      if (seq !== this._seq) return;
      this._error = err.message;
    }
    this._render();
  }

  _render() {
    if (!this._built) return;
    const job = this._job;
    const signature = JSON.stringify([job, this._tab, this._error, this._message, this._busy, this._id, this._form]);
    if (signature === this._shown) return;
    this._shown = signature;
    const focusTab = this._body.contains(document.activeElement) && document.activeElement.getAttribute?.('role') === 'tab';

    this._body.textContent = '';
    const url = safeUrl(job?.companyUrl);
    this._link.hidden = !url;
    if (url) { this._link.href = url; this._link.textContent = 'View on company site ↗'; }

    if (!this._id) {
      this._body.append(el('p', { class: 'jh-empty', text: 'Select a job in the pipeline to see its details.' }));
      return;
    }
    if (!job) {
      this._body.append(this._error ? el('p', { class: 'load-error', role: 'alert', text: `Couldn't load this job: ${this._error}` }) : el('p', { class: 'jh-empty', text: 'Loading...' }));
      return;
    }
    const where = [job.locations.join('; '), job.remote === true ? 'Remote' : job.remote === false ? 'On-site' : ''].filter(Boolean).join(' · ');
    this._body.append(
      el('div', { class: 'jh-details__head' }, monogram(job.company, 'lg'),
        el('div', { class: 'jh-details__who' },
          el('div', { class: 'jh-details__company', text: job.company }),
          el('h3', { class: 'jh-details__role', text: job.role || '(no role stated)' }),
          where ? el('div', { class: 'jh-details__line', text: where }) : null,
          job.salary ? el('div', { class: 'jh-details__line', text: job.salary }) : null),
        fitRing(job.score, job.score?.label)),
      this._tabs(job),
      this._actions(job));
    if (focusTab) this._body.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  }

  _tabs(job) {
    const tabs = el('div', { class: 'jh-tabs', role: 'tablist', 'aria-label': 'Job details' }, TABS.map(([id, label]) => el('button', {
      type: 'button', role: 'tab', id: `jh-tab-${id}`, class: 'jh-tab', 'aria-selected': String(id === this._tab), 'aria-controls': 'jh-tabpanel',
      tabindex: id === this._tab ? '0' : '-1', 'data-tab': id, text: label,
    })));
    tabs.addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (tab) this._select(tab.dataset.tab); });
    tabs.addEventListener('keydown', (event) => {
      const ids = TABS.map(([id]) => id);
      const at = ids.indexOf(this._tab);
      const next = { ArrowRight: ids[(at + 1) % ids.length], ArrowLeft: ids[(at + ids.length - 1) % ids.length], Home: ids[0], End: ids[ids.length - 1] }[event.key];
      if (!next) return;
      event.preventDefault();
      this._select(next);
    });
    const panel = el('div', { class: 'jh-tabpanel', id: 'jh-tabpanel', role: 'tabpanel', 'aria-labelledby': `jh-tab-${this._tab}`, tabindex: '0' }, this._panel(job));
    return el('div', { class: 'jh-tabset' }, tabs, panel);
  }

  _select(tab) {
    this._tab = tab;
    this._render();
    this._body.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  }

  _panel(job) {
    switch (this._tab) {
      case 'fit': return this._fit(job);
      case 'notes': return el('p', { class: 'jh-empty', text: 'No notes for this job. The job hunt does not store per-job notes yet.' });
      case 'activity': return this._activity(job);
      default: return this._overview(job);
    }
  }

  _overview(job) {
    const excerpt = (job.sources?.[0]?.rawText || '').replace(/\s+/g, ' ').trim();
    const tech = job.technologies || [];
    const parts = [];
    parts.push(el('dl', { class: 'jh-facts' },
      el('dt', { text: 'Status' }), el('dd', { text: titleCase(job.status) }),
      el('dt', { text: 'First seen' }), el('dd', { text: formatDay(job.firstSeenAt) }),
      job.score ? el('dt', { text: 'Suggested angle' }) : null, job.score ? el('dd', { text: titleCase(String(job.score.narrative).replace(/-/g, ' ')) }) : null,
      job.contactEmails?.length ? el('dt', { text: 'Contact' }) : null, job.contactEmails?.length ? el('dd', { text: job.contactEmails.join(', ') }) : null));
    if (excerpt) parts.push(section('From the listing', el('p', { class: 'jh-excerpt', text: excerpt.length > 600 ? `${excerpt.slice(0, 600).trimEnd()}…` : excerpt })));
    if (tech.length) parts.push(el('ul', { class: 'jh-tags', 'aria-label': 'Technologies' }, [...tech.slice(0, 8).map((t) => el('li', { class: 'jh-tag', text: t })), tech.length > 8 ? el('li', { class: 'jh-tag', text: `+${tech.length - 8}` }) : null]));
    if (job.materials?.length) parts.push(section('Materials', list(job.materials.map((m) => m.file))));
    return el('div', {}, parts);
  }

  _fit(job) {
    const score = job.score;
    if (!score) return el('p', { class: 'jh-empty', text: 'This job has not been scored yet.' });
    const parts = [];
    parts.push(el('p', { class: 'jh-summary', text: `${score.score} out of 100, ${score.label}${score.degraded ? ' (estimated without the model)' : ''}.` }));
    const dims = Object.entries(job.dimensions || {}).filter(([, d]) => d && Number.isFinite(d.points) && Number.isFinite(d.max) && d.max > 0);
    if (dims.length) {
      parts.push(section('How it scored', el('ul', { class: 'jh-dims' }, dims.map(([name, d]) => el('li', { class: 'jh-dim' },
        el('span', { class: 'jh-dim__name', text: titleCase(name) }),
        el('span', { class: 'jh-dim__bar', 'aria-hidden': 'true' }, fill(d.points / d.max)),
        el('span', { class: 'jh-dim__pts', text: `${d.points}/${d.max}` }),
        d.reason ? el('span', { class: 'jh-dim__why', text: d.reason }) : null)))));
    }
    if (score.reasons?.length) parts.push(section('Why it fits', list(score.reasons)));
    if (score.concerns?.length) parts.push(section('Concerns', list(score.concerns, 'jh-list jh-list--concerns')));
    if (score.projects?.length) parts.push(section('Related projects', list(score.projects.map((p) => (typeof p === 'string' ? p : [p.name, p.why].filter(Boolean).join(': '))))));
    if (score.flags?.length) parts.push(el('ul', { class: 'jh-tags', 'aria-label': 'Flags' }, score.flags.map((f) => el('li', { class: 'jh-tag jh-tag--flag', text: titleCase(f) }))));
    return el('div', {}, parts);
  }

  _activity(job) {
    const events = [...(job.events || [])].reverse();
    const emails = job.emails || [];
    if (!events.length && !emails.length) return el('p', { class: 'jh-empty', text: 'Nothing has happened with this job yet.' });
    const parts = [];
    if (events.length) {
      parts.push(el('ol', { class: 'jh-timeline' }, events.map((event) => el('li', { class: 'jh-timeline__item' },
        el('span', { class: 'jh-timeline__what', text: event.type === 'status' ? `${event.fromStatus ? titleCase(event.fromStatus) : 'New'} → ${titleCase(event.toStatus)}${event.detail?.by === 'owner' ? ' (you)' : ''}` : titleCase(event.type) }),
        el('time', { class: 'jh-timeline__when', datetime: event.at, text: formatStamp(event.at) })))));
    }
    if (emails.length) parts.push(section('Emails', list(emails.map((e) => `${e.kind === 'draft' ? 'Draft' : 'Email'} to ${e.to}: ${titleCase(e.status)}`))));
    return el('div', {}, parts);
  }

  _actions(job) {
    const moves = MOVES.filter((move) => move.from.includes(job.status));
    const apply = safeUrl(job.applicationUrls?.[0]);
    const row = el('div', { class: 'jh-actions' });
    for (const move of moves) {
      const button = el('button', { type: 'button', class: move.to === 'rejected' ? 'btn' : 'btn btn-primary', disabled: this._busy, text: move.label });
      button.addEventListener('click', () => this._move(job.id, move.to));
      row.append(button);
    }
    for (const [kind, label] of [['interview', 'Add interview'], ['task', 'Add task']]) {
      const button = el('button', { type: 'button', class: 'btn', 'aria-expanded': String(this._form === kind), 'aria-controls': 'jh-formhost', 'data-form': kind, text: label });
      button.addEventListener('click', () => this._openForm(kind, job));
      row.append(button);
    }
    if (apply) row.append(el('a', { class: 'btn jh-btn-link', href: apply, target: '_blank', rel: 'noopener noreferrer', text: 'Open application ↗' }));
    return el('div', {}, row, el('p', { class: this._messageIsError ? 'load-error' : 'jh-note', role: this._messageIsError ? 'alert' : 'status', text: this._message || '' , hidden: !this._message }));
  }

  _closeForm() {
    this._form = null;
    this._formHost.textContent = '';
  }

  _openForm(kind, job) {
    if (this._form === kind) return this._closeForm();
    this._form = kind;
    const onCancel = () => { this._closeForm(); this._render(); this._body.querySelector(`[data-form="${kind}"]`)?.focus(); };
    const done = (message) => { this._closeForm(); this._messageIsError = false; this._message = message; this.dispatchEvent(new CustomEvent('jh-changed', { bubbles: true, detail: { id: job.id } })); this._fetch(false); };
    const form = kind === 'interview'
      ? interviewForm({ onCancel, async onSubmit(body, fail) {
        try {
          const result = await api.addJobHuntInterview(job.id, body);
          done(!result.created ? 'That interview was already recorded.' : result.moved ? 'Interview added. Moved to Interviewing.' : 'Interview added.');
        } catch (err) { fail(err.message); }
      } })
      : taskForm({ onCancel, async onSubmit(body, fail) {
        try { await api.addJobHuntTask(job.id, body); done('Task added.'); } catch (err) { fail(err.message); }
      } });
    this._formHost.textContent = '';
    this._formHost.append(form);
    this._render();
    form.querySelector('input, select')?.focus();
  }

  async _move(id, to) {
    this._busy = true; this._message = null; this._render();
    try {
      await api.moveJobHuntJob(id, to);
      this._messageIsError = false;
      this._message = `Moved to ${MOVED_LABELS[to]}.`;
      this.dispatchEvent(new CustomEvent('jh-changed', { bubbles: true, detail: { id } }));
    } catch (err) {
      this._messageIsError = true;
      this._message = err.message;
    }
    this._busy = false;
    if (id === this._id) await this._fetch(false);
  }
}

customElements.define('u2-job-details', U2JobDetails);
