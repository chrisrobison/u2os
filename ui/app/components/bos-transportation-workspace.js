function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function dateKey(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function toMonthKey(value) {
  const iso = toIso(value) || new Date().toISOString();
  return iso.slice(0, 7);
}

function shiftMonth(monthKey, delta) {
  const [year, month] = String(monthKey).split('-').map((v) => Number(v));
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return next.toISOString().slice(0, 7);
}

function formatDate(value) {
  if (!value) return 'No date';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatTime(value) {
  if (!value) return '--:--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--:--';
  return parsed.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey).split('-').map((v) => Number(v));
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function monthBounds(monthKey) {
  const [year, month] = String(monthKey).split('-').map((v) => Number(v));
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return { first, last };
}

function statusBadge(status) {
  const value = String(status || 'unspecified').toLowerCase();
  const map = {
    requested: 'Requested',
    pending: 'Pending',
    quoted: 'Quoted',
    scheduled: 'Scheduled',
    in_progress: 'In Progress',
    completed: 'Completed',
    cancelled: 'Cancelled'
  };
  return map[value] || value;
}

function routeLabel(trip) {
  return trip?.route_name || trip?.transportation_trip || 'Trip';
}

function money(value) {
  const num = Number(value || 0);
  return num.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD'
  });
}

function normalizeStops(stops) {
  if (!Array.isArray(stops)) return [];
  return stops.map((stop, index) => ({
    ...stop,
    orderIndex: index + 1,
    label: stop.label || stop.formatted || `Stop ${index + 1}`
  }));
}

class BosTransportationWorkspace extends HTMLElement {
  constructor() {
    super();
    this.state = {
      view: 'dashboard',
      selectedDate: dateKey(new Date()),
      selectedMonth: toMonthKey(new Date()),
      selectedTripId: null,
      dashboard: null,
      calendar: null,
      mapData: null
    };

    this.$root = null;
    this.$title = null;
    this.$subtitle = null;
  }

  connectedCallback() {
    this.renderShell();
    this.loadView().catch((error) => this.showError(error));
  }

  set config(value) {
    const next = value || {};
    this.state.view = next.view || 'dashboard';
    if (this.isConnected) {
      this.loadView().catch((error) => this.showError(error));
    }
  }

  get config() {
    return { view: this.state.view };
  }

  emitRuntimeEvent(event, context = {}) {
    this.dispatchEvent(new CustomEvent('bos:runtime-event', {
      detail: { event, context },
      bubbles: true,
      composed: true
    }));
  }

  async fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  renderShell() {
    this.innerHTML = `
      <section class="transport-workspace">
        <header class="transport-header">
          <p class="transport-badge">Transportation Ops</p>
          <h2 class="transport-title" data-role="title">Transportation Operations</h2>
          <p class="transport-subtle" data-role="subtitle">Dispatch, scheduling, and route execution.</p>
        </header>
        <div data-role="content" class="transport-content"></div>
      </section>
    `;

    this.$root = this.querySelector('[data-role="content"]');
    this.$title = this.querySelector('[data-role="title"]');
    this.$subtitle = this.querySelector('[data-role="subtitle"]');
    this.updateHeader();
  }

  updateHeader() {
    const copyByView = {
      dashboard: {
        title: 'Transportation Operations',
        subtitle: 'Dispatch health, requests, and upcoming trips at a glance.'
      },
      calendar: {
        title: 'Dispatch Calendar',
        subtitle: 'Plan departures and manage daily tour and school trip execution.'
      },
      map: {
        title: 'Route Map',
        subtitle: 'Visualize pickup, waypoints, and dropoff path for active trips.'
      }
    };

    const copy = copyByView[this.state.view] || copyByView.dashboard;
    this.$title.textContent = copy.title;
    this.$subtitle.textContent = copy.subtitle;
  }

  showError(error) {
    this.$root.innerHTML = `<div class="transport-empty">${escapeHtml(error.message || 'Failed to load')}</div>`;
  }

  async loadView() {
    this.updateHeader();
    this.$root.innerHTML = '<div class="transport-empty">Loading transportation workspace...</div>';

    if (this.state.view === 'dashboard') {
      this.state.dashboard = await this.fetchJson(`/api/modules/transportation-module/dashboard?date=${encodeURIComponent(this.state.selectedDate)}`);
      this.renderDashboard();
      this.emitRuntimeEvent('onLoad', { view: 'dashboard' });
      return;
    }

    if (this.state.view === 'calendar') {
      this.state.calendar = await this.fetchJson(`/api/modules/transportation-module/calendar?month=${encodeURIComponent(this.state.selectedMonth)}&date=${encodeURIComponent(this.state.selectedDate)}`);
      this.renderCalendar();
      this.emitRuntimeEvent('onLoad', { view: 'calendar' });
      return;
    }

    if (this.state.view === 'map') {
      const query = this.state.selectedTripId
        ? `?trip_id=${encodeURIComponent(this.state.selectedTripId)}`
        : '';
      this.state.mapData = await this.fetchJson(`/api/modules/transportation-module/map${query}`);
      this.renderMap();
      this.emitRuntimeEvent('onLoad', { view: 'map' });
      return;
    }

    this.$root.innerHTML = `<div class="transport-empty">Unknown view '${escapeHtml(this.state.view)}'</div>`;
  }

  renderMetricCards(metrics = {}) {
    return `
      <section class="transport-metric-grid">
        <article class="transport-card metric-card">
          <p>Open Requests</p>
          <strong>${metrics.openRequests ?? 0}</strong>
        </article>
        <article class="transport-card metric-card">
          <p>Trips Today</p>
          <strong>${metrics.todayTrips ?? 0}</strong>
        </article>
        <article class="transport-card metric-card">
          <p>Active Trips</p>
          <strong>${metrics.activeTrips ?? 0}</strong>
        </article>
        <article class="transport-card metric-card">
          <p>Completed Today</p>
          <strong>${metrics.completedToday ?? 0}</strong>
        </article>
        <article class="transport-card metric-card">
          <p>Buses Available</p>
          <strong>${metrics.busesAvailable ?? 0}</strong>
        </article>
        <article class="transport-card metric-card">
          <p>Drivers Available</p>
          <strong>${metrics.driversAvailable ?? 0}</strong>
        </article>
        <article class="transport-card metric-card">
          <p>Monthly Revenue</p>
          <strong>${money(metrics.monthlyRevenue || 0)}</strong>
        </article>
        <article class="transport-card metric-card">
          <p>Outstanding Invoices</p>
          <strong>${money(metrics.outstandingInvoiceAmount || 0)}</strong>
        </article>
      </section>
    `;
  }

  renderTripRows(items = [], opts = {}) {
    return items.map((trip) => {
      const tripId = trip.public_id || trip.id;
      const departure = trip.planned_departure_at || (trip.trip_date ? `${trip.trip_date}T08:00:00.000Z` : null);
      return `
        <li class="transport-list-row">
          <div>
            <strong>${escapeHtml(routeLabel(trip))}</strong>
            <p>${escapeHtml(trip.customer_name || 'Unassigned customer')}</p>
            <small>${escapeHtml(trip.pickup_address?.formatted || 'No pickup')} → ${escapeHtml(trip.dropoff_address?.formatted || 'No dropoff')}</small>
          </div>
          <div>
            <small>${escapeHtml(formatDate(departure))} ${escapeHtml(formatTime(departure))}</small>
            <small>${escapeHtml(trip.driver?.name || 'Driver TBD')} · ${escapeHtml(trip.bus?.bus_number || 'Bus TBD')}</small>
            <span class="transport-status ${escapeHtml(String(trip.status || '').toLowerCase())}">${escapeHtml(statusBadge(trip.status))}</span>
          </div>
          <div class="transport-row-actions">
            ${opts.allowStart && String(trip.status || '').toLowerCase() === 'scheduled'
    ? `<button type="button" data-action="start-trip" data-trip-id="${escapeHtml(tripId)}">Start</button>`
    : ''}
            ${opts.allowComplete && ['scheduled', 'in_progress'].includes(String(trip.status || '').toLowerCase())
    ? `<button type="button" data-action="complete-trip" data-trip-id="${escapeHtml(tripId)}">Complete</button>`
    : ''}
          </div>
        </li>
      `;
    }).join('');
  }

  renderRequestRows(items = []) {
    return items.map((request) => {
      const requestId = request.public_id || request.id;
      return `
        <li class="transport-list-row compact">
          <div>
            <strong>${escapeHtml(request.transportation_request || 'Trip Request')}</strong>
            <p>${escapeHtml(request.customer_name || 'Unknown customer')}</p>
            <small>${escapeHtml(request.pickup_address?.formatted || 'No pickup')} → ${escapeHtml(request.dropoff_address?.formatted || 'No dropoff')}</small>
          </div>
          <div>
            <small>${escapeHtml(formatDate(request.trip_date))}</small>
            <small>${Number(request.requested_head_count || 0)} riders</small>
            <span class="transport-status ${escapeHtml(String(request.status || '').toLowerCase())}">${escapeHtml(statusBadge(request.status))}</span>
          </div>
          <div class="transport-row-actions">
            <button type="button" data-action="schedule-from-request" data-request-id="${escapeHtml(requestId)}">Schedule</button>
          </div>
        </li>
      `;
    }).join('');
  }

  bindDashboardActions() {
    this.querySelector('[data-action="new-request"]')?.addEventListener('click', async () => {
      await this.createRequestPrompt();
    });

    this.querySelectorAll('[data-action="schedule-from-request"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const requestId = button.getAttribute('data-request-id');
        if (!requestId) return;
        await this.createTripFromRequest(requestId);
      });
    });

    this.querySelectorAll('[data-action="start-trip"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const tripId = button.getAttribute('data-trip-id');
        if (!tripId) return;
        await this.startTrip(tripId);
      });
    });

    this.querySelectorAll('[data-action="complete-trip"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const tripId = button.getAttribute('data-trip-id');
        if (!tripId) return;
        await this.completeTripPrompt(tripId);
      });
    });
  }

  async createRequestPrompt() {
    const tripDate = window.prompt('Trip date (YYYY-MM-DD):', this.state.selectedDate) || this.state.selectedDate;
    const headCount = window.prompt('Requested rider head count:', '40') || '40';
    const pickup = window.prompt('Pickup address line:', '123 Main St') || '123 Main St';
    const dropoff = window.prompt('Dropoff address line:', 'Museum Way') || 'Museum Way';
    const schoolName = window.prompt('School or group name (optional):', '') || '';

    await this.fetchJson('/api/modules/transportation-module/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trip_date: tripDate,
        requested_head_count: Number(headCount) || null,
        school_name: schoolName || null,
        trip_type: 'school-trip',
        pickup_address: { line1: pickup, city: 'Local', state: 'CA', country: 'US', label: 'Pickup' },
        dropoff_address: { line1: dropoff, city: 'Local', state: 'CA', country: 'US', label: 'Dropoff' }
      })
    });

    this.emitRuntimeEvent('afterSave', {
      view: 'dashboard',
      type: 'transportation_request'
    });

    await this.loadView();
  }

  async createTripFromRequest(requestId) {
    const routeName = window.prompt('Route name for this trip:', 'School Route') || 'School Route';
    const departure = window.prompt('Planned departure (YYYY-MM-DDTHH:MM):', `${this.state.selectedDate}T08:00`) || `${this.state.selectedDate}T08:00`;
    const arrival = window.prompt('Planned arrival (YYYY-MM-DDTHH:MM):', `${this.state.selectedDate}T10:00`) || `${this.state.selectedDate}T10:00`;

    await this.fetchJson('/api/modules/transportation-module/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: requestId,
        route_name: routeName,
        planned_departure_at: new Date(departure).toISOString(),
        planned_arrival_at: new Date(arrival).toISOString(),
        status: 'scheduled'
      })
    });

    this.emitRuntimeEvent('afterSave', {
      view: 'dashboard',
      type: 'transportation_trip'
    });

    await this.loadView();
  }

  async startTrip(tripId) {
    await this.fetchJson(`/api/modules/transportation-module/trips/${encodeURIComponent(tripId)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    this.emitRuntimeEvent('afterSave', {
      view: this.state.view,
      type: 'transportation_trip',
      tripId
    });

    await this.loadView();
  }

  async completeTripPrompt(tripId) {
    const actualHeadCount = window.prompt('Actual head count:', '38') || '38';
    const actualMiles = window.prompt('Actual miles driven:', '24.5') || '24.5';
    const actualDeparture = window.prompt('Actual departure (YYYY-MM-DDTHH:MM):', `${this.state.selectedDate}T08:03`) || `${this.state.selectedDate}T08:03`;
    const actualArrival = window.prompt('Actual arrival (YYYY-MM-DDTHH:MM):', `${this.state.selectedDate}T10:14`) || `${this.state.selectedDate}T10:14`;

    await this.fetchJson(`/api/modules/transportation-module/trips/${encodeURIComponent(tripId)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actual_head_count: Number(actualHeadCount) || null,
        actual_miles: Number(actualMiles) || null,
        actual_departure_at: new Date(actualDeparture).toISOString(),
        actual_arrival_at: new Date(actualArrival).toISOString(),
        completion_status: 'completed'
      })
    });

    this.emitRuntimeEvent('afterSave', {
      view: this.state.view,
      type: 'transportation_trip_result',
      tripId
    });

    await this.loadView();
  }

  renderDashboard() {
    const data = this.state.dashboard || {};
    const todayTrips = this.renderTripRows(data.todayTrips || [], {
      allowStart: true,
      allowComplete: true
    });
    const upcoming = this.renderTripRows(data.upcomingTrips || [], {
      allowStart: true,
      allowComplete: true
    });
    const requests = this.renderRequestRows(data.openRequests || []);

    this.$root.innerHTML = `
      ${this.renderMetricCards(data.metrics || {})}
      <section class="transport-grid-2">
        <article class="transport-card">
          <header class="transport-card-header">
            <h3>Today Trips</h3>
            <button type="button" data-action="new-request">New Request</button>
          </header>
          <ul class="transport-list">${todayTrips || '<li class="transport-empty-li">No trips scheduled for this date.</li>'}</ul>
        </article>

        <article class="transport-card">
          <header class="transport-card-header">
            <h3>Open Requests</h3>
          </header>
          <ul class="transport-list">${requests || '<li class="transport-empty-li">No open requests.</li>'}</ul>
        </article>

        <article class="transport-card transport-wide">
          <header class="transport-card-header">
            <h3>Upcoming Dispatch Queue</h3>
          </header>
          <ul class="transport-list">${upcoming || '<li class="transport-empty-li">No upcoming trips.</li>'}</ul>
        </article>
      </section>
    `;

    this.bindDashboardActions();
  }

  renderCalendarGrid() {
    const data = this.state.calendar || { dailyCounts: {} };
    const { first, last } = monthBounds(this.state.selectedMonth);
    const startWeekday = first.getUTCDay();
    const daysInMonth = last.getUTCDate();
    const cells = [];

    for (let i = 0; i < startWeekday; i += 1) {
      cells.push('<div class="transport-day muted"></div>');
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day));
      const key = date.toISOString().slice(0, 10);
      const count = data.dailyCounts?.[key] || 0;
      const active = key === this.state.selectedDate ? 'active' : '';
      cells.push(`
        <button type="button" class="transport-day ${active}" data-date="${key}">
          <span>${day}</span>
          ${count > 0 ? `<small>${count} trips</small>` : ''}
        </button>
      `);
    }

    return cells.join('');
  }

  bindCalendarActions() {
    this.querySelector('[data-action="prev-month"]')?.addEventListener('click', async () => {
      this.state.selectedMonth = shiftMonth(this.state.selectedMonth, -1);
      this.state.selectedDate = `${this.state.selectedMonth}-01`;
      await this.loadView();
    });

    this.querySelector('[data-action="next-month"]')?.addEventListener('click', async () => {
      this.state.selectedMonth = shiftMonth(this.state.selectedMonth, 1);
      this.state.selectedDate = `${this.state.selectedMonth}-01`;
      await this.loadView();
    });

    this.querySelector('[data-action="new-request"]')?.addEventListener('click', async () => {
      await this.createRequestPrompt();
    });

    this.querySelectorAll('[data-date]').forEach((button) => {
      button.addEventListener('click', async () => {
        this.state.selectedDate = button.dataset.date;
        await this.loadView();
      });
    });

    this.querySelectorAll('[data-action="start-trip"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const tripId = button.getAttribute('data-trip-id');
        if (!tripId) return;
        await this.startTrip(tripId);
      });
    });

    this.querySelectorAll('[data-action="complete-trip"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const tripId = button.getAttribute('data-trip-id');
        if (!tripId) return;
        await this.completeTripPrompt(tripId);
      });
    });
  }

  renderCalendar() {
    const data = this.state.calendar || {};
    const dayRows = this.renderTripRows(data.daySchedule || [], {
      allowStart: true,
      allowComplete: true
    });

    this.$root.innerHTML = `
      <section class="transport-grid-2">
        <article class="transport-card">
          <header class="transport-card-header">
            <h3>${escapeHtml(formatMonthLabel(this.state.selectedMonth))}</h3>
            <div class="transport-inline-actions">
              <button type="button" data-action="prev-month">←</button>
              <button type="button" data-action="next-month">→</button>
            </div>
          </header>
          <div class="transport-weekdays">
            <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
          </div>
          <div class="transport-calendar-grid">${this.renderCalendarGrid()}</div>
        </article>

        <article class="transport-card">
          <header class="transport-card-header">
            <h3>${escapeHtml(formatDate(`${this.state.selectedDate}T00:00:00Z`))}</h3>
            <button type="button" data-action="new-request">New Request</button>
          </header>
          <ul class="transport-list">${dayRows || '<li class="transport-empty-li">No trips planned for this day.</li>'}</ul>
        </article>
      </section>
    `;

    this.bindCalendarActions();
  }

  bindMapActions() {
    this.querySelector('[data-role="trip-select"]')?.addEventListener('change', async (event) => {
      const nextId = event.target.value || null;
      this.state.selectedTripId = nextId || null;
      await this.loadView();
    });

    this.querySelector('[data-action="refresh-map"]')?.addEventListener('click', async () => {
      await this.loadView();
    });

    this.querySelector('[data-action="start-selected-trip"]')?.addEventListener('click', async () => {
      if (!this.state.selectedTripId) return;
      await this.startTrip(this.state.selectedTripId);
    });

    this.querySelector('[data-action="complete-selected-trip"]')?.addEventListener('click', async () => {
      if (!this.state.selectedTripId) return;
      await this.completeTripPrompt(this.state.selectedTripId);
    });
  }

  renderRoutePlot(routePlot) {
    if (!routePlot || !routePlot.hasPlot) {
      return `
        <div class="transport-map-empty">
          Add latitude and longitude to pickup/dropoff/waypoint addresses to render a route path.
        </div>
      `;
    }

    const circles = (routePlot.points || []).map((point, index) => `
      <g>
        <circle cx="${point.x}" cy="${point.y}" r="7"></circle>
        <text x="${point.x + 10}" y="${point.y - 10}">${escapeHtml(`${index + 1}. ${point.label || 'Stop'}`)}</text>
      </g>
    `).join('');

    return `
      <svg viewBox="0 0 620 340" role="img" aria-label="Route plot" class="transport-route-plot">
        <rect x="10" y="10" width="600" height="320" rx="12" ry="12"></rect>
        <polyline points="${escapeHtml(routePlot.polyline || '')}"></polyline>
        ${circles}
      </svg>
    `;
  }

  renderMap() {
    const data = this.state.mapData || {};
    const trips = Array.isArray(data.trips) ? data.trips : [];
    const selectedTrip = data.selectedTrip || null;
    const selectedTripLookup = selectedTrip ? (selectedTrip.public_id || selectedTrip.id) : null;
    if (selectedTripLookup) {
      this.state.selectedTripId = selectedTripLookup;
    }

    const options = trips.map((trip) => {
      const lookupId = trip.public_id || trip.id;
      const selected = lookupId === this.state.selectedTripId ? 'selected' : '';
      return `<option value="${escapeHtml(lookupId)}" ${selected}>${escapeHtml(lookupId)} · ${escapeHtml(routeLabel(trip))}</option>`;
    }).join('');

    const stops = normalizeStops(data.stops || []);
    const stopRows = stops.map((stop) => `
      <li class="transport-stop-row">
        <strong>${escapeHtml(`${stop.orderIndex}. ${stop.label}`)}</strong>
        <small>${escapeHtml(stop.formatted || 'No address')}</small>
        <small>${escapeHtml(stop.type)}</small>
      </li>
    `).join('');

    const mapLinks = data.mapLinks || {};
    const canStart = selectedTrip && String(selectedTrip.status || '').toLowerCase() === 'scheduled';
    const canComplete = selectedTrip && ['scheduled', 'in_progress'].includes(String(selectedTrip.status || '').toLowerCase());

    this.$root.innerHTML = `
      <section class="transport-grid-2">
        <article class="transport-card">
          <header class="transport-card-header">
            <h3>Trip Selection</h3>
            <button type="button" data-action="refresh-map">Refresh</button>
          </header>

          <label class="transport-field">
            <span>Trip</span>
            <select data-role="trip-select">
              <option value="">Select a trip</option>
              ${options}
            </select>
          </label>

          <div class="transport-inline-actions">
            ${canStart ? '<button type="button" data-action="start-selected-trip">Start Trip</button>' : ''}
            ${canComplete ? '<button type="button" data-action="complete-selected-trip">Complete Trip</button>' : ''}
          </div>

          <ul class="transport-stop-list">${stopRows || '<li class="transport-empty-li">No stops available for selected trip.</li>'}</ul>

          <div class="transport-map-links">
            ${mapLinks.googleDirections ? `<a href="${escapeHtml(mapLinks.googleDirections)}" target="_blank" rel="noopener noreferrer">Open Route in Google Maps</a>` : ''}
            ${mapLinks.staticSearch ? `<a href="${escapeHtml(mapLinks.staticSearch)}" target="_blank" rel="noopener noreferrer">Open First Stop in Maps</a>` : ''}
          </div>
        </article>

        <article class="transport-card">
          <header class="transport-card-header">
            <h3>${escapeHtml(selectedTrip ? routeLabel(selectedTrip) : 'Route Plot')}</h3>
            <span class="transport-status ${escapeHtml(String(selectedTrip?.status || '').toLowerCase())}">${escapeHtml(statusBadge(selectedTrip?.status))}</span>
          </header>

          ${this.renderRoutePlot(data.routePlot)}

          <p class="transport-subtle">
            ${escapeHtml(selectedTrip?.pickup_address?.formatted || 'No pickup')} → ${escapeHtml(selectedTrip?.dropoff_address?.formatted || 'No dropoff')}
          </p>
          <p class="transport-subtle">${escapeHtml(selectedTrip?.driver?.name || 'Driver TBD')} · ${escapeHtml(selectedTrip?.bus?.bus_number || 'Bus TBD')}</p>
        </article>
      </section>
    `;

    this.bindMapActions();
  }
}

customElements.define('bos-transportation-workspace', BosTransportationWorkspace);
