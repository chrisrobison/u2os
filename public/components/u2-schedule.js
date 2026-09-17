import { escapeHtml, formatTime, emptyState } from './util.js';

// property `events` -> array as returned by GET /api/calendar/events.
export class U2Schedule extends HTMLElement {
  constructor() {
    super();
    this._events = [];
  }

  set events(list) {
    this._events = Array.isArray(list) ? list : [];
    this._render();
  }

  get events() {
    return this._events;
  }

  connectedCallback() {
    this._render();
  }

  _render() {
    this.classList.add('u2-schedule');
    if (!this._events.length) {
      this.innerHTML = emptyState('No events on the calendar.');
      return;
    }

    this.innerHTML = this._events
      .map((ev) => {
        const start = formatTime(ev.start_at);
        const end = ev.end_at ? formatTime(ev.end_at) : '';
        const attendees = (ev.attendees || []).map((a) => a.name).filter(Boolean).join(', ');
        const metaParts = [attendees, ev.location].filter(Boolean);
        return `
          <div class="u2-schedule__item">
            <div class="u2-schedule__time">${escapeHtml(start)}${end ? `&ndash;${escapeHtml(end)}` : ''}</div>
            <div class="u2-schedule__body">
              <div class="u2-schedule__title">${escapeHtml(ev.title || 'Untitled event')}</div>
              ${metaParts.length ? `<div class="u2-schedule__meta">${metaParts.map(escapeHtml).join(' &middot; ')}</div>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }
}

customElements.define('u2-schedule', U2Schedule);
