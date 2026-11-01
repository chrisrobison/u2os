import * as api from '../../services/api.js';
import { el, keepFocus } from './jh-util.js';
import { liveSummary } from './jh-operations-model.js';
import { activityPanel, approvalsPanel, autopilotPanel, failuresPanel, recentPanel, runningPanel } from './jh-operations-parts.js';
import './jh-all.js';

// #/job-hunt/operations: Agent Operations (#640). Read only. Every figure comes from GET /api/job-hunt/operations; this
// host loads it, keeps the last good copy when a refresh fails, ignores responses that arrive out of order and announces
// changes in a polite live region. It refreshes on agent.action.* events (proposals, approvals, completions, failures) and
// polls as the fallback, the same as the Overview. It has no control that changes the autopilot, an approval or a policy.

const REFRESH_EVENT = /^agent\.action\./;
const POLL_MS = 30_000;
const TICK_MS = 60_000;

export class U2JobOperations extends HTMLElement {
  constructor() {
    super();
    this._seq = 0;
    this._data = null;
    this._error = null;
    this._announced = '';
    this._onEvent = (event) => {
      if (!REFRESH_EVENT.test(event.detail?.type || '')) return;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._load(), 300);
    };
  }

  connectedCallback() {
    this._workspace = this.closest?.('.workspace');
    this._workspace?.classList.add('workspace--wide');
    this.classList.add('jh', 'jh-ov', 'jh-ops');
    this._live = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-part': 'live' });
    this._body = el('div', { class: 'jh-ov__top' });
    this.replaceChildren(this._live, this._body);
    this.addEventListener('jh-retry', () => this._load());
    window.addEventListener('u2-event', this._onEvent);
    this._poll = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) this._load(); }, POLL_MS);
    this._tick = setInterval(() => { if (!this._error) this._render(); }, TICK_MS); // an error banner is not re-created (and re-announced) by the clock
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
      data = await api.getJobHuntOperations();
    } catch (err) {
      if (seq !== this._seq) return;
      const message = err?.message || 'The request failed';
      if (message === this._error) return; // the same failure again: do not re-create (and re-announce) the alert
      this._error = message;
      this._render();
      return;
    }
    if (seq !== this._seq) return;
    this._data = data;
    this._error = null;
    this._render();
    // Announce only when something the owner cares about changed, not on every poll.
    const summary = liveSummary(data);
    const fingerprint = `${data.running.count}|${data.awaitingApproval.count}|${data.failures.length}`;
    if (fingerprint !== this._announced) { if (this._announced) this._live.textContent = summary; this._announced = fingerprint; }
  }

  _render() {
    const data = this._data;
    const parts = [el('div', { class: 'jh-head' }, el('div', { class: 'jh-head__text' },
      el('h1', { class: 'jh-ov__title', tabindex: '-1', text: 'Agent Operations' }),
      el('p', { class: 'jh-ov__sub', text: 'What the job-hunt agent is doing, what waits for you and what went wrong. This page only shows; approvals and autopilot settings stay where they were.' })))];
    if (!data) {
      parts.push(this._error
        ? el('jh-state', { kind: 'error', title: "Couldn't load agent operations", message: this._error, retry: '', 'retry-label': 'Try again' })
        : el('jh-state', { kind: 'loading', title: 'Loading agent operations...' }));
    } else {
      const now = Date.now();
      if (this._error) parts.push(el('jh-state', { kind: 'error', title: 'Showing the last data we loaded', message: `The refresh failed: ${this._error}. Updated ${new Date(data.generatedAt).toLocaleTimeString()}.`, retry: '', 'retry-label': 'Refresh' }));
      parts.push(
        autopilotPanel(data),
        el('div', { class: 'jh-ov__columns' }, approvalsPanel(data, now), runningPanel(data, now)),
        el('div', { class: 'jh-ov__columns' }, failuresPanel(data, now), activityPanel(data, now)),
        recentPanel(data, now));
    }
    keepFocus(this._body, () => this._body.replaceChildren(...parts));
  }
}

if (!customElements.get('u2-job-operations')) customElements.define('u2-job-operations', U2JobOperations);
