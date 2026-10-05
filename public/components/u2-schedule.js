import { escapeHtml, formatTime, emptyState } from './util.js';

const DAY_FORMAT = { weekday: 'short', month: 'short', day: 'numeric' };

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
    if (this._bound) return;
    this._bound = true;
    // `selectable` titles are buttons that announce the chosen event (#437).
    // Dashboard cards use the list without the attribute and stay read-only.
    this.addEventListener('click', (event) => {
      if (!this.hasAttribute('selectable')) return;
      const btn = event.target.closest('[data-event-index]');
      const chosen = btn && this._events[Number(btn.dataset.eventIndex)];
      if (chosen) this.dispatchEvent(new CustomEvent('u2-event-select', { bubbles: true, detail: { event: chosen, opener: btn } }));
    });
  }

  _render() {
    this.classList.add('u2-schedule');
    if (!this._events.length) {
      this.innerHTML = emptyState('No events on the calendar.');
      return;
    }

    this.innerHTML = this._events
      .map((ev, index) => {
        const showDate = this.hasAttribute('show-date') && ev.start_at;
        const day = showDate ? `${new Date(ev.start_at).toLocaleDateString(undefined, DAY_FORMAT)} ` : '';
        const start = formatTime(ev.start_at);
        const end = ev.end_at ? formatTime(ev.end_at) : '';
        const attendees = (ev.attendees || []).map((a) => a.name).filter(Boolean).join(', ');
        const metaParts = [attendees, ev.location].filter(Boolean);
        return `
          <div class="u2-schedule__item">
            <div class="u2-schedule__time">${escapeHtml(day)}${escapeHtml(start)}${end ? `&ndash;${escapeHtml(end)}` : ''}</div>
            <div class="u2-schedule__body">
              ${this.hasAttribute('selectable')
                ? `<button type="button" class="u2-schedule__title u2-schedule__title--select" data-event-index="${index}">${escapeHtml(ev.title || 'Untitled event')}</button>`
                : `<div class="u2-schedule__title">${escapeHtml(ev.title || 'Untitled event')}</div>`}
              ${metaParts.length ? `<div class="u2-schedule__meta">${metaParts.map(escapeHtml).join(' &middot; ')}</div>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }
}

customElements.define('u2-schedule', U2Schedule);
