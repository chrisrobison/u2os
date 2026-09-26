import * as api from '../services/api.js';

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
    this._onEvent = (event) => {
      if (event.detail?.type?.startsWith('agent.action.')) this.load();
    };
  }

  connectedCallback() {
    window.addEventListener('u2-event', this._onEvent);
    this.load();
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
  }

  async load() {
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
    this.appendChild(header);
    try {
      const { items = [], counts = {} } = await api.getActionOperations();
      const summary = document.createElement('div');
      summary.className = 'operations-summary';
      for (const [status, label] of GROUPS) {
        const pill = document.createElement('span');
        pill.className = 'operations-count';
        pill.dataset.status = status;
        pill.textContent = `${label}: ${counts[status] || 0}`;
        summary.appendChild(pill);
      }
      this.appendChild(summary);

      for (const [status, label] of GROUPS) {
        const matching = items.filter((item) => item.status === status);
        if (!matching.length) continue;
        const section = document.createElement('section');
        section.className = 'operations-group';
        const heading = document.createElement('h2');
        heading.textContent = label;
        section.appendChild(heading);
        for (const item of matching) section.appendChild(operationCard(item));
        this.appendChild(section);
      }
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No action activity yet.';
        this.appendChild(empty);
      }
    } catch (error) {
      const failure = document.createElement('div');
      failure.className = 'load-error';
      failure.textContent = `Couldn't load operations: ${error.message}`;
      this.appendChild(failure);
    }
  }
}

function operationCard(item) {
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
