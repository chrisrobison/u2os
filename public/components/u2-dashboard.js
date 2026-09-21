import { escapeHtml, emptyState } from './util.js';
import './u2-card.js';
import './u2-schedule.js';
import './u2-task-list.js';
import './u2-email-summary.js';
import './u2-approval.js';
import './u2-timeline.js';
import './u2-alert.js';
import './u2-person.js';
import './u2-project.js';
import './u2-photo-grid.js';
import './u2-document.js';
import './u2-map.js';
import './u2-chart.js';
import './u2-conversation.js';
import './u2-agent-status.js';
import './u2-recommendation.js';

// Card titles per docs/dashboards.md component type -- the trusted set the
// LLM composes from; unknown types still render (as a placeholder) rather
// than breaking the page, matching the "coming soon" contract for the
// Phase 2+ reserved types.
const CARD_TITLES = {
  schedule: 'Schedule',
  'task-list': 'Tasks',
  'email-summary': 'Email',
  approval: 'Approvals',
  activity: 'Activity',
  person: 'Person',
  project: 'Project',
  'photo-grid': 'Photos',
  document: 'Document',
  map: 'Map',
  chart: 'Chart',
  conversation: 'Conversation',
  'agent-status': 'Agent status',
  recommendation: 'Recommendation',
};

const REFRESH_EVENT_PREFIXES = ['task.', 'calendar.', 'email.', 'agent.action.', 'recommendation.', 'memory.'];

function humanizeType(type) {
  const label = String(type || '').replace(/-/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// property `schema` -> the dashboard JSON described in docs/dashboards.md,
// e.g. from GET /api/dashboard/morning. Renders `title` as a heading and
// one <u2-card> per entry in `components[]`.
export class U2Dashboard extends HTMLElement {
  constructor() {
    super();
    this._refreshSequence = 0;
    this._onEvent = (event) => {
      const type = event.detail?.type || '';
      if (!this._refreshLoader || !REFRESH_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))) return;
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this._refresh(), 150);
    };
  }

  set refreshLoader(value) {
    this._refreshLoader = typeof value === 'function' ? value : null;
  }

  set schema(value) {
    this._schema = value || null;
    this._render();
  }

  get schema() {
    return this._schema;
  }

  connectedCallback() {
    window.addEventListener('u2-event', this._onEvent);
    if (this._schema) this._render();
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
    clearTimeout(this._refreshTimer);
    this._refreshSequence += 1;
  }

  async _refresh() {
    const sequence = ++this._refreshSequence;
    try {
      const schema = await this._refreshLoader();
      if (this.isConnected && sequence === this._refreshSequence) this.schema = schema;
    } catch (err) {
      if (!this.isConnected || sequence !== this._refreshSequence) return;
      let status = this.querySelector('.dashboard-refresh-error');
      if (!status) {
        status = document.createElement('div');
        status.className = 'dashboard-refresh-error load-error';
        status.setAttribute('role', 'status');
        this.prepend(status);
      }
      status.textContent = `Live update failed: ${err.message}`;
    }
  }

  _render() {
    this.textContent = '';
    if (!this._schema) return;

    const { title, components = [] } = this._schema;

    if (title) {
      const header = document.createElement('div');
      header.className = 'workspace__header';
      const heading = document.createElement('div');
      heading.className = 'workspace__title';
      heading.textContent = title;
      header.appendChild(heading);
      this.appendChild(header);
    }

    const grid = document.createElement('div');
    grid.className = 'dashboard-grid';
    for (const component of components) {
      const card = this._renderComponent(component || {});
      if (card) grid.appendChild(card);
    }
    this.appendChild(grid);
  }

  _renderComponent(component) {
    const { type, data = {} } = component;
    const card = document.createElement('u2-card');

    switch (type) {
      case 'schedule': {
        card.title = CARD_TITLES.schedule;
        const el = document.createElement('u2-schedule');
        el.events = data.events || [];
        card.appendChild(el);
        break;
      }
      case 'task-list': {
        card.title = CARD_TITLES['task-list'];
        const el = document.createElement('u2-task-list');
        el.tasks = data.tasks || [];
        card.appendChild(el);
        break;
      }
      case 'email-summary': {
        card.title = CARD_TITLES['email-summary'];
        const el = document.createElement('u2-email-summary');
        el.emails = data.emails || [];
        card.appendChild(el);
        break;
      }
      case 'approval': {
        card.title = CARD_TITLES.approval;
        const actions = data.actions || [];
        if (!actions.length) {
          card.insertAdjacentHTML('beforeend', emptyState('Nothing needs your approval right now.'));
        } else {
          const list = document.createElement('div');
          list.className = 'approval-list';
          for (const action of actions) {
            const el = document.createElement('u2-approval');
            el.action = action;
            list.appendChild(el);
          }
          card.appendChild(list);
        }
        break;
      }
      case 'activity': {
        card.title = CARD_TITLES.activity;
        const el = document.createElement('u2-timeline');
        if (data.events) el.events = data.events;
        card.appendChild(el);
        break;
      }
      case 'alert': {
        const el = document.createElement('u2-alert');
        el.variant = data.variant || 'info';
        el.message = data.message || '';
        return el; // banner-style, not wrapped in a titled card
      }
      case 'recommendation': {
        card.title = CARD_TITLES.recommendation;
        const el = document.createElement('u2-recommendation');
        el.recommendationId = data.recommendationId || null;
        card.appendChild(el);
        break;
      }
      case 'person':
      case 'project': {
        card.title = CARD_TITLES[type];
        const el = document.createElement(`u2-${type}`);
        el.data = data;
        card.appendChild(el);
        break;
      }
      case 'conversation':
      case 'document': {
        card.title = CARD_TITLES[type];
        const el = document.createElement(`u2-${type}`);
        el.data = data;
        card.appendChild(el);
        break;
      }
      case 'chart':
      case 'map':
      case 'photo-grid': {
        card.title = CARD_TITLES[type];
        const el = document.createElement(`u2-${type}`);
        el.data = data;
        card.appendChild(el);
        break;
      }
      default: {
        const tag = `u2-${type}`;
        card.title = CARD_TITLES[type] || humanizeType(type);
        if (customElements.get(tag)) {
          card.appendChild(document.createElement(tag));
        } else {
          card.insertAdjacentHTML('beforeend', emptyState(`Unrecognized component type: ${escapeHtml(type)}`));
        }
      }
    }

    return card;
  }
}

customElements.define('u2-dashboard', U2Dashboard);
