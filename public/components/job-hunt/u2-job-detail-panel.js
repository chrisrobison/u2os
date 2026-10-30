import * as api from '../../services/api.js';
import { el } from './jh-util.js';
import { jobActions, jobTasks } from './u2-job-actions.js';
import { openAnswersDialog } from './jh-answers.js';
import { JOB_ID, menuActions, primaryAction } from './jh-detail-model.js';
import { TABS, applicationTab, companyTab, detailHeader, matchTab, overviewTab } from './jh-detail-parts.js';
import './u2-job-submit.js';
import './u2-job-notes.js';
import './jh-all.js';

// The contextual detail panel beside the Opportunities table (#634). `show(jobId)` loads GET /api/job-hunt/jobs/:id and
// shows the header (company, role, fit, status, place, pay, posted date, posting link), one primary action chosen from the
// job's real state, a menu with the rest, and five tabs: Overview, Match Analysis, Application, Company and Notes. Every
// action is an existing one (jobTasks, the answers dialog, the shared <u2-job-submit> with its two-step approval, the
// status endpoint): nothing here can submit or send by itself. Fires `jh-detail-close` (bubbles) from the close button and
// `jh-job-updated` ({ job }) after an action changed the job. Responses that arrive after the owner moved on are ignored.

export class U2JobDetailPanel extends HTMLElement {
  constructor() {
    super();
    this._id = null;
    this._job = null;
    this._error = null;
    this._missing = false;
    this._seq = 0;
    this._tab = 'overview';
    this._busy = null;
    this._notice = null;
    this._focusNext = false;
    this._rescore = null; // the last evidence save or rescore result (shown on the Match Analysis tab)
    this._focusRescore = false;
    // Kept across renders so a submit's progress, the open Ready-to-submit box and unsaved notes survive a redraw.
    this._submitEl = document.createElement('u2-job-submit');
    this._submitEl.addEventListener('jh-job-updated', (event) => { if (event.detail?.job) this._adopt(event.detail.job, { notify: false }); });
    this._notesEl = document.createElement('u2-job-notes');
  }

  get jobId() { return this._id; }
  get tab() { return this._tab; }

  connectedCallback() {
    this.classList.add('jh-detail');
    this.addEventListener('click', (event) => this._onClick(event));
    this.addEventListener('keydown', (event) => this._onKeydown(event));
    this._render();
  }

  disconnectedCallback() { this._seq += 1; }

  /** Opens a job. `focus` moves focus to the panel heading (an owner action); a deep link leaves focus alone. */
  async show(jobId, { focus = false } = {}) {
    if (jobId === this._id && (this._job || this._error === null)) { if (focus) this._focusHeading(); return; }
    await this._leave();
    this._id = jobId;
    this._tab = 'overview';
    this._notice = null;
    this._rescore = null;
    this._busy = null;
    this._focusNext = focus;
    await this._load();
  }

  /** Empties the panel (the owner closed it). */
  async clear() {
    await this._leave();
    this._id = null;
    this._seq += 1;
    this._job = null;
    this._error = null;
    this._render();
  }

  /** Saves unsaved notes before the panel moves on; a failed save is kept as a draft by the notes component. */
  async _leave() {
    try { await this._notesEl.flush(); } catch { /* the draft is kept */ }
    this._notesEl.jobId = null;
  }

  async _load() {
    const seq = ++this._seq;
    const id = this._id;
    this._job = null;
    this._error = null;
    this._missing = false;
    this._render();
    if (!JOB_ID.test(String(id))) { this._error = 'That is not a job id.'; this._render(); return; }
    try {
      const job = await api.getJobHuntJob(id);
      if (seq !== this._seq) return;
      if (!job || job.id !== id) throw new Error('The server sent an unexpected answer.');
      this._job = job;
      this._submitEl.job = job;
    } catch (error) {
      if (seq !== this._seq) return;
      this._missing = /No such job/i.test(error.message);
      this._error = this._missing ? 'This job no longer exists. It may have been removed.' : error.message;
    }
    this._render();
  }

  _adopt(job, { notify = true } = {}) {
    if (!job || job.id !== this._id) return;
    this._job = job;
    this._submitEl.job = job;
    this._render();
    if (notify) this.dispatchEvent(new CustomEvent('jh-job-updated', { bubbles: true, detail: { job } }));
  }

  // ---- rendering -------------------------------------------------------------------

  _focusKey() {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!active?.closest || !this.contains?.(active)) return null;
    for (const attribute of ['data-detail-action', 'data-tab', 'data-evidence-action']) {
      const holder = active.closest(`[${attribute}]`);
      if (holder) return [attribute, holder.getAttribute(attribute)];
    }
    return null;
  }

  _restoreFocus(key) {
    if (!key) return;
    this.querySelector(`[${key[0]}="${key[1]}"]`)?.focus?.();
  }

  _focusHeading() {
    const heading = this.querySelector('[data-part="heading"]');
    if (!heading) return false;
    heading.focus?.();
    return true;
  }

  _bar() {
    const close = el('button', { type: 'button', class: 'btn jh-detail__close', 'data-detail-action': 'close', 'aria-label': 'Close job details', text: 'Close' });
    const full = this._id && JOB_ID.test(this._id) ? el('a', { class: 'jh-link', 'data-part': 'full-page', href: `#/job-hunt/jobs/${this._id}`, text: 'Open full page' }) : null;
    return el('div', { class: 'jh-detail__bar' }, full, close);
  }

  _render() {
    const key = this._focusKey();
    this.setAttribute('role', 'region');
    this.setAttribute('aria-label', 'Job details');
    this.removeAttribute('aria-labelledby');
    if (!this._id) { this.replaceChildren(); return; }
    const job = this._job;
    if (!job) {
      const heading = el('h2', { class: 'jh-detail__title', tabindex: '-1', 'data-part': 'heading', text: this._error ? (this._missing ? 'Job not found' : 'Job details') : 'Loading job...' });
      const retry = this._error && !this._missing ? el('button', { type: 'button', class: 'btn', 'data-detail-action': 'retry', text: 'Try again' }) : null;
      this.replaceChildren(...[this._bar(), heading, this._error
        ? el('jh-state', { kind: 'error', title: this._missing ? 'This job is gone' : "Couldn't load this job", message: this._error })
        : el('jh-state', { kind: 'loading', title: 'Loading the job...' }), retry].filter(Boolean));
      if (this._focusNext) this._focusHeading();
      return;
    }
    const actions = jobActions(job);
    this.replaceChildren(...[
      this._bar(),
      detailHeader(job, 'jh-detail-title'),
      this._actionBar(job, actions),
      this._notice ? el('p', { class: this._notice.error ? 'load-error' : 'jh-page__ok', role: this._notice.error ? 'alert' : 'status', 'data-part': 'notice', text: this._notice.text }) : null,
      this._tabList(),
      el('div', { class: 'jh-detail__panel', role: 'tabpanel', id: 'jh-detail-tabpanel', 'aria-labelledby': `jh-detail-tab-${this._tab}`, tabindex: '0' }, this._tabBody(job))].filter(Boolean));
    this.setAttribute('aria-labelledby', 'jh-detail-title');
    this.removeAttribute('aria-label');
    if (this._focusRescore) { this._focusRescore = false; this.querySelector('[data-part="rescore"]')?.focus?.(); }
    else if (this._focusNext && this._focusHeading()) this._focusNext = false;
    else this._restoreFocus(key);
  }

  _tabList() {
    return el('div', { class: 'jh-detail__tabs', role: 'tablist', 'aria-label': 'Job sections' }, TABS.map(([id, label]) => el('button', {
      type: 'button', class: 'jh-detail__tab-btn', role: 'tab', id: `jh-detail-tab-${id}`, 'data-tab': id, 'aria-selected': String(this._tab === id),
      'aria-controls': 'jh-detail-tabpanel', tabindex: this._tab === id ? '0' : '-1', text: label })));
  }

  _tabBody(job) {
    switch (this._tab) {
      case 'match': return matchTab(job, { rescore: this._rescore, onEvidence: (payload) => this._saveEvidence(payload), onRescore: () => this._rescoreNow() });
      case 'application': return applicationTab(job, { submitEl: this._submitEl, onAnswers: (opener) => this._answers(opener) });
      case 'company': return companyTab(job);
      case 'notes': return this._notesBody();
      default: return overviewTab(job);
    }
  }

  _notesBody() {
    return this._notesEl;
  }

  _actionBar(job, actions) {
    const primary = primaryAction(job, actions);
    const busy = this._busy !== null;
    let main = null;
    if (primary?.type === 'link') main = el('a', { class: 'btn jh-detail__primary', 'data-detail-action': 'primary', 'data-primary': primary.key, href: primary.href, target: '_blank', rel: 'noopener noreferrer', text: `${primary.label} ↗` });
    else if (primary) {
      main = el('button', { type: 'button', class: 'btn jh-detail__primary', 'data-detail-action': 'primary', 'data-primary': primary.key, 'aria-busy': this._busy === primary.key ? 'true' : null, text: this._busy === primary.key ? `${primary.label}...` : primary.label });
      main.disabled = busy;
    }
    const items = menuActions(job, actions, primary);
    const menu = el('details', { class: 'jh-detail__more', 'data-part': 'more' },
      el('summary', { class: 'btn', 'aria-label': `More actions for ${job.role || 'this role'} at ${job.company}`, text: 'More' }),
      el('div', { class: 'jh-detail__menu', role: 'group', 'aria-label': 'More actions' }, items.map((item) => {
        const button = el('button', { type: 'button', class: `jh-detail__item${item.danger ? ' jh-detail__item--danger' : ''}`, 'data-detail-action': item.key, title: item.why ?? undefined, text: item.label });
        button.disabled = Boolean(item.why) || busy;
        return button;
      })));
    return el('div', { class: 'jh-detail__actions', role: 'group', 'aria-label': 'Job actions' }, main, menu);
  }

  // ---- interaction -----------------------------------------------------------------

  _onClick(event) {
    const target = event.target;
    if (!target?.closest) return;
    const tab = target.closest('[data-tab]');
    if (tab) { this._selectTab(tab.getAttribute('data-tab')); return; }
    const goto = target.closest('[data-goto-tab]');
    if (goto) { this._selectTab(goto.getAttribute('data-goto-tab')); return; }
    if (target.closest('[data-evidence-action="rescore"]')) { this._rescoreNow(); return; }
    const action = target.closest('[data-detail-action]');
    if (!action) return;
    const key = action.getAttribute('data-detail-action');
    if (key === 'close') { this.dispatchEvent(new CustomEvent('jh-detail-close', { bubbles: true })); return; }
    if (key === 'retry') { this._load(); return; }
    const more = this.querySelector('details[data-part="more"]');
    if (key === 'primary') {
      this._runPrimary(action);
      return;
    }
    if (more && more.contains(action)) more.open = false;
    if (key === 'answers') this._answers(action.closest('details') ? this.querySelector('summary') : action);
    else if (jobTasks[key]) this._start(key, action.closest('details') ? this.querySelector('summary') : action);
  }

  _onKeydown(event) {
    const target = event.target;
    if (!target?.closest) return;
    if (event.key === 'Escape') {
      const more = target.closest('details[data-part="more"]');
      if (more?.open) { more.open = false; more.querySelector('summary')?.focus?.(); event.stopPropagation?.(); }
      return;
    }
    const tab = target.closest('[role="tab"]');
    if (!tab) return;
    const ids = TABS.map(([id]) => id);
    const at = ids.indexOf(tab.getAttribute('data-tab'));
    const next = { ArrowRight: (at + 1) % ids.length, ArrowLeft: (at - 1 + ids.length) % ids.length, Home: 0, End: ids.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this._selectTab(ids[next], { focus: true });
  }

  _selectTab(id, { focus = false } = {}) {
    if (!TABS.some(([name]) => name === id)) return;
    const changed = id !== this._tab;
    this._tab = id;
    if (id === 'notes' && this._job) {
      if (this._notesEl.jobId !== this._id) this._notesEl.jobId = this._id;
      else if (!this._notesEl.dirty) this._notesEl.load(); // an edit made in a text editor shows up when the tab opens
    }
    if (changed || focus) {
      this._render();
      if (focus) this.querySelector(`[data-tab="${id}"]`)?.focus?.();
    }
  }

  _runPrimary(node) {
    const job = this._job;
    const primary = job ? primaryAction(job, jobActions(job)) : null;
    if (!primary) return;
    if (primary.type === 'answers') this._answers(node);
    else if (primary.type === 'review') {
      this._selectTab('application');
      (this.querySelector('[data-approve-submit]') ?? this.querySelector('[data-submit-box]'))?.focus?.();
    } else if (primary.type === 'task') this._start(primary.key, node);
  }

  /** Saves the owner's answer to one evidence question; the server rescores the job. Resolves { ok } or { error } for the form. */
  async _saveEvidence(payload) {
    const job = this._job;
    if (!job) return { error: 'No job is open.' };
    try {
      const result = await api.saveJobHuntEvidence(job.id, payload);
      if (job.id !== this._id) return { ok: true }; // the owner moved to another job meanwhile
      this._rescore = result.changed === false ? { status: 'unchanged' } : (result.rescore ?? null);
      this._focusRescore = true;
      this._adopt(result.job);
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  }

  /** Retries the rescore of the job's stored evidence (after a pending or failed one). */
  async _rescoreNow() {
    const job = this._job;
    if (!job || this._rescore?.status === 'running') return;
    this._rescore = { status: 'running' };
    this._focusRescore = true;
    this._render();
    let next;
    let fresh = null;
    try {
      const result = await api.rescoreJobHuntJob(job.id);
      next = result.rescore;
      fresh = result.job;
    } catch (error) {
      next = { status: 'failed', reason: error.message, previous: null };
    }
    if (job.id !== this._id) return;
    this._rescore = next;
    this._focusRescore = true;
    if (fresh) this._adopt(fresh); else this._render();
  }

  _answers(opener) {
    const job = this._job;
    if (!job) return;
    openAnswersDialog(job, { opener, onSaved: (fresh) => this._adopt(fresh) });
  }

  /** Runs one of the shared tasks (after its confirmation, if it has one): the same code as the job page and the row menu. */
  async _start(key, opener) {
    const job = this._job;
    const task = jobTasks[key];
    if (!job || !task || this._busy) return;
    if (task.confirm && !(await task.confirm({ job, actions: jobActions(job), opener }))) return;
    if (job.id !== this._id) return;
    this._busy = key;
    this._notice = { text: task.working };
    this._render();
    let fresh = null;
    let notice;
    try {
      const outcome = await task.run(job);
      fresh = outcome.job ?? null;
      notice = outcome.notice;
    } catch (error) {
      notice = { error: true, text: error.message };
    }
    if (job.id !== this._id) return; // the owner moved to another job meanwhile
    this._busy = null;
    this._notice = notice;
    if (fresh) this._adopt(fresh); else this._render();
  }
}

if (!customElements.get('u2-job-detail-panel')) customElements.define('u2-job-detail-panel', U2JobDetailPanel);
