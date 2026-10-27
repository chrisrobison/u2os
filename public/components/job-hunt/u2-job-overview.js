import * as api from '../../services/api.js';
import { el } from './jh-util.js';
import { summaryBar, autopilotBar, pipeline, attention, activity } from './jh-overview-parts.js';
import './jh-all.js';
import './u2-job-dashboard.js';

// #/job-hunt: the Job Hunt Overview (#629). Every number comes from
// GET /api/job-hunt/overview; this host loads it, keeps the last good copy when
// a refresh fails, ignores responses that arrive out of order, and embeds the
// previous pipeline board (u2-job-dashboard) below so nothing was removed.
// The server publishes no jobs.* events, so it refreshes on agent.action.*
// (approvals, sends) and polls.

const REFRESH_EVENT = /^agent\.action\./;
const POLL_MS = 30_000;
const TICK_MS = 60_000; // re-labels ages without a request

export class U2JobOverview extends HTMLElement {
  constructor() {
    super();
    this._seq = 0;
    this._data = null;
    this._error = null;
    this._onEvent = (event) => {
      if (!REFRESH_EVENT.test(event.detail?.type || '')) return;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._load(), 300);
    };
  }

  connectedCallback() {
    this._workspace = this.closest?.('.workspace');
    this._workspace?.classList.add('workspace--wide');
    this.classList.add('jh', 'jh-ov');
    // The board is mounted once and never re-parented, or it would reload on every render.
    this._top = el('div', { class: 'jh-ov__top' });
    this.replaceChildren(this._top, el('section', { class: 'jh-ov__board', 'aria-label': 'Pipeline board and details' }, el('h2', { class: 'jh-ov__board-title', text: 'Pipeline board and details' }), el('u2-job-dashboard')));
    this.addEventListener('jh-retry', () => this._load());
    window.addEventListener('u2-event', this._onEvent);
    this._poll = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) this._load(); }, POLL_MS);
    this._tick = setInterval(() => this._render(), TICK_MS);
    this._render();
    this._load();
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
    clearTimeout(this._debounce);
    clearInterval(this._poll);
    clearInterval(this._tick);
    this._seq += 1;
    this._workspace?.classList.remove('workspace--wide');
  }

  async _load() {
    const seq = ++this._seq;
    let data;
    try {
      data = await api.getJobHuntOverview();
    } catch (err) {
      if (seq !== this._seq) return; // a newer request is in flight, or the page was left
      this._error = err?.message || 'The request failed';
      this._render();
      return;
    }
    if (seq !== this._seq) return;
    this._data = data;
    this._error = null;
    this._render();
  }

  _render() {
    const data = this._data;
    const head = el('div', { class: 'jh-head' }, el('div', { class: 'jh-head__text' },
      el('h1', { class: 'jh-ov__title', text: 'Job Hunt' }),
      el('p', { class: 'jh-ov__sub', text: 'Your search, applications and follow-ups. You decide; U2OS does the rest.' })));
    const parts = [head];
    if (!data) {
      parts.push(this._error
        ? el('jh-state', { kind: 'error', title: "Couldn't load the overview", message: this._error, retry: '', 'retry-label': 'Try again' })
        : el('jh-state', { kind: 'loading', title: 'Loading your job hunt...' }));
    } else {
      const now = Date.now();
      if (this._error) {
        parts.push(el('jh-state', { kind: 'error', title: 'Showing the last data we loaded', message: `The refresh failed: ${this._error}. Updated ${new Date(data.generatedAt).toLocaleTimeString()}.`, retry: '', 'retry-label': 'Refresh' }));
      }
      parts.push(summaryBar(data), autopilotBar(data), pipeline(data));
      if (!data.metrics.some((metric) => metric.value > 0)) {
        parts.push(el('jh-state', { kind: 'empty', title: 'No jobs yet', message: 'Run discovery or turn on the autopilot, and jobs appear here.' }));
      }
      parts.push(el('div', { class: 'jh-ov__columns' }, attention(data, now), activity(data, now)));
    }
    this._top.replaceChildren(...parts);
  }
}

if (!customElements.get('u2-job-overview')) customElements.define('u2-job-overview', U2JobOverview);
