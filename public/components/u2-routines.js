import { escapeHtml, formatDateTime } from './util.js';
import * as api from '../services/api.js';

// Owner-written routines from the vault (docs/routines.md): what each one
// does, when it runs, and how its last run went. Routines are edited as
// files; this view only reports them and runs one on request.

const RUN_LABELS = {
  started: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  throttled: 'Skipped (hourly limit)',
};

function lastRunText(run) {
  if (!run) return 'Never run';
  const parts = [`${RUN_LABELS[run.status] || run.status} · ${run.trigger === 'manual' ? 'run by you' : run.trigger}`, formatDateTime(run.startedAt)];
  if (run.reason === 'awaiting_approval') parts.push('waiting for your approval');
  else if (run.reason) parts.push(run.reason.replace(/_/g, ' ').toLowerCase());
  return parts.filter(Boolean).join(' · ');
}

export class U2Routines extends HTMLElement {
  constructor() {
    super();
    this._routines = null;
    this._busy = new Set();
    this._message = null;
    this._onClick = this._onClick.bind(this);
    this._onEvent = (event) => {
      const type = event.detail?.type || '';
      if (type.startsWith('routine.') || type === 'vault.indexed') this._load();
    };
  }

  connectedCallback() {
    this.addEventListener('click', this._onClick);
    window.addEventListener('u2-event', this._onEvent);
    this._load();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    window.removeEventListener('u2-event', this._onEvent);
  }

  async _load() {
    if (!this._routines) this.innerHTML = '<div class="empty-state">Loading routines...</div>';
    try {
      this._routines = (await api.getRoutines()).routines;
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load routines: ${escapeHtml(err.message)}</div>`;
    }
  }

  _render() {
    const routines = this._routines || [];
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Routines</div>
        <div class="workspace__subtitle">Standing instructions from the routines folder of your vault. Edit the files to change them.</div>
      </div>
      <div class="trigger-message${this._message?.error ? ' is-error' : ''}" role="status" aria-live="polite">${escapeHtml(this._message?.text || '')}${this._message?.pending ? ' <a href="#/operations">Review in Operations</a>' : ''}</div>
      ${routines.length ? `<div class="trigger-list">${routines.map((routine) => this._row(routine)).join('')}</div>`
    : '<div class="empty-state">No routines yet. Add a Markdown file to the routines folder of your vault (see docs/routines.md).</div>'}
    `;
  }

  _row(routine) {
    const state = routine.error ? 'invalid' : routine.enabled ? 'enabled' : 'paused';
    const stateLabel = { invalid: 'Needs fixing', enabled: 'Enabled', paused: 'Disabled' }[state];
    const busy = this._busy.has(routine.path);
    return `<article class="trigger-row routine-row" data-routine-path="${escapeHtml(routine.path)}">
      <div class="trigger-row__body">
        <div class="trigger-row__heading"><strong>${escapeHtml(routine.name)}</strong><span class="trigger-state trigger-state--${state}">${stateLabel}</span></div>
        <div class="trigger-row__meta">${escapeHtml(routine.path)} · ${escapeHtml(routine.schedule)}${routine.skills?.length ? ` · skills: ${escapeHtml(routine.skills.join(', '))}` : ''}</div>
        ${routine.error ? `<div class="routine-row__error" role="alert">${escapeHtml(routine.error)}</div>` : ''}
        <div class="trigger-row__next" data-last-run>Last run: ${escapeHtml(lastRunText(routine.lastRun))}</div>
        ${routine.instruction ? `<details class="routine-row__instruction"><summary>Instruction</summary><p>${escapeHtml(routine.instruction)}</p></details>` : ''}
      </div>
      <div class="trigger-row__actions">
        <button type="button" data-run-routine="${escapeHtml(routine.path)}" ${routine.error || busy ? 'disabled' : ''}>${busy ? 'Running...' : 'Run now'}</button>
      </div>
    </article>`;
  }

  async _onClick(event) {
    const button = event.target.closest('[data-run-routine]');
    if (!button) return;
    const path = button.dataset.runRoutine;
    this._busy.add(path);
    this._message = null;
    this._render();
    try {
      const { result } = await api.runRoutine(path);
      const pending = result?.pendingApprovals || 0;
      this._message = !result ? { error: true, text: 'Nothing was started (is the owner account set up?).' }
        : result.status === 'failed'
        ? { error: true, text: `The routine did not finish (${result.reason}).` }
        : { text: pending ? `Done. ${pending} action${pending === 1 ? '' : 's'} waiting for your approval.` : 'Done.', pending: pending > 0 };
    } catch (err) {
      this._message = { error: true, text: err.message };
    } finally {
      this._busy.delete(path);
      await this._load();
    }
  }
}

customElements.define('u2-routines', U2Routines);
