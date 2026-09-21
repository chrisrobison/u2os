import { escapeHtml, formatDateTime, humanizeKey } from './util.js';
import * as api from '../services/api.js';

function describeConfig(trigger) {
  if (trigger.kind === 'timer') return `Runs once ${formatDateTime(trigger.config.fireAt)}`;
  if (trigger.kind === 'schedule' && trigger.config.everyMinutes) {
    return `Runs every ${trigger.config.everyMinutes} minute${Number(trigger.config.everyMinutes) === 1 ? '' : 's'}`;
  }
  if (trigger.kind === 'schedule' && trigger.config.dailyAt) return `Runs daily at ${trigger.config.dailyAt}`;
  if (trigger.kind === 'event_rule') return `Listens for ${trigger.config.eventType || 'an event'}`;
  if (trigger.kind === 'condition_watch') return `Watches ${humanizeKey(trigger.config.check || 'a condition')}`;
  return 'Structured automation';
}

export class U2Triggers extends HTMLElement {
  constructor() {
    super();
    this._triggers = null;
    this._busy = new Set();
    this._history = new Map();
    this._previews = new Map();
    this._expandedHistory = new Set();
    this._message = null;
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
    this._onKindChange = this._onKindChange.bind(this);
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.addEventListener('click', this._onClick);
    this.addEventListener('submit', this._onSubmit);
    this.addEventListener('change', this._onKindChange);
    this._load();
  }

  async _load() {
    if (!this._triggers) this.innerHTML = '<div class="empty-state">Loading automations...</div>';
    try {
      const { triggers } = await api.getTriggers();
      this._triggers = triggers;
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load automations: ${escapeHtml(err.message)}</div>`;
    }
  }

  _render() {
    const triggers = this._triggers || [];
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Automation</div>
        <div class="workspace__subtitle">Structured, auditable triggers. No arbitrary scripts.</div>
      </div>
      <form class="trigger-create dashboard-card" data-create-trigger>
        <div class="u2-card__title">New automation</div>
        <label>Name <input name="name" required maxlength="120" placeholder="Remind me to review the plan"></label>
        <label>Type <select name="kind"><option value="timer">One-time timer</option><option value="schedule">Recurring schedule</option></select></label>
        <label data-timer-field>Run at <input name="fireAt" type="datetime-local" required></label>
        <label data-schedule-field hidden>Every (minutes) <input name="everyMinutes" type="number" min="1" step="1" value="60"></label>
        <button type="submit">Create automation</button>
      </form>
      <div class="trigger-message${this._message?.error ? ' is-error' : ''}" role="status" aria-live="polite">${escapeHtml(this._message?.text || '')}</div>
      ${triggers.length ? `<div class="trigger-list">${triggers.map((trigger) => this._row(trigger)).join('')}</div>` : '<div class="empty-state">No automations yet.</div>'}
    `;
  }

  _row(trigger) {
    const busy = this._busy.has(trigger.id);
    const userCreated = trigger.source === 'user';
    const expanded = this._expandedHistory.has(trigger.id);
    return `<article class="trigger-row" data-trigger-id="${escapeHtml(trigger.id)}">
      <div class="trigger-row__body">
        <div class="trigger-row__heading"><strong>${escapeHtml(trigger.name)}</strong><span class="trigger-state trigger-state--${trigger.enabled ? 'enabled' : 'paused'}">${trigger.enabled ? 'Enabled' : 'Paused'}</span></div>
        <div class="trigger-row__meta">${escapeHtml(humanizeKey(trigger.kind))} · ${escapeHtml(trigger.source)} · ${escapeHtml(describeConfig(trigger))}</div>
        ${trigger.next_check_at ? `<div class="trigger-row__next">Next check: ${escapeHtml(formatDateTime(trigger.next_check_at))}</div>` : ''}
      </div>
      <div class="trigger-row__actions">
        <button type="button" data-trigger-history="${escapeHtml(trigger.id)}" aria-expanded="${expanded}">${expanded ? 'Hide history' : 'History'}</button>
        <button type="button" data-trigger-dry-run="${escapeHtml(trigger.id)}" ${busy ? 'disabled' : ''}>Dry run</button>
        <button type="button" data-toggle-trigger="${escapeHtml(trigger.id)}" data-enabled="${trigger.enabled}" ${busy ? 'disabled' : ''}>${trigger.enabled ? 'Pause' : 'Resume'}</button>
        ${userCreated ? `<button type="button" class="btn-danger" data-delete-trigger="${escapeHtml(trigger.id)}" ${busy ? 'disabled' : ''}>Delete</button>` : ''}
      </div>
      ${expanded ? this._renderHistory(trigger.id) : ''}
      ${this._previews.has(trigger.id) ? this._renderPreview(this._previews.get(trigger.id)) : ''}
    </article>`;
  }

  _renderPreview(preview) {
    const detail = preview.kind === 'timer' || preview.kind === 'schedule'
      ? `Would run now: ${preview.wouldRunNow ? 'Yes' : 'No'}`
      : preview.kind === 'event_rule'
        ? `Waits for: ${preview.eventType || 'configured event'}`
        : `Current matches: ${preview.currentMatchCount}`;
    return `<div class="trigger-preview" role="status"><strong>Dry run</strong> · ${escapeHtml(detail)} · Action: ${escapeHtml(humanizeKey(preview.action?.kind || 'evaluate'))} · No side effects</div>`;
  }

  _renderHistory(id) {
    const history = this._history.get(id);
    if (!history) return '<div class="trigger-history" role="status">Loading history...</div>';
    if (!history.length) return '<div class="trigger-history"><div class="trigger-history__empty">No runs yet.</div></div>';
    return `<div class="trigger-history" aria-label="Recent run history"><ul>${history.map((run) => `<li>
      <span class="trigger-history__status trigger-history__status--${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
      <span>${escapeHtml(formatDateTime(run.timestamp))}</span>
      <span>${escapeHtml(humanizeKey(run.actionKind || 'evaluate'))} · ${escapeHtml(run.eventType || 'trigger event')}</span>
    </li>`).join('')}</ul></div>`;
  }

  _onKindChange(event) {
    if (event.target.name !== 'kind') return;
    const form = event.target.form;
    const timer = event.target.value === 'timer';
    form.querySelector('[data-timer-field]').hidden = !timer;
    form.querySelector('[data-schedule-field]').hidden = timer;
    form.fireAt.required = timer;
    form.everyMinutes.required = !timer;
  }

  _onClick(event) {
    const history = event.target.closest('[data-trigger-history]');
    if (history) return this._toggleHistory(history.dataset.triggerHistory);
    const dryRun = event.target.closest('[data-trigger-dry-run]');
    if (dryRun) return this._dryRun(dryRun.dataset.triggerDryRun);
    const toggle = event.target.closest('[data-toggle-trigger]');
    if (toggle) return this._mutate(toggle.dataset.toggleTrigger, () => api.updateTrigger(toggle.dataset.toggleTrigger, { enabled: toggle.dataset.enabled !== 'true' }), 'Automation updated.');
    const remove = event.target.closest('[data-delete-trigger]');
    if (remove && window.confirm('Delete this automation? This cannot be undone.')) {
      return this._mutate(remove.dataset.deleteTrigger, () => api.deleteTrigger(remove.dataset.deleteTrigger), 'Automation deleted.');
    }
  }

  async _dryRun(id) {
    if (this._busy.has(id)) return;
    this._busy.add(id);
    this._render();
    try {
      this._previews.set(id, await api.dryRunTrigger(id));
      this._message = { text: 'Dry run complete. No actions were executed.' };
    } catch (err) {
      this._message = { text: err.message, error: true };
    } finally {
      this._busy.delete(id);
    }
    this._render();
  }

  async _toggleHistory(id) {
    if (this._expandedHistory.has(id)) {
      this._expandedHistory.delete(id);
      this._render();
      return;
    }
    this._expandedHistory.add(id);
    this._render();
    if (this._history.has(id)) return;
    try {
      const result = await api.getTriggerHistory(id);
      this._history.set(id, result.history || []);
    } catch (err) {
      this._expandedHistory.delete(id);
      this._message = { text: err.message, error: true };
    }
    this._render();
  }

  async _onSubmit(event) {
    const form = event.target.closest('[data-create-trigger]');
    if (!form) return;
    event.preventDefault();
    const kind = form.kind.value;
    const config = kind === 'timer'
      ? { fireAt: new Date(form.fireAt.value).toISOString() }
      : { everyMinutes: Number(form.everyMinutes.value) };
    try {
      await api.createTrigger({ name: form.name.value.trim(), kind, config });
      this._message = { text: 'Automation created.' };
      await this._load();
    } catch (err) {
      this._message = { text: err.message, error: true };
      this._render();
    }
  }

  async _mutate(id, operation, success) {
    if (this._busy.has(id)) return;
    this._busy.add(id);
    this._render();
    try {
      await operation();
      this._message = { text: success };
    } catch (err) {
      this._message = { text: err.message, error: true };
    } finally {
      this._busy.delete(id);
    }
    await this._load();
  }
}

customElements.define('u2-triggers', U2Triggers);
