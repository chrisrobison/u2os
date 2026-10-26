import * as api from '../../services/api.js';
import { el, svg, safeUrl } from './jh-util.js';
import { answerableQuestions, openAnswersDialog } from './jh-answers.js';
import { jobActions, jobTasks } from './u2-job-actions.js';

// The actions for one job listing, small enough for a card: two icon buttons
// (Open and pre-fill the application form, Reject) and a "..." menu with the
// rest. Set `job` to anything with an `id`, `company`, `role` and `status` (a
// Job Leads row or a pipeline card). The menu fetches the full job when it
// opens, so each item can say why it is unavailable using the same rules as the
// Job details page (jobActions), and it runs the same tasks (jobTasks): nothing
// here bypasses a confirmation or the approval gate. After anything that
// changes the job it fires `jh-job-updated` ({ job }) so the host can reload.

const ICONS = {
  prefill: ['M5 4h9l5 5v11H5z', 'M14 4v5h5', 'M8 14h8', 'M8 17.5h5'],
  reject: ['M6 6l12 12', 'M18 6L6 18'],
  more: null,
};
const REJECT_BLOCKED = new Set(['rejected', 'withdrawn', 'closed', 'skipped', 'offer']);
const SETTLED = new Set(['applied', 'contacted', 'followup_due', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'closed', 'skipped', 'uncertain']);

function icon(name) {
  const root = svg('svg', { viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
  if (name === 'more') for (const x of [5, 12, 19]) root.append(svg('circle', { cx: String(x), cy: '12', r: '1.6', fill: 'currentColor', stroke: 'none' }));
  else for (const d of ICONS[name]) root.append(svg('path', { d }));
  return root;
}

let counter = 0;

export class U2JobMenu extends HTMLElement {
  constructor() {
    super();
    this._job = null;
    this._detail = null;
    this._busy = null;
    this._notice = null;
    this._built = false;
    this._id = `jh-menu-${++counter}`;
  }

  set job(value) { this._job = value; if (this._built) this._refresh(); }
  get job() { return this._job; }
  /** True while the menu is open or an action is running: hosts should not rebuild the list meanwhile. */
  get active() { return this._busy !== null || this._popover?.matches(':popover-open') === true; }

  connectedCallback() {
    if (!this._built) this._build();
    this._refresh();
  }

  _build() {
    this._built = true;
    this.classList.add('jh-rowmenu');
    this._prefill = this._iconButton('prefill', 'Open and pre-fill the application', () => this._run('prefill', this._prefill));
    this._reject = this._iconButton('reject', 'Reject this job', () => this._run('reject', this._reject), true);
    this._more = this._iconButton('more', 'More actions', null);
    this._more.setAttribute('aria-haspopup', 'menu');
    this._more.setAttribute('aria-controls', this._id);
    this._more.setAttribute('aria-expanded', 'false');
    this._popover = el('div', { id: this._id, class: 'jh-rowmenu__popover', role: 'menu', popover: 'auto', 'aria-label': 'Job actions' });
    this._popover.addEventListener('toggle', (event) => this._toggled(event.newState === 'open'));
    this._popover.addEventListener('keydown', (event) => this._keys(event));
    this._more.addEventListener('click', () => { this._notice = null; this._place(); });
    this._status = el('span', { class: 'jh-rowmenu__status', role: 'status', 'aria-live': 'polite' });
    this.append(this._prefill, this._reject, this._more, this._popover, this._status);
  }

  _iconButton(name, label, onClick, danger = false) {
    const button = el('button', { type: 'button', class: `jh-rowmenu__btn${danger ? ' jh-rowmenu__btn--danger' : ''}`, 'data-row-action': name, 'aria-label': label, title: label }, icon(name));
    if (onClick) button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    else button.addEventListener('click', (event) => event.stopPropagation());
    return button;
  }

  _label() { return `${this._job?.role || 'this role'} at ${this._job?.company ?? ''}`.trim(); }

  /** Cheap checks from the summary alone; the server and the full job (when loaded) have the final say. */
  _refresh() {
    const job = this._detail ?? this._job;
    if (!job) return;
    const label = this._label();
    this._prefill.setAttribute('aria-label', `Open and pre-fill the application for ${label}`);
    this._reject.setAttribute('aria-label', `Reject ${label}`);
    this._more.setAttribute('aria-label', `More actions for ${label}`);
    const settled = SETTLED.has(job.status);
    const hasUrl = this._detail ? this._detail.applicationUrls?.length > 0 : job.applicationUrls ? job.applicationUrls.length > 0 : true;
    const prefillOff = settled ? `This job is ${String(job.status).replace(/_/g, ' ')}.` : !hasUrl ? 'This listing has no application link.' : null;
    const rejectOff = REJECT_BLOCKED.has(job.status) ? (job.status === 'rejected' ? 'Already rejected.' : `This job is ${String(job.status).replace(/_/g, ' ')}.`) : null;
    this._setState(this._prefill, prefillOff, `Open and pre-fill the application for ${label}`);
    this._setState(this._reject, rejectOff, `Reject ${label}`);
    this._more.disabled = this._busy !== null;
    this._status.textContent = this._notice?.text ?? '';
    this._status.classList.toggle('jh-rowmenu__status--error', Boolean(this._notice?.error));
    this._status.hidden = !this._notice;
    for (const button of [this._prefill, this._reject]) button.setAttribute('aria-busy', String(this._busy === button.dataset.rowAction));
  }

  _setState(button, why, label) {
    button.disabled = Boolean(why) || this._busy !== null;
    button.title = why ?? label;
  }

  async _loadDetail() {
    try {
      this._detail = await api.getJobHuntJob(this._job.id);
    } catch (error) {
      this._notice = { error: true, text: `Couldn't load this job: ${error.message}` };
    }
  }

  _place() {
    // The popover sits in the top layer (so a scrolling board cannot clip it); anchor it under the button.
    const rect = this._more.getBoundingClientRect();
    const pop = this._popover;
    pop.style.top = `${Math.round(rect.bottom + 4)}px`;
    pop.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    pop.style.left = 'auto';
    this._renderItems();
    pop.togglePopover();
    this._loadDetail().then(() => { if (pop.matches(':popover-open')) { this._renderItems(); this._refresh(); } });
  }

  _toggled(open) {
    this._more.setAttribute('aria-expanded', String(open));
    if (open) this._popover.querySelector('[role="menuitem"]:not([disabled])')?.focus();
    else if (document.activeElement === document.body || this._popover.contains(document.activeElement)) this._more.focus();
  }

  _keys(event) {
    const items = [...this._popover.querySelectorAll('[role="menuitem"]:not([disabled])')];
    const at = items.indexOf(document.activeElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move === undefined || !items.length) return;
    event.preventDefault();
    items[(move + items.length) % items.length].focus();
  }

  _renderItems() {
    const job = this._detail;
    const actions = job ? jobActions(job) : null;
    const item = (key, label, { run, why, danger = false, href = null }) => {
      const node = href
        ? el('a', { class: 'jh-rowmenu__item', role: 'menuitem', href, 'data-menu-action': key, text: label })
        : el('button', { type: 'button', class: `jh-rowmenu__item${danger ? ' jh-rowmenu__item--danger' : ''}`, role: 'menuitem', 'data-menu-action': key, title: why ?? undefined, text: label });
      if (!href) {
        node.disabled = Boolean(why) || this._busy !== null;
        node.addEventListener('click', () => { this._popover.hidePopover(); run(node); });
      } else node.addEventListener('click', () => this._popover.hidePopover());
      return node;
    };
    // Until the full job loads, every action that depends on it waits rather than guessing.
    const pending = job ? null : 'Loading...';
    const why = (key) => pending ?? actions[key].why;
    const url = job && safeUrl(job.applicationUrls?.[0]);
    const questions = job ? answerableQuestions(job).length : 0;
    this._popover.replaceChildren(
      item('prefill', 'Open and pre-fill application', { why: why('prefill'), run: (opener) => this._run('prefill', opener) }),
      item('online', 'Apply online (plan and review)', { why: why('online'), run: (opener) => this._run('online', opener) }),
      item('send', 'Apply via email', { why: why('send'), run: (opener) => this._run('send', opener) }),
      item('draft', 'Prepare email draft', { why: why('draft'), run: (opener) => this._run('draft', opener) }),
      item('answers', questions ? `Answer questions (${questions})` : 'Answer questions', { why: pending ?? actions.answers.why, run: (opener) => openAnswersDialog(job, { opener: this._more, onSaved: (fresh) => this._done(fresh) }) }),
      item('applied', 'Mark applied', { why: why('applied'), run: (opener) => this._run('applied', opener) }),
      el('hr', { class: 'jh-rowmenu__sep', role: 'separator' }),
      item('open', 'Open job page', { href: `#/job-hunt/jobs/${encodeURIComponent(this._job.id)}` }),
      url ? el('a', { class: 'jh-rowmenu__item', role: 'menuitem', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Open posting in a new tab', 'data-menu-action': 'posting' }) : null,
      el('hr', { class: 'jh-rowmenu__sep', role: 'separator' }),
      item('reject', 'Reject', { why: pending ?? actions.reject.why, danger: true, run: (opener) => this._run('reject', opener) }));
  }

  _done(fresh) {
    if (!fresh) return;
    this._detail = fresh;
    this._job = { ...this._job, status: fresh.status };
    this._refresh();
    this.dispatchEvent(new CustomEvent('jh-job-updated', { bubbles: true, detail: { job: fresh, notice: this._notice } }));
  }

  async _run(key, opener) {
    if (this._busy) return;
    const task = jobTasks[key];
    if (!this._detail) await this._loadDetail();
    const job = this._detail;
    if (!job || !task) { this._refresh(); return; }
    const anchor = opener?.isConnected && !opener.closest('[popover]') ? opener : this._more;
    if (task.confirm && !(await task.confirm({ job, actions: jobActions(job), opener: anchor }))) return;
    this._busy = key; this._notice = { text: task.working }; this._refresh();
    let fresh = null;
    try {
      const outcome = await task.run(job);
      fresh = outcome.job ?? null;
      this._notice = outcome.notice;
    } catch (error) {
      this._notice = { error: true, text: error.message };
    }
    this._busy = null;
    if (fresh) this._done(fresh); else this._refresh();
  }
}

if (!customElements.get('u2-job-menu')) customElements.define('u2-job-menu', U2JobMenu);
