import * as api from '../services/api.js';
import './u2-approval.js';

const GROUPS = [
  ['waiting_approval', 'Waiting for approval'],
  ['queued', 'Queued'],
  ['leased', 'Starting'],
  ['executing', 'Executing'],
  ['retry_wait', 'Retrying'],
  ['failed', 'Needs attention'],
  ['dead_letter', 'Stopped'],
  ['cancelled', 'Cancelled'],
  ['completed', 'Completed'],
];

export class U2Operations extends HTMLElement {
  constructor() {
    super();
    this._reviewGeneration = 0;
    this._onEvent = (event) => {
      if (event.detail?.type?.startsWith('agent.action.')) this.load();
    };
  }

  connectedCallback() {
    if (!this._content) this._build();
    window.addEventListener('u2-event', this._onEvent);
    this.load();
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
    this._reviewGeneration++;
  }

  _build() {
    this.textContent = '';
    const header = document.createElement('div');
    header.className = 'workspace__header';
    const title = document.createElement('div');
    title.className = 'workspace__title';
    title.textContent = 'Operations';
    const subtitle = document.createElement('div');
    subtitle.className = 'workspace__subtitle';
    subtitle.textContent = 'Durable action delivery and items that need your attention.';
    header.append(title, subtitle);
    const refresh = document.createElement('button');
    refresh.className = 'btn btn-ghost'; refresh.textContent = 'Refresh operations';
    refresh.addEventListener('click', () => this.load()); header.appendChild(refresh);
    this.appendChild(header);
    this._reviewPanel = document.createElement('section');
    this._reviewPanel.className = 'operation-review'; this._reviewPanel.hidden = true;
    this._reviewPanel.addEventListener('u2-action-resolved', () => this.load());
    this._content = document.createElement('div');
    this.append(this._reviewPanel, this._content);
  }

  load() {
    if (this._loading) { this._reloadRequested = true; return this._loading; }
    this._loading = this._load().finally(() => {
      this._loading = null;
      if (this._reloadRequested && this.isConnected) { this._reloadRequested = false; return this.load(); }
    });
    return this._loading;
  }

  async _load() {
    try {
      const { items = [], counts = {} } = await api.getActionOperations();
      if (!this.isConnected || this._reloadRequested) return;
      // Replace metadata only. An in-flight or resolved approval card must
      // retain its exact saved proposal, disabled controls and outcome.
      this._content.replaceChildren();
      const summary = document.createElement('div');
      summary.className = 'operations-summary';
      for (const [status, label] of GROUPS) {
        const pill = document.createElement('span');
        pill.className = 'operations-count';
        pill.dataset.status = status;
        pill.textContent = `${label}: ${counts[status] || 0}`;
        summary.appendChild(pill);
      }
      this._content.appendChild(summary);

      for (const [status, label] of GROUPS) {
        const matching = items.filter((item) => item.status === status);
        if (!matching.length) continue;
        const section = document.createElement('section');
        section.className = 'operations-group';
        const heading = document.createElement('h2');
        heading.textContent = label;
        section.appendChild(heading);
        for (const item of matching) section.appendChild(operationCard(item, (id) => this._review(id)));
        this._content.appendChild(section);
      }
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No action activity yet.';
        this._content.appendChild(empty);
      }
    } catch {
      if (!this.isConnected) return;
      const failure = document.createElement('div');
      failure.className = 'load-error';
      failure.textContent = "Couldn't load operations. Check the connection and refresh; any saved approval preview is unchanged.";
      this._content.replaceChildren(failure);
    }
  }

  async _review(id) {
    const generation = ++this._reviewGeneration;
    this._reviewPanel.replaceChildren(); this._reviewPanel.hidden = false;
    const heading = document.createElement('h2'); heading.textContent = 'Review saved approval';
    const close = document.createElement('button'); close.className = 'btn btn-ghost'; close.textContent = 'Close preview (does not cancel action)';
    close.addEventListener('click', () => { this._reviewGeneration++; this._reviewPanel.hidden = true; this._reviewPanel.replaceChildren(); });
    const content = document.createElement('div'); content.textContent = 'Loading saved proposal…';
    this._reviewPanel.append(heading, close, content);
    try {
      const action = await api.getAction(id);
      if (generation !== this._reviewGeneration || !this.isConnected) return;
      if (action?.id !== id || action.status !== 'pending') {
        content.textContent = 'This action no longer has a verified pending approval. Refresh Operations for its current state.';
        this.load(); return;
      }
      const binding = action.accountBinding;
      if (['email.send', 'calendar.create', 'calendar.reschedule', 'notifications.send'].includes(action.tool) &&
          (!binding || typeof binding.label !== 'string' || !binding.label.trim() || typeof binding.providerId !== 'string' || !binding.providerId.trim() ||
            (binding.providerId !== 'mock' && (typeof binding.instanceId !== 'string' || !binding.instanceId.trim())))) {
        content.textContent = 'Original account identity is unavailable. Ask for a new proposal instead of approving this saved action.'; return;
      }
      const note = document.createElement('p');
      note.textContent = 'This is the original saved account and payload. The runtime rechecks authorization and account validity before execution.';
      const approval = document.createElement('u2-approval'); approval.action = action;
      content.replaceChildren(note, approval);
    } catch {
      if (generation !== this._reviewGeneration || !this.isConnected) return;
      content.textContent = "Couldn't load the saved approval. Check the connection and refresh Operations; no approval was attempted.";
    }
  }
}

function operationCard(item, review) {
  const card = document.createElement('article');
  card.className = 'operation-card';
  card.dataset.status = item.status;
  const tool = document.createElement('strong');
  tool.textContent = item.tool || 'Unknown action';
  const meta = document.createElement('span');
  meta.className = 'operation-card__meta';
  const recovery = item.errorClass === 'recovery_review_required';
  const uncertain = item.errorClass === 'outcome_uncertain';
  if (uncertain) card.dataset.outcome = 'uncertain';
  const attempts = item.attemptCount ? ` · ${item.attemptCount} ${recovery ? 'recorded ' : ''}attempt${item.attemptCount === 1 ? '' : 's'}` : '';
  meta.textContent = `${recovery ? 'outcome unknown from restored snapshot' : uncertain ? 'outcome uncertain' : item.status.replaceAll('_', ' ')}${attempts}`;
  card.append(tool, meta);
  const time = document.createElement('time');
  time.dateTime = item.updatedAt || item.createdAt || '';
  time.textContent = formatTime(time.dateTime);
  card.appendChild(time);
  if (item.account) {
    const account = document.createElement('span');
    account.className = 'operation-card__account';
    account.textContent = `Original account: ${item.account.label} (${item.account.providerId}; ${item.account.instanceId || 'no account instance'})`;
    card.appendChild(account);
    if (item.account.smtpIdentity) {
      const sender = document.createElement('span');
      sender.className = 'operation-card__sender';
      sender.textContent = `SMTP sender: ${item.account.smtpIdentity.label} (${item.account.smtpIdentity.instanceId}; ${item.account.smtpIdentity.from})`;
      card.appendChild(sender);
    }
  } else if (recovery || uncertain || ['email.send', 'calendar.create', 'calendar.reschedule', 'notifications.send'].includes(item.tool)) {
    const account = document.createElement('span');
    account.className = 'operation-card__account';
    account.textContent = 'Original account unavailable; inspect the original action before any new proposal.';
    card.appendChild(account);
  }
  if (item.errorClass) {
    const attention = document.createElement('span');
    attention.className = 'operation-card__attention';
    attention.textContent = humanizeErrorClass(item.errorClass);
    card.appendChild(attention);
  }
  if (item.status === 'waiting_approval' && typeof item.actionId === 'string' && item.actionId) {
    const button = document.createElement('button'); button.className = 'btn btn-ghost operation-card__review'; button.textContent = 'Review approval';
    button.addEventListener('click', () => review(item.actionId)); card.appendChild(button);
  }
  return card;
}

function humanizeErrorClass(value) {
  if (value === 'recovery_review_required') return 'Restored snapshot: outcome needs review; original work may have progressed. Archived approval cannot be retried.';
  if (value === 'outcome_uncertain') return 'Delivery outcome uncertain. Check the original account/provider before any fresh proposal. No automatic retry or requeue.';
  return value.replaceAll('_', ' ');
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}

customElements.define('u2-operations', U2Operations);
