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
  const attempts = item.attemptCount ? ` · ${item.attemptCount} attempt${item.attemptCount === 1 ? '' : 's'}` : '';
  meta.textContent = `${item.status.replaceAll('_', ' ')}${attempts}`;
  card.append(tool, meta);
  if (item.errorClass) {
    const attention = document.createElement('span');
    attention.className = 'operation-card__attention';
    attention.textContent = humanizeErrorClass(item.errorClass);
    card.appendChild(attention);
  }
  const time = document.createElement('time');
  time.dateTime = item.updatedAt || item.createdAt || '';
  time.textContent = formatTime(time.dateTime);
  card.appendChild(time);
  return card;
}

function humanizeErrorClass(value) {
  return value.replaceAll('_', ' ');
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}

customElements.define('u2-operations', U2Operations);
