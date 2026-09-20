import { escapeHtml, formatTime, emptyState } from './util.js';
import { getEvents } from '../services/api.js';
import './u2-why.js';

const EVENT_LABELS = {
  'calendar.event_added': 'Added a calendar event',
  'calendar.event_changed': 'Rescheduled a calendar event',
  'calendar.event_approaching': 'Noticed an event coming up',
  'email.received': 'Received an email',
  'email.sent': 'Sent an email',
  'contact.birthday_approaching': 'Noticed an upcoming birthday',
  'task.created': 'Created a task',
  'task.completed': 'Completed a task',
  'task.overdue': 'Flagged an overdue task',
  'notification.sent': 'Sent a notification',
  'agent.message.received': 'Read your message',
  'agent.action.proposed': 'Proposed an action',
  'agent.action.approved': 'You approved an action',
  'agent.action.rejected': 'You cancelled an action',
  'agent.action.completed': 'Finished an action',
  'agent.action.failed': 'An action failed',
  'user.feedback': 'Recorded your feedback',
  'memory.fact_recorded': 'Remembered something new',
  'memory.relationship_recorded': 'Recorded a relationship',
  'commitment.made': 'Noted a commitment',
};

function humanizeEvent(evt) {
  const label = EVENT_LABELS[evt.type] || evt.type.replace(/[._]+/g, ' ');
  const title = evt.data?.after?.title || evt.data?.title;
  return title ? `${label}: "${title}"` : label;
}

function actionIdForEvent(evt) {
  return evt.subject?.type === 'agent_action' && evt.subject.id ? evt.subject.id : null;
}

function recommendationIdForEvent(evt) {
  return evt.subject?.type === 'recommendation' && evt.subject.id ? evt.subject.id : null;
}

// property `events` -> render exactly what's given, no live merge (used
// when a parent already owns a fixed list). If left unset, this component
// fetches GET /api/events?limit=<limit> itself on connect and stays live via
// the window `u2-event` CustomEvent bus.
//
// property/attribute `limit` -> how many events the standalone fetch asks
// for (and the cap applied to the live-merged list). Defaults to 20 (the
// small dashboard-card usage); a full-page view like #/activity sets this
// higher (e.g. 50) before the element connects.
export class U2Timeline extends HTMLElement {
  static get observedAttributes() {
    return ['limit'];
  }

  constructor() {
    super();
    this._events = null;
    this._standalone = false;
    this._limit = 20;
    this._onWindowEvent = this._onWindowEvent.bind(this);
  }

  set events(list) {
    this._standalone = false;
    this._events = Array.isArray(list) ? list.slice() : [];
    this._render();
  }

  get events() {
    return this._events || [];
  }

  set limit(value) {
    const n = Number(value);
    this._limit = Number.isFinite(n) && n > 0 ? n : 20;
  }

  get limit() {
    return this._limit;
  }

  attributeChangedCallback(name, _oldValue, newValue) {
    if (name === 'limit') this.limit = newValue;
  }

  async connectedCallback() {
    window.addEventListener('u2-event', this._onWindowEvent);
    if (this._events === null) {
      this._standalone = true;
      this.innerHTML = emptyState('Loading activity...');
      try {
        const { events } = await getEvents({ limit: this._limit });
        this._events = events;
        this._render();
      } catch (err) {
        this.innerHTML = `<div class="load-error">Couldn't load activity: ${escapeHtml(err.message)}</div>`;
      }
    } else {
      this._render();
    }
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onWindowEvent);
  }

  _onWindowEvent(e) {
    if (!this._standalone) return; // parent owns the list for a non-standalone instance
    this._events = [e.detail, ...(this._events || [])].slice(0, this._limit);
    this._render(true);
  }

  _render(highlightFirst = false) {
    this.classList.add('u2-timeline');
    const events = this._events || [];
    if (!events.length) {
      this.innerHTML = emptyState('No activity yet.');
      return;
    }

    this.innerHTML = events
      .map((evt, i) => {
        const when = formatTime(evt.timestamp || evt.createdAt);
        const actionId = actionIdForEvent(evt);
        const recommendationId = recommendationIdForEvent(evt);
        return `
          <div class="u2-timeline__item ${highlightFirst && i === 0 ? 'is-new' : ''}">
            <span class="u2-timeline__time">${escapeHtml(when)}</span>
            <span class="u2-timeline__label">${escapeHtml(humanizeEvent(evt))}</span>
            ${actionId ? `<u2-why action-id="${escapeHtml(actionId)}"></u2-why>` : ''}
            ${recommendationId ? `<u2-why recommendation-id="${escapeHtml(recommendationId)}"></u2-why>` : ''}
          </div>
        `;
      })
      .join('');
  }
}

customElements.define('u2-timeline', U2Timeline);
