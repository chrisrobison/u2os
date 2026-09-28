import { escapeHtml, formatDateTime } from './util.js';
import * as api from '../services/api.js';
import { EVENT_LABELS } from './u2-timeline.js';

// The owner's vault at a glance (docs/vault.md): where it is, whether it
// indexed cleanly, whether policies.yaml and mcp.yaml are in effect, which
// tool servers are running, and the journal of what U2OS did on the
// owner's behalf. Reports names, states and errors, never file contents.

const SERVER_STATES = {
  running: ['enabled', 'Running'],
  starting: ['paused', 'Starting'],
  disabled: ['paused', 'Disabled'],
  stopped: ['paused', 'Stopped'],
  exited: ['invalid', 'Exited'],
  failed: ['invalid', 'Failed'],
};
const JOURNAL_DETAIL = ['tool', 'routine', 'key', 'reason', 'pendingApprovals'];

export class U2Vault extends HTMLElement {
  constructor() {
    super();
    this._status = null;
    this._journal = null;
    this._month = null;
    this._busy = null;
    this._message = null;
    this._onClick = this._onClick.bind(this);
    this._onChange = this._onChange.bind(this);
    this._onEvent = (event) => {
      const type = event.detail?.type || '';
      if (type === 'vault.indexed') this._load();
      else if (!this._month || this._month === this._journal?.months?.[0]) this._loadJournal();
    };
  }

  connectedCallback() {
    this.addEventListener('click', this._onClick);
    this.addEventListener('change', this._onChange);
    window.addEventListener('u2-event', this._onEvent);
    this._load();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    this.removeEventListener('change', this._onChange);
    window.removeEventListener('u2-event', this._onEvent);
    clearTimeout(this._journalTimer);
  }

  async _load() {
    if (!this._status) this.innerHTML = '<div class="empty-state">Loading vault status...</div>';
    try {
      const [status, journal] = await Promise.all([api.getVaultStatus(), api.getVaultJournal(this._month ? { month: this._month } : {})]);
      this._status = status;
      this._journal = journal;
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load the vault status: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Many events can arrive together; refresh the journal at most once a second.
  _loadJournal() {
    clearTimeout(this._journalTimer);
    this._journalTimer = setTimeout(async () => {
      try {
        this._journal = await api.getVaultJournal(this._month ? { month: this._month } : {});
        const section = this.querySelector('[data-journal]');
        if (section) section.outerHTML = this._journalSection();
      } catch { /* keep the last journal shown */ }
    }, 1_000);
  }

  _render() {
    const { vaultDir, lastIndex, policy, mcp } = this._status;
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Vault</div>
        <div class="workspace__subtitle">Your digital self as files you own: ${escapeHtml(vaultDir)}</div>
      </div>
      <div class="trigger-message${this._message?.error ? ' is-error' : ''}" role="status" aria-live="polite">${escapeHtml(this._message?.text || '')}</div>
      <div class="vault-grid">
        ${this._indexSection(lastIndex)}
        ${this._policySection(policy)}
        ${this._mcpSection(mcp)}
      </div>
      ${this._journalSection()}
    `;
  }

  _indexSection(report) {
    const errors = report?.errors || [];
    return `<section class="dashboard-card vault-card" data-vault-index aria-labelledby="vault-index-title">
      <h2 class="u2-card__title" id="vault-index-title">Index</h2>
      ${report ? `<p>${report.files} file${report.files === 1 ? '' : 's'} · ${report.changed} changed · ${report.removed} removed · ${escapeHtml(formatDateTime(report.indexedAt))}</p>` : '<p>Not indexed yet.</p>'}
      ${errors.length ? `<ul class="vault-errors">${errors.map((item) => `<li><code>${escapeHtml(item.path)}</code>: ${escapeHtml(item.error)}</li>`).join('')}</ul>` : report ? '<p class="vault-ok">Every file read cleanly.</p>' : ''}
      ${(report?.notes || []).map((note) => `<p class="trigger-row__meta">${escapeHtml(note)}</p>`).join('')}
      <button type="button" data-vault-action="reindex" ${this._busy ? 'disabled' : ''}>Re-read vault</button>
    </section>`;
  }

  _policySection(policy) {
    const state = policy?.error ? ['invalid', 'Invalid'] : policy?.active ? ['enabled', 'In effect'] : ['paused', 'Not present'];
    return `<section class="dashboard-card vault-card" data-vault-policy aria-labelledby="vault-policy-title">
      <h2 class="u2-card__title" id="vault-policy-title">Policy</h2>
      <p><code>policies.yaml</code> <span class="trigger-state trigger-state--${state[0]}">${state[1]}</span></p>
      ${policy?.error ? `<p class="routine-row__error" role="alert">${escapeHtml(policy.error)}. Until it is fixed, U2OS asks before every action.</p>`
    : policy?.active ? '<p class="trigger-row__meta">Your vault policy overrides the home policy.</p>' : '<p class="trigger-row__meta">The home policy applies. Add <code>policies.yaml</code> to your vault to set your own (docs/policies.md).</p>'}
    </section>`;
  }

  _mcpSection(mcp) {
    const servers = mcp?.servers || [];
    return `<section class="dashboard-card vault-card" data-vault-mcp aria-labelledby="vault-mcp-title">
      <h2 class="u2-card__title" id="vault-mcp-title">Tool servers</h2>
      ${mcp?.error ? `<p class="routine-row__error" role="alert"><code>mcp.yaml</code> is invalid, so no servers were started: ${escapeHtml(mcp.error)}</p>` : ''}
      ${servers.length ? `<ul class="vault-servers">${servers.map((server) => {
    const [tone, label] = SERVER_STATES[server.state] || ['paused', server.state];
    return `<li data-mcp-server="${escapeHtml(server.name)}">
          <div><strong>${escapeHtml(server.name)}</strong> <span class="trigger-state trigger-state--${tone}">${escapeHtml(label)}</span></div>
          ${server.tools?.length ? `<div class="trigger-row__meta">${escapeHtml(server.tools.join(', '))}</div>` : ''}
          ${server.missingTools?.length ? `<div class="trigger-row__meta">Listed but not offered: ${escapeHtml(server.missingTools.join(', '))}</div>` : ''}
          ${server.error ? `<div class="routine-row__error">${escapeHtml(server.error)}</div>` : ''}
          ${server.stderr ? `<details><summary>Server output</summary><pre>${escapeHtml(server.stderr)}</pre></details>` : ''}
        </li>`;
  }).join('')}</ul>` : mcp?.error ? '' : '<p>No tool servers. Declare them in <code>mcp.yaml</code> (docs/mcp.md).</p>'}
      <button type="button" data-vault-action="restart-mcp" ${this._busy ? 'disabled' : ''}>Restart tool servers</button>
    </section>`;
  }

  _journalSection() {
    const journal = this._journal || { months: [], entries: [] };
    return `<section class="dashboard-card vault-journal" data-journal aria-labelledby="vault-journal-title">
      <div class="vault-journal__header">
        <h2 class="u2-card__title" id="vault-journal-title">Journal</h2>
        ${journal.months.length > 1 ? `<label>Month <select data-journal-month>${journal.months.map((month) => `<option value="${escapeHtml(month)}" ${month === journal.month ? 'selected' : ''}>${escapeHtml(month)}</option>`).join('')}</select></label>` : ''}
      </div>
      <p class="trigger-row__meta">What U2OS did or you decided, as written to <code>journal/${escapeHtml(journal.month || 'YYYY-MM')}.jsonl</code> in your vault.</p>
      ${journal.entries.length ? `<ol class="vault-journal__list">${journal.entries.map((entry) => this._journalEntry(entry)).join('')}</ol>` : '<div class="empty-state">Nothing in the journal yet.</div>'}
    </section>`;
  }

  _journalEntry(entry) {
    const label = EVENT_LABELS[entry.type] || entry.type.replace(/[._]+/g, ' ');
    const details = JOURNAL_DETAIL.filter((key) => entry.data?.[key] !== undefined && entry.data[key] !== null && entry.data[key] !== '' && entry.data[key] !== 0)
      .map((key) => `${key === 'pendingApprovals' ? 'waiting for approval' : key}: ${entry.data[key]}`);
    return `<li data-journal-type="${escapeHtml(entry.type)}">
      <span class="vault-journal__time">${escapeHtml(formatDateTime(entry.ts))}</span>
      <span>${escapeHtml(label)}</span>
      ${details.length ? `<span class="trigger-row__meta">${escapeHtml(details.join(' · '))}</span>` : ''}
    </li>`;
  }

  async _onChange(event) {
    if (!event.target.matches('[data-journal-month]')) return;
    this._month = event.target.value;
    try {
      this._journal = await api.getVaultJournal({ month: this._month });
      this.querySelector('[data-journal]').outerHTML = this._journalSection();
    } catch (err) {
      this._message = { error: true, text: err.message };
      this._render();
    }
  }

  async _onClick(event) {
    const button = event.target.closest('[data-vault-action]');
    if (!button || this._busy) return;
    this._busy = button.dataset.vaultAction;
    this._message = { text: this._busy === 'reindex' ? 'Reading your vault...' : 'Restarting tool servers...' };
    this._render();
    try {
      if (this._busy === 'reindex') {
        const { report } = await api.reindexVault();
        this._message = { text: `Read ${report.files} files; ${report.changed} changed${report.errors.length ? `; ${report.errors.length} need fixing` : ''}.`, error: report.errors.length > 0 };
      } else {
        const { mcp } = await api.restartMcpServers();
        const running = mcp.servers.filter((server) => server.state === 'running').length;
        this._message = { text: `${running} of ${mcp.servers.length} tool server${mcp.servers.length === 1 ? '' : 's'} running.`, error: Boolean(mcp.error) || running < mcp.servers.filter((server) => server.enabled).length };
      }
    } catch (err) {
      this._message = { error: true, text: err.message };
    } finally {
      this._busy = null;
      await this._load();
    }
  }
}

customElements.define('u2-vault', U2Vault);
