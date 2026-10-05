import { formatTime, emptyState } from './util.js';
import './u2-schedule.js';
import {
  VIEWS, startOfDay, addDays, startOfWeek, monthGrid, rangeFor, shift, periodLabel, eventsOnDay, sameDay, dayKey,
} from './calendar-math.js';

const VIEW_KEY = 'u2-calendar-view';
const VIEW_LABELS = { list: 'List', day: 'Day', week: 'Week', month: 'Month' };
const MAX_CHIPS = 3;

function storedView() {
  try {
    const view = localStorage.getItem(VIEW_KEY);
    return VIEWS.includes(view) ? view : null;
  } catch {
    return null;
  }
}

function storeView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* ignore -- private mode / storage disabled */
  }
}

// First day of the week from the browser's locale (1 = Monday ... 7 = Sunday),
// falling back to Sunday where the browser does not say.
function localeWeekStart() {
  try {
    const info = new Intl.Locale(navigator.language).weekInfo || new Intl.Locale(navigator.language).getWeekInfo?.();
    return info && Number.isInteger(info.firstDay) ? info.firstDay % 7 : 0;
  } catch {
    return 0;
  }
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// List, day, week and month views over the cached calendar (#437).
//
//   cal.loader = async (params) => ({ events, cache });   // params: { range } or { from, to }
//   cal.addEventListener('u2-calendar-select', (e) => e.detail.event / e.detail.opener);
//   cal.addEventListener('u2-calendar-loaded', (e) => e.detail.cache);
//   cal.reload();
export class U2Calendar extends HTMLElement {
  constructor() {
    super();
    this._view = storedView() || 'list';
    this._anchor = startOfDay(new Date());
    this._weekStartsOn = localeWeekStart();
    this._events = [];
    this._generation = 0;
  }

  set loader(fn) { this._loader = fn; if (this.isConnected) this.reload(); }
  get loader() { return this._loader; }

  connectedCallback() {
    this.classList.add('u2-calendar');
    this._build();
    // Settles when the first load has been handled (it never rejects), so a
    // view that awaits it behaves like the other async views.
    this.loaded = this.reload();
  }

  _build() {
    this.textContent = '';
    this._toolbar = node('div', 'u2-calendar__toolbar');
    this._body = node('div', 'u2-calendar__body');
    this.append(this._toolbar, this._body);
    this._renderToolbar();
  }

  async reload() {
    if (!this._loader || !this._body) return;
    const generation = ++this._generation;
    this._renderToolbar();
    this._body.textContent = '';
    this._body.append(node('div', 'empty-state', 'Loading calendar...'));
    try {
      const params = this._view === 'list'
        ? { range: 'upcoming' }
        : (({ from, to }) => ({ from: from.toISOString(), to: to.toISOString() }))(rangeFor(this._view, this._anchor, this._weekStartsOn));
      const { events, cache } = await this._loader(params);
      if (generation !== this._generation) return;
      this._events = Array.isArray(events) ? events : [];
      this.dispatchEvent(new CustomEvent('u2-calendar-loaded', { bubbles: true, detail: { cache } }));
      this._renderBody();
    } catch (err) {
      if (generation !== this._generation) return;
      this._body.textContent = '';
      const failure = node('div', 'load-error', `Couldn't load the calendar: ${err.message}`);
      this._body.append(failure);
    }
  }

  _setView(view) {
    if (view === this._view) return;
    this._view = view;
    storeView(view);
    this.reload();
    this._toolbar.querySelector(`[data-view="${view}"]`)?.focus();
  }

  _go(view, day) {
    this._anchor = startOfDay(day);
    this._view = view;
    storeView(view);
    this.reload();
    this._toolbar.querySelector(`[data-view="${view}"]`)?.focus();
  }

  _renderToolbar() {
    this._toolbar.textContent = '';
    if (this._view !== 'list') {
      const nav = node('div', 'u2-calendar__nav');
      const prev = node('button', 'btn', '‹');
      prev.type = 'button';
      prev.setAttribute('aria-label', `Previous ${this._view}`);
      prev.addEventListener('click', () => { this._anchor = shift(this._view, this._anchor, -1); this.reload(); });
      const today = node('button', 'btn', 'Today');
      today.type = 'button';
      today.addEventListener('click', () => { this._anchor = startOfDay(new Date()); this.reload(); });
      const next = node('button', 'btn', '›');
      next.type = 'button';
      next.setAttribute('aria-label', `Next ${this._view}`);
      next.addEventListener('click', () => { this._anchor = shift(this._view, this._anchor, 1); this.reload(); });
      const label = node('h2', 'u2-calendar__period', periodLabel(this._view, this._anchor, this._weekStartsOn));
      label.setAttribute('aria-live', 'polite');
      nav.append(prev, today, next, label);
      this._toolbar.append(nav);
    }
    const group = node('div', 'u2-calendar__views');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Calendar view');
    for (const view of VIEWS) {
      const btn = node('button', 'btn u2-calendar__view', VIEW_LABELS[view]);
      btn.type = 'button';
      btn.dataset.view = view;
      btn.setAttribute('aria-pressed', String(view === this._view));
      btn.addEventListener('click', () => this._setView(view));
      group.append(btn);
    }
    this._toolbar.append(group);
  }

  _select(event, opener) {
    this.dispatchEvent(new CustomEvent('u2-calendar-select', { bubbles: true, detail: { event, opener } }));
  }

  _eventButton(event, className, withTime = true) {
    const btn = node('button', className);
    btn.type = 'button';
    const time = withTime && event.start_at ? `${formatTime(event.start_at)} ` : '';
    btn.textContent = `${time}${event.title || 'Untitled event'}`;
    btn.addEventListener('click', () => this._select(event, btn));
    return btn;
  }

  _renderBody() {
    this._body.textContent = '';
    if (this._view === 'list') return this._renderList();
    if (this._view === 'day') return this._renderDay();
    if (this._view === 'week') return this._renderWeek();
    return this._renderMonth();
  }

  // The list and day views reuse the schedule rows used on dashboards, with
  // selectable titles.
  _schedule(events, { showDate }) {
    const schedule = document.createElement('u2-schedule');
    schedule.setAttribute('selectable', '');
    if (showDate) schedule.setAttribute('show-date', '');
    schedule.events = events;
    schedule.addEventListener('u2-event-select', (e) => this._select(e.detail.event, e.detail.opener));
    return schedule;
  }

  _renderList() {
    this._body.append(this._schedule(this._events, { showDate: true }));
  }

  _renderDay() {
    const events = eventsOnDay(this._events, this._anchor);
    if (!events.length) {
      this._body.insertAdjacentHTML('beforeend', emptyState('Nothing scheduled for this day.'));
      return;
    }
    this._body.append(this._schedule(events, { showDate: false }));
  }

  _dayHeading(day, className) {
    const btn = node('button', className, day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }));
    btn.type = 'button';
    btn.setAttribute('aria-label', `${day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, open day view`);
    if (sameDay(day, new Date())) btn.setAttribute('aria-current', 'date');
    btn.addEventListener('click', () => this._go('day', day));
    return btn;
  }

  _renderWeek() {
    const first = startOfWeek(this._anchor, this._weekStartsOn);
    const grid = node('div', 'u2-cal-week');
    for (let i = 0; i < 7; i++) {
      const day = addDays(first, i);
      const col = node('section', `u2-cal-week__day${sameDay(day, new Date()) ? ' is-today' : ''}`);
      col.dataset.date = dayKey(day);
      const heading = node('h3', 'u2-cal-week__heading');
      heading.append(this._dayHeading(day, 'u2-cal-daynum'));
      col.append(heading);
      const events = eventsOnDay(this._events, day);
      if (!events.length) col.append(node('p', 'u2-cal-week__empty', 'No events'));
      else {
        const list = node('ul', 'u2-cal-events');
        for (const event of events) {
          const li = node('li');
          li.append(this._eventButton(event, 'u2-cal-chip'));
          list.append(li);
        }
        col.append(list);
      }
      grid.append(col);
    }
    this._body.append(grid);
  }

  _renderMonth() {
    const weeks = monthGrid(this._anchor, this._weekStartsOn);
    const table = node('table', 'u2-cal-month');
    table.append(node('caption', 'sr-only', periodLabel('month', this._anchor)));
    const head = node('tr');
    for (const day of weeks[0]) {
      const th = node('th', '', day.toLocaleDateString(undefined, { weekday: 'short' }));
      th.scope = 'col';
      head.append(th);
    }
    const thead = node('thead');
    thead.append(head);
    const tbody = node('tbody');
    for (const week of weeks) {
      const tr = node('tr');
      for (const day of week) {
        const td = node('td', `u2-cal-month__cell${day.getMonth() !== this._anchor.getMonth() ? ' is-outside' : ''}${sameDay(day, new Date()) ? ' is-today' : ''}`);
        td.dataset.date = dayKey(day);
        const num = this._dayHeading(day, 'u2-cal-daynum');
        num.textContent = String(day.getDate());
        td.append(num);
        const events = eventsOnDay(this._events, day);
        if (events.length) {
          const list = node('ul', 'u2-cal-events');
          for (const event of events.slice(0, MAX_CHIPS)) {
            const li = node('li');
            li.append(this._eventButton(event, 'u2-cal-chip'));
            list.append(li);
          }
          if (events.length > MAX_CHIPS) {
            const li = node('li');
            const more = node('button', 'u2-cal-more', `+${events.length - MAX_CHIPS} more`);
            more.type = 'button';
            more.addEventListener('click', () => this._go('day', day));
            li.append(more);
            list.append(li);
          }
          td.append(list);
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    this._body.append(table);
  }
}

customElements.define('u2-calendar', U2Calendar);
