import * as api from '../../services/api.js';
import { el } from './jh-util.js';
import './u2-job-pipeline.js';
import './u2-job-details.js';
import './u2-job-analytics.js';
import './u2-job-resumes.js';

// The job-hunt dashboard (#533): greeting, pipeline, job details, analytics and
// resume versions, from GET /api/job-hunt/dashboard. Self-contained on purpose:
// the job hunt is expected to move to its own repo, so this folder depends only
// on services/api.js. Panels for interviews, follow-ups and contacts are not
// rendered until their data exists (#536, #537).

const REFRESH_EVENT = /^(jobs\.|agent\.action\.)/;
// Where the details start when nothing is selected: the most live stage first.
const AUTO_SELECT_ORDER = ['interviewing', 'screening', 'offer', 'applied', 'saved', 'rejected'];
const WEEK = 7 * 86_400_000;

function greeting(now = new Date()) {
  const hour = now.getHours();
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** The sub-line: only counts the data supports. */
export function summaryLine(dashboard, now = Date.now()) {
  const total = dashboard.stages.reduce((n, stage) => n + stage.count, 0);
  if (!total) return 'Nothing in your pipeline yet.';
  const since = new Date(now - WEEK).toISOString().slice(0, 10);
  const sent = (dashboard.analytics.sentByDay || []).filter((day) => day.date >= since).reduce((n, day) => n + day.count, 0);
  const due = dashboard.stages.flatMap((stage) => stage.jobs).filter((job) => job.status === 'followup_due').length;
  const parts = [sent ? `You sent ${sent} application${sent === 1 ? '' : 's'} this week` : 'No applications sent this week yet'];
  if (due) parts.push(`${due} follow-up${due === 1 ? ' is' : 's are'} due`);
  parts.push(`${total} job${total === 1 ? '' : 's'} in your pipeline`);
  return `${parts.join('. ')}.`;
}

export class U2JobDashboard extends HTMLElement {
  constructor() {
    super();
    this._days = 30;
    this._selected = null;
    this._seq = 0;
    this._dashboard = null;
    this._onEvent = (event) => {
      if (!REFRESH_EVENT.test(event.detail?.type || '')) return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._load(), 300);
    };
  }

  connectedCallback() {
    // The dashboard uses the full width; the shell's workspace column is narrower.
    this._workspace = this.closest('.workspace');
    this._workspace?.classList.add('workspace--wide');
    this.classList.add('jh');
    this._build();
    window.addEventListener('u2-event', this._onEvent);
    this._load();
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
    clearTimeout(this._timer);
    this._seq += 1;
    this._workspace?.classList.remove('workspace--wide');
  }

  _build() {
    this._title = el('h1', { class: 'jh-greeting', text: greeting() });
    this._sub = el('p', { class: 'jh-sub', 'aria-live': 'polite', text: 'Loading your pipeline...' });
    this._search = el('input', { id: 'jh-search', class: 'jh-search__input', type: 'search', placeholder: 'Search jobs, companies, locations...', autocomplete: 'off' });
    this._search.addEventListener('input', () => this._pipeline.setQuery(this._search.value));
    this._error = el('p', { class: 'load-error', role: 'alert', hidden: true });
    this._pipeline = el('u2-job-pipeline');
    this._details = el('u2-job-details', { class: 'jh-lower__details' });
    this._analytics = el('u2-job-analytics');
    this._resumes = el('u2-job-resumes');

    this.addEventListener('jh-select', (event) => this._select(event.detail.id));
    this.addEventListener('jh-changed', () => this._load());
    this.addEventListener('jh-window', (event) => { this._days = event.detail.days; this._load(); });

    this.textContent = '';
    this.append(
      el('div', { class: 'jh-head' }, el('div', { class: 'jh-head__text' }, this._title, this._sub),
        el('div', { class: 'jh-search' }, el('label', { class: 'sr-only', for: 'jh-search', text: 'Search the pipeline' }), this._search)),
      this._error,
      this._pipeline,
      el('div', { class: 'jh-lower' }, this._details, el('div', { class: 'jh-side' }, this._analytics, this._resumes)));
  }

  async _load() {
    const seq = ++this._seq;
    let dashboard;
    try {
      dashboard = await api.getJobHuntDashboard({ days: this._days });
    } catch (err) {
      if (seq !== this._seq) return;
      this._error.hidden = false;
      this._error.textContent = `Couldn't load the job hunt dashboard: ${err.message}`;
      if (!this._dashboard) this._sub.textContent = '';
      return;
    }
    if (seq !== this._seq) return; // a newer load is in flight or the page was left
    this._error.hidden = true;
    this._dashboard = dashboard;
    const all = dashboard.stages.flatMap((stage) => stage.jobs);
    if (this._selected && !all.some((job) => job.id === this._selected) && !this._selectedPinned) this._selected = null;
    if (!this._selected) {
      const first = AUTO_SELECT_ORDER.map((id) => dashboard.stages.find((stage) => stage.id === id)?.jobs[0]).find(Boolean);
      if (first) { this._selected = first.id; this._selectedPinned = false; this._details.show(first.id); }
      else this._details.clear();
    } else {
      this._details.refresh();
    }
    this._sub.textContent = summaryLine(dashboard);
    this._pipeline.update({ stages: dashboard.stages, selectedId: this._selected });
    this._analytics.update(dashboard.analytics);
    this._resumes.update(dashboard.resumeVersions);
  }

  _select(id) {
    if (id === this._selected) return;
    this._selected = id;
    this._selectedPinned = true;
    this._pipeline.setSelected(id);
    this._details.show(id);
  }
}

customElements.define('u2-job-dashboard', U2JobDashboard);
