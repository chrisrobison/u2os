import { escapeHtml, humanizeKey } from './util.js';
import * as api from '../services/api.js';
import { EventsService } from '../services/events.js';
import { DeviceClientService } from '../services/device-client.js';
import './u2-device-panel.js';
import './u2-nav.js';
import './u2-agent.js';
import './u2-dashboard.js';
import './u2-schedule.js';
import './u2-calendar.js';
import './u2-task-list.js';
import './u2-section.js';
import { getModal } from './u2-modal.js';
import { buildReplyLink } from './mail-reply.js';
import { contactStatus, contactLabel, matchesQuery } from './record-helpers.js';
import './u2-email-summary.js';
import './u2-connectors.js';
import './u2-timeline.js';
import './u2-voice.js';
import './u2-devices.js';
import './u2-operations.js';
import './u2-routines.js';
import './u2-vault.js';
import './u2-applications.js';
import './u2-goals.js';
import './u2-triggers.js';
import './u2-packages.js';
import './u2-diagnostics.js';
import './u2-model.js';
import './u2-addons.js';
import './u2-onboarding.js';

// Dashboard contexts the #/dashboards picker offers, per PROMPT.md section
// 10's examples + docs/dashboards.md's Phase 2 contexts. 'before-meeting'
// and 'project' each need a trusted picker. Meeting preparation starts from
// a calendar event so its topic and every attendee travel together.
const DASHBOARD_CONTEXTS = [
  { id: 'morning', label: 'Morning' },
  { id: 'before-meeting', label: 'Before a meeting', eventPicker: true, paramKey: 'eventId' },
  { id: 'project', label: 'Project', entityType: 'Project', paramKey: 'projectId' },
];

// Gated actions can finish as pending (awaiting approval) or blocked rather
// than executed. Tell the owner instead of closing the dialog as if it worked.
function requireExecuted(outcome, what) {
  if (outcome && outcome.status === 'executed') return outcome;
  if (outcome && outcome.status === 'pending') throw new Error(`Policy needs your approval to ${what}. Review it in Operations.`);
  throw new Error(`Could not ${what}${outcome && outcome.reason ? `: ${outcome.reason}` : '.'}`);
}

// People and projects are vault records (#438, #439): the list shows what the
// files say, "+" opens an empty dialog, and a row opens the same dialog filled.
const PROJECT_STATUSES = ['active', 'planned', 'blocked', 'paused', 'done'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
const RECORD_KINDS = {
  Project: {
    type: 'Project',
    heading: 'Projects',
    addLabel: 'New project',
    singular: 'Project',
    detailBase: '#/projects',
    empty: 'No projects yet. Use + to add one.',
    formFields: [
      { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
      { name: 'status', label: 'Status', type: 'select', options: PROJECT_STATUSES },
      { name: 'deadline', label: 'Deadline', type: 'plaindate' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 6, maxLength: 20000 },
    ],
  },
  Person: {
    type: 'Person',
    heading: 'People',
    addLabel: 'New person',
    singular: 'Person',
    detailBase: '#/people',
    searchable: true,
    empty: 'No people yet. Use + to add one.',
    formFields: [
      { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
      { name: 'relationship', label: 'Relationship to you', type: 'text', maxLength: 100, placeholder: 'sister, colleague, recruiter...' },
      { name: 'organization', label: 'Organization', type: 'text', maxLength: 200 },
      { name: 'email', label: 'Email', type: 'text', maxLength: 320 },
      { name: 'phone', label: 'Phone', type: 'text', maxLength: 64 },
      { name: 'birthday', label: 'Birthday', type: 'plaindate' },
      { name: 'keep_in_touch_days', label: 'Keep in touch every (days)', type: 'text', maxLength: 4, help: 'Mark this person as due when this many days pass without contact.' },
      { name: 'last_contact', label: 'Last contact', type: 'plaindate' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 5, maxLength: 20000 },
    ],
  },
};
const PROJECTS = RECORD_KINDS.Project;
const PEOPLE = RECORD_KINDS.Person;

const THEME_KEY = 'u2-theme';
const DAILY_REVIEW_PROMPT = "What's going on today? Handle anything routine that doesn't need me and tell me what I need to pay attention to.";

function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore -- private mode / storage disabled */
  }
}

function effectiveTheme() {
  const stored = getStoredTheme();
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Root shell: header, three-pane body (nav | workspace | agent), hash
// routing into the workspace pane, and one shared SSE connection kept
// alive across route changes.
export class U2App extends HTMLElement {
  async connectedCallback() {
    if (this._built) return;
    this._built = true;

    try {
      const status = await api.getAuthStatus();
      if (!status.authenticated) return this._renderAuth(status.setupRequired);
    } catch (err) {
      this.innerHTML = `<main class="workspace"><div class="load-error">Unable to contact U2OS: ${escapeHtml(err.message)}</div></main>`;
      return;
    }

    // First-run onboarding (#413, docs/onboarding.md): a brand-new owner is
    // walked through the wizard instead of being dropped straight into the
    // full shell. An owner who already completed it goes straight to the
    // dashboard below, same as today. Reopening the wizard later happens
    // through the #/onboarding route instead (see _route()), which never
    // re-gates an already onboarded owner.
    try {
      const onboarding = await api.getOnboardingStatus();
      if (!onboarding.completed) return this._renderOnboarding();
    } catch (err) {
      this.innerHTML = `<main class="workspace"><div class="load-error">Unable to contact U2OS: ${escapeHtml(err.message)}</div></main>`;
      return;
    }

    this.innerHTML = `
      <div class="shell">
        <a class="skip-link" href="#workspace">Skip to workspace</a>
        <header class="shell__header">
          <button type="button" class="icon-btn shell__drawer-toggle" data-toggle="nav" aria-label="Toggle navigation">&#9776;</button>
          <span class="shell__brand">U2OS</span>
          <span class="connection-state" data-connection-state role="status" aria-live="polite">Connecting</span>
          <span class="shell__header-spacer"></span>
          <button type="button" class="icon-btn" data-toggle="theme" aria-label="Toggle color theme"></button>
          <button type="button" class="icon-btn shell__drawer-toggle" data-toggle="agent" aria-label="Toggle agent panel">&#128172;</button>
        </header>
        <div class="shell-error" role="alert" hidden>
          <span>Something unexpected went wrong in this view. Your saved data is unchanged.</span>
          <button type="button" data-error-reload>Reload</button>
          <button type="button" data-error-dismiss>Dismiss</button>
        </div>
        <nav class="shell__nav" aria-label="Primary"><u2-nav></u2-nav></nav>
        <main class="shell__main"><div class="workspace" id="workspace" tabindex="-1" role="region" aria-label="Workspace"></div></main>
        <aside class="shell__agent" aria-label="Agent"><u2-agent></u2-agent></aside>
        <div class="shell__scrim"></div>
        <u2-device-panel></u2-device-panel>
      </div>
    `;

    this._workspace = this.querySelector('#workspace');
    this._themeBtn = this.querySelector('[data-toggle="theme"]');
    this._updateThemeIcon(document.documentElement.dataset.theme || effectiveTheme());

    this._themeBtn.addEventListener('click', () => this._toggleTheme());
    this._onUnexpectedError = () => {
      const notice = this.querySelector('.shell-error');
      if (notice) notice.hidden = false;
    };
    window.addEventListener('error', this._onUnexpectedError);
    window.addEventListener('unhandledrejection', this._onUnexpectedError);
    this.querySelector('[data-error-reload]').addEventListener('click', () => window.location.reload());
    this.querySelector('[data-error-dismiss]').addEventListener('click', () => {
      this.querySelector('.shell-error').hidden = true;
      this._workspace.focus();
    });
    this.querySelector('.skip-link').addEventListener('click', (event) => {
      event.preventDefault();
      this._workspace.focus();
    });
    this.querySelector('[data-toggle="nav"]').addEventListener('click', () => this._toggleDrawer('nav'));
    this.querySelector('[data-toggle="agent"]').addEventListener('click', () => this._toggleDrawer('agent'));
    this.querySelector('.shell__scrim').addEventListener('click', () => this._closeDrawers());

    // One SSE connection for the life of the app, independent of routing.
    this._onConnectionState = (event) => this._handleConnectionState(event.detail?.state);
    window.addEventListener('u2-connection-state', this._onConnectionState);
    this._events = new EventsService();

    // Phase 4 (docs/devices.md): this tab registers itself as a device
    // over the realtime bus so the agent can present/notify/prompt it
    // through the same capability model as any other endpoint. One
    // connection for the life of the app, same lifetime as the SSE feed
    // above.
    this._deviceClient = new DeviceClientService();
    this.querySelector('u2-device-panel').client = this._deviceClient;

    this._onHashChange = () => {
      this._closeDrawers();
      this._route();
      this._workspace.focus({ preventScroll: true });
    };
    window.addEventListener('hashchange', this._onHashChange);
    this._route();
  }

  disconnectedCallback() {
    this._routeGeneration = (this._routeGeneration || 0) + 1;
    window.removeEventListener('error', this._onUnexpectedError);
    window.removeEventListener('unhandledrejection', this._onUnexpectedError);
    window.removeEventListener('u2-connection-state', this._onConnectionState);
    window.removeEventListener('hashchange', this._onHashChange);
    this._events?.close();
    this._deviceClient?.close?.();
  }

  _handleConnectionState(state) {
    if (state === 'session-expired') {
      this._events?.close();
      this._deviceClient?.close?.();
      window.removeEventListener('u2-connection-state', this._onConnectionState);
      window.removeEventListener('hashchange', this._onHashChange);
      window.removeEventListener('error', this._onUnexpectedError);
      window.removeEventListener('unhandledrejection', this._onUnexpectedError);
      this._built = false;
      this._renderAuth(false);
      const subtitle = this.querySelector('.workspace__subtitle');
      if (subtitle) subtitle.textContent = 'Your session expired. Log in again to reconnect.';
      return;
    }

    const indicator = this.querySelector('[data-connection-state]');
    if (!indicator) return;
    const connected = state === 'connected';
    indicator.textContent = connected ? 'Live' : state === 'reconnecting' ? 'Reconnecting' : 'Connecting';
    indicator.dataset.state = connected ? 'connected' : 'disconnected';
  }

  _renderAuth(setupRequired) {
    this.innerHTML = `<main class="workspace" style="max-width:32rem;margin:10vh auto">
      <div class="workspace__header"><div class="workspace__title">${setupRequired ? 'Set up U2OS' : 'Unlock U2OS'}</div>
      <div class="workspace__subtitle">${setupRequired ? 'Create the single-owner passphrase. Passkeys can be added in a later release.' : 'Enter your owner passphrase.'}</div></div>
      <form class="dashboard-card"><label>Passphrase <input name="passphrase" type="password" minlength="12" required autocomplete="${setupRequired ? 'new-password' : 'current-password'}"></label>
      <button type="submit">${setupRequired ? 'Create owner' : 'Log in'}</button><div class="load-error" hidden></div></form></main>`;
    const form = this.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); const error = form.querySelector('.load-error'); error.hidden = true;
      try { if (setupRequired) await api.setupOwner(form.passphrase.value); else await api.login(form.passphrase.value); this._built = false; this.connectedCallback(); }
      catch { error.textContent = 'Unable to authenticate.'; error.hidden = false; }
    });
  }

  // Full-page takeover for a brand-new owner (see connectedCallback()).
  // Finishing marks onboarding complete server-side, then this follows the
  // exact same "start over" idiom _renderAuth()'s submit handler uses to
  // (re-)run connectedCallback() from scratch, which now finds onboarding
  // complete and proceeds to the normal shell.
  _renderOnboarding() {
    this.innerHTML = `<main class="workspace" style="max-width:48rem;margin:4vh auto"><u2-onboarding></u2-onboarding></main>`;
    this.querySelector('u2-onboarding').addEventListener('u2-onboarding-complete', () => {
      this._built = false;
      this.connectedCallback();
    }, { once: true });
  }

  _toggleTheme() {
    const current = document.documentElement.dataset.theme || effectiveTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setStoredTheme(next);
    this._updateThemeIcon(next);
  }

  _updateThemeIcon(theme) {
    this._themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
  }

  _toggleDrawer(which) {
    const attr = which === 'nav' ? 'navOpen' : 'agentOpen';
    this.dataset[attr] = this.dataset[attr] === 'true' ? 'false' : 'true';
  }

  _closeDrawers() {
    this.dataset.navOpen = 'false';
    this.dataset.agentOpen = 'false';
  }

  // ---- routing ----

  _route() {
    this._routeGeneration = (this._routeGeneration || 0) + 1;
    const hash = window.location.hash || '#/home';
    const pathOnly = hash.replace(/^#\/?/, '').split('?')[0];
    const parts = pathOnly.split('/').filter(Boolean);
    const [root, sub] = parts;

    switch (root) {
      case undefined:
      case 'home':
      case 'briefing':
        this._renderDashboard();
        break;
      case 'dashboards':
        this._renderDashboards();
        break;
      case 'activity':
        this._renderActivity();
        break;
      case 'operations':
        this._renderOperations();
        break;
      case 'goals':
        this._renderGoals();
        break;
      case 'routines':
        this._setWorkspace('', document.createElement('u2-routines'));
        break;
      case 'applications':
        this._setWorkspace('', document.createElement('u2-applications'));
        break;
      case 'vault':
        this._setWorkspace('', document.createElement('u2-vault'));
        break;
      case 'automation':
        this._renderTriggers();
        break;
      case 'packages':
        this._setWorkspace('', document.createElement('u2-packages'));
        break;
      case 'addons': {
        const page = document.createElement('u2-addons');
        if (sub) page.focusId = sub;
        this._setWorkspace('', page);
        break;
      }
      case 'diagnostics':
        this._renderDiagnostics();
        break;
      case 'memory':
        if (sub) this._renderEntityDetail(sub);
        else this._renderMemory();
        break;
      case 'projects':
        if (sub) this._renderEntityDetail(sub);
        else this._renderRecordList(PROJECTS);
        break;
      case 'people':
        if (sub) this._renderEntityDetail(sub);
        else this._renderRecordList(PEOPLE);
        break;
      case 'mail':
        this._renderMail();
        break;
      case 'calendar':
        this._renderCalendar();
        break;
      case 'tasks':
        this._renderTasks();
        break;
      case 'connectors':
        this._renderConnectors();
        break;
      case 'model':
        this._setWorkspace('', document.createElement('u2-model'));
        break;
      case 'onboarding':
        this._renderOnboardingRoute();
        break;
      case 'voice':
        this._renderVoice();
        break;
      case 'devices':
        this._renderDevices();
        break;
      default:
        this._renderNotFound(hash);
    }
  }

  _setWorkspace(titleHtml, bodyNode) {
    this._workspace.textContent = '';
    if (titleHtml) this._workspace.insertAdjacentHTML('beforeend', titleHtml);
    if (bodyNode) this._workspace.appendChild(bodyNode);
  }

  _header(title, subtitle) {
    return `
      <div class="workspace__header">
        <div class="workspace__title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="workspace__subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
    `;
  }

  _loading(message) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = message;
    return div;
  }

  _error(err) {
    const div = document.createElement('div');
    div.className = 'load-error';
    div.textContent = `Couldn't load this view: ${err.message}`;
    return div;
  }

  // ---- views ----

  async _renderDashboard() {
    const generation = this._routeGeneration;
    this._setWorkspace('', this._loading('Loading briefing...'));
    try {
      const schema = await api.getDashboard();
      if (!this.isConnected || generation !== this._routeGeneration) return;
      const dashboardEl = document.createElement('u2-dashboard');
      dashboardEl.refreshLoader = () => api.getDashboard();
      dashboardEl.schema = schema;

      const wrap = document.createElement('div');
      const start = document.createElement('section');
      start.className = 'workflow-start';
      start.setAttribute('aria-labelledby', 'daily-review-title');
      start.innerHTML = `
        <div>
          <div class="workflow-start__title" id="daily-review-title">Ready for a closer look?</div>
          <div class="workflow-start__description">U2OS can review today, handle routine work, and ask before anything consequential.</div>
        </div>
        <button type="button" class="btn btn-primary" data-start-daily-review>Review my day</button>
      `;
      const button = start.querySelector('[data-start-daily-review]');
      button.addEventListener('click', async () => {
        const agent = this.querySelector('u2-agent');
        this.dataset.agentOpen = 'true';
        button.disabled = true;
        button.textContent = 'Reviewing…';
        const request = agent?.submitPrompt(DAILY_REVIEW_PROMPT);
        if (request === false || request == null) {
          button.disabled = false;
          button.textContent = 'Review my day';
          return;
        }
        await request;
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = 'Review again';
        }
      });
      wrap.append(start, dashboardEl);
      this._setWorkspace('', wrap);
    } catch (err) {
      if (!this.isConnected || generation !== this._routeGeneration) return;
      this._setWorkspace(this._header('Briefing'), this._error(err));
    }
  }

  // Context picker for dynamically-generated dashboards (PROMPT.md section
  // 10 / docs/dashboards.md's Phase 2 contexts). 'Morning' generates
  // immediately; 'Before a meeting' and 'Project' first populate a <select>
  // from real memory entities, then POST /api/dashboard/generate with the
  // chosen id. The result renders through the existing generic
  // <u2-dashboard>, same as the static morning route.
  async _renderDashboards() {
    const wrap = document.createElement('div');

    const toggle = document.createElement('div');
    toggle.className = 'folder-toggle';
    wrap.appendChild(toggle);

    const select = document.createElement('select');
    select.className = 'connector-select';
    select.style.display = 'block';
    select.style.marginBottom = 'var(--space-4)';
    select.hidden = true;
    wrap.appendChild(select);

    let body = this._loading('Loading briefing...');
    wrap.appendChild(body);

    this._setWorkspace(this._header('Dashboards'), wrap);

    const setBody = (node) => {
      body.replaceWith(node);
      body = node;
    };

    const generateFor = async (contextDef, entityId) => {
      setBody(this._loading('Loading briefing...'));
      try {
        const params = contextDef.paramKey && entityId ? { [contextDef.paramKey]: entityId } : {};
        const schema = await api.generateDashboard(contextDef.id, params);
        const dashboardEl = document.createElement('u2-dashboard');
        dashboardEl.refreshLoader = () => api.generateDashboard(contextDef.id, params);
        dashboardEl.schema = schema;
        setBody(dashboardEl);
      } catch (err) {
        setBody(this._error(err));
      }
    };

    let activeContextId = DASHBOARD_CONTEXTS[0].id;

    const selectContext = async (contextDef) => {
      activeContextId = contextDef.id;
      toggle.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.context === contextDef.id);
      });

      if (!contextDef.paramKey) {
        select.hidden = true;
        select.innerHTML = '';
        await generateFor(contextDef, null);
        return;
      }

      select.hidden = false;
      setBody(this._loading('Loading...'));
      try {
        if (contextDef.eventPicker) {
          const { events } = await api.getCalendarEvents('upcoming');
          select.innerHTML = events.map((event) => {
            const attendees = (event.attendees || []).map((attendee) => typeof attendee === 'string' ? attendee : attendee?.name).filter(Boolean);
            const label = attendees.length ? `${event.title} — ${attendees.join(', ')}` : event.title;
            return `<option value="${escapeHtml(event.id)}">${escapeHtml(label)}</option>`;
          }).join('');
          if (!events.length) {
            setBody(this._error(new Error('No upcoming calendar events found.')));
            return;
          }
          await generateFor(contextDef, select.value);
          return;
        }

        const { entities } = await api.getMemoryEntities({ type: contextDef.entityType });
        select.innerHTML = entities
          .map((entity) => `<option value="${escapeHtml(entity.id)}">${escapeHtml(entity.name)}</option>`)
          .join('');
        if (!entities.length) {
          setBody(this._error(new Error(`No ${contextDef.entityType.toLowerCase()} records found yet.`)));
          return;
        }
        await generateFor(contextDef, select.value);
      } catch (err) {
        setBody(this._error(err));
      }
    };

    select.addEventListener('change', () => {
      const contextDef = DASHBOARD_CONTEXTS.find((c) => c.id === activeContextId);
      if (contextDef) generateFor(contextDef, select.value);
    });

    for (const contextDef of DASHBOARD_CONTEXTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = contextDef.label;
      btn.dataset.context = contextDef.id;
      btn.addEventListener('click', () => selectContext(contextDef));
      toggle.appendChild(btn);
    }

    await selectContext(DASHBOARD_CONTEXTS[0]);
  }

  _renderActivity() {
    // u2-timeline self-fetches GET /api/events and live-subscribes to the
    // SSE `u2-event` bus -- nothing for u2-app to await or wrap, same
    // "self-fetching custom element" pattern as _renderConnectors(). The
    // small dashboard-card usage keeps the default limit of 20; this
    // full-page view asks for more.
    const el = document.createElement('u2-timeline');
    el.limit = 50;
    this._setWorkspace(this._header('Activity', 'Everything the agent has done, in order'), el);
  }

  async _renderMail() {
    const folder = new URLSearchParams(window.location.hash.split('?')[1] || '').get('folder') || 'inbox';
    const wrap = document.createElement('div');

    const toggle = document.createElement('div');
    toggle.className = 'folder-toggle';
    for (const f of ['inbox', 'sent']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = f === 'inbox' ? 'Inbox' : 'Sent';
      btn.className = f === folder ? 'is-active' : '';
      btn.addEventListener('click', () => {
        window.location.hash = `#/mail?folder=${f}`;
      });
      toggle.appendChild(btn);
    }
    wrap.appendChild(toggle);

    const body = this._loading('Loading email...');
    wrap.appendChild(body);
    this._setWorkspace(this._header('Mail'), wrap);

    try {
      const { emails, cache } = await api.getEmails(folder);
      const el = document.createElement('u2-email-summary');
      el.setAttribute('selectable', '');
      el.emails = emails;
      el.addEventListener('u2-email-select', (event) => this._openEmail(event.detail.email, event.detail.opener));
      body.replaceWith(cacheNote(cache), el);
    } catch (err) {
      body.replaceWith(this._error(err));
    }
  }

  // People and projects: the list opens first, "+" creates, a row edits.
  async _renderRecordList(kind) {
    const generation = this._routeGeneration;
    this._setWorkspace('', this._loading(`Loading ${kind.heading.toLowerCase()}...`));
    try {
      const { records } = await api.getVaultRecords(kind.type);
      if (!this._isCurrentRoute(generation)) return;
      const header = document.createElement('u2-section');
      header.heading = kind.heading;
      header.addLabel = kind.addLabel;
      const list = document.createElement('div');
      list.className = 'record-list';
      let query = '';
      const draw = () => {
        const shown = records.filter((record) => (kind.searchable ? matchesQuery(record, query) : true));
        list.textContent = '';
        if (!shown.length) {
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = records.length ? 'No one matches that search.' : kind.empty;
          list.append(empty);
          return;
        }
        for (const record of shown) list.append(this._recordRow(kind, record));
      };
      const wrap = document.createElement('div');
      wrap.append(header);
      if (kind.searchable) {
        const label = document.createElement('label');
        label.className = 'record-search';
        const text = document.createElement('span');
        text.className = 'sr-only';
        text.textContent = `Search ${kind.heading.toLowerCase()}`;
        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = `Search ${kind.heading.toLowerCase()}`;
        input.addEventListener('input', () => { query = input.value; draw(); });
        label.append(text, input);
        wrap.append(label);
      }
      wrap.append(list);
      this._reloadRecords = async () => {
        const fresh = await api.getVaultRecords(kind.type);
        if (!this._isCurrentRoute(generation)) return;
        records.splice(0, records.length, ...fresh.records);
        draw();
      };
      header.addEventListener('u2-section-add', (event) => this._openRecord(kind, null, event.detail.opener));
      list.addEventListener('click', (event) => {
        const row = event.target.closest('[data-record-id]');
        const record = row && records.find((item) => item.id === row.dataset.recordId);
        if (record) this._openRecord(kind, record, row);
      });
      draw();
      this._setWorkspace('', wrap);
    } catch (err) {
      if (!this._isCurrentRoute(generation)) return;
      this._setWorkspace(this._header(kind.heading), this._error(err));
    }
  }

  _recordRow(kind, record) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'record-row';
    row.dataset.recordId = record.id;
    const name = document.createElement('span');
    name.className = 'entity-row__name';
    name.textContent = record.name;
    row.append(name);
    const meta = document.createElement('span');
    meta.className = 'record-row__meta';
    const fields = record.fields || {};
    const chip = (text, className = 'entity-row__type') => {
      const el = document.createElement('span');
      el.className = className;
      el.textContent = text;
      return el;
    };
    if (kind.type === 'Project') {
      meta.append(chip(fields.status || 'Project'));
      if (fields.deadline) meta.append(chip(`Due ${fields.deadline}`, 'record-row__detail'));
    } else {
      if (fields.relationship) meta.append(chip(fields.relationship));
      if (fields.organization) meta.append(chip(fields.organization, 'record-row__detail'));
      const status = contactStatus(fields);
      const label = contactLabel(status);
      if (label) {
        const badge = chip(label, `record-row__badge${status.state === 'due' ? ' is-due' : ''}`);
        meta.append(badge);
      }
    }
    if (!record.vaultBacked) meta.append(chip('Database only', 'record-row__detail'));
    row.append(meta);
    return row;
  }

  // "+" opens the dialog empty, a row opens it with what the file says. The
  // file is the authority, so the form is filled from it, not from the database.
  async _openRecord(kind, record, opener) {
    const modal = getModal();
    const reload = () => this._reloadRecords?.();
    const payload = (values) => {
      const { name, notes, ...rest } = values;
      const fields = {};
      for (const [key, value] of Object.entries(rest)) fields[key] = value ?? '';
      return { name, fields, notes: notes ?? '' };
    };
    if (!record) {
      modal.open({
        opener,
        title: kind.addLabel,
        fields: kind.formFields,
        submitLabel: `Create ${kind.singular.toLowerCase()}`,
        notice: 'This is saved as a file in your vault.',
        onSubmit: async (values) => {
          await api.createVaultRecord({ type: kind.type, ...payload(values) });
          await reload();
        },
      });
      return;
    }
    const detailsAction = { label: 'Open details', onClick: async () => { window.location.hash = `${kind.detailBase}/${encodeURIComponent(record.id)}`; } };
    try {
      const current = await api.getVaultRecord(record.id);
      if (!current.vaultBacked) {
        modal.open({
          opener,
          title: kind.singular,
          cancelLabel: 'Close',
          fields: kind.formFields.map((field) => ({ ...field, readOnly: true })),
          values: { name: current.name },
          notice: 'This record is stored only in the database, not in your vault, so it cannot be edited here. Export your memory to the vault from the Vault view, then edit it.',
          actions: [detailsAction],
        });
        return;
      }
      modal.open({
        opener,
        title: kind.singular,
        fields: kind.formFields,
        values: { name: current.name, ...current.fields, notes: current.notes },
        submitLabel: 'Save',
        notice: `Saved to ${current.path || 'your vault'}.`,
        onSubmit: async (values) => {
          await api.updateVaultRecord(record.id, payload(values));
          await reload();
        },
        actions: [detailsAction],
      });
    } catch (err) {
      modal.open({ opener, title: kind.singular, cancelLabel: 'Close', fields: [], notice: `Couldn't open this record: ${err.message}` });
    }
  }

  // A message opens in the shared dialog. Replying is a link to the owner's
  // own mail client with the original quoted; U2OS sends nothing (#436).
  async _openEmail(summary, opener) {
    const modal = getModal();
    const fields = [
      { name: 'from', label: 'From', type: 'text', readOnly: true },
      { name: 'to', label: 'To', type: 'text', readOnly: true },
      { name: 'date', label: 'Date', type: 'text', readOnly: true },
      { name: 'subject', label: 'Subject', type: 'text', readOnly: true },
      { name: 'body', label: 'Message', type: 'textarea', rows: 12, readOnly: true },
    ];
    const show = (email, notice = '') => {
      const reply = buildReplyLink(email);
      modal.open({
        opener,
        title: 'Message',
        cancelLabel: 'Close',
        fields,
        notice: notice || (reply ? '' : 'There is no verified sender address to reply to.'),
        values: {
          from: email.from_addr,
          to: (email.to_addr || []).join(', '),
          date: email.received_at ? new Date(email.received_at).toLocaleString() : '',
          subject: email.subject || '(no subject)',
          body: email.body || '',
        },
        actions: reply ? [{ label: reply.kind === 'gmail' ? 'Reply in Gmail' : 'Reply', href: reply.url, primary: true }] : [],
      });
    };
    try {
      show((await api.getEmail(summary.id)).email);
    } catch (err) {
      modal.open({ opener, title: 'Message', cancelLabel: 'Close', fields: [], notice: `Couldn't open this message: ${err.message}` });
    }
  }

  async _renderCalendar() {
    const header = document.createElement('u2-section');
    header.heading = 'Calendar';
    header.addLabel = 'New event';
    const note = document.createElement('div');
    const cal = document.createElement('u2-calendar');
    cal.loader = (params) => api.getCalendarEvents(params);
    cal.addEventListener('u2-calendar-loaded', (event) => note.replaceChildren(cacheNote(event.detail.cache)));
    cal.addEventListener('u2-calendar-select', (event) => this._openEvent(event.detail.event, event.detail.opener));
    header.addEventListener('u2-section-add', (event) => this._openNewEvent(cal, event.detail.opener));
    const wrap = document.createElement('div');
    wrap.append(header, note, cal);
    this._setWorkspace('', wrap);
    // Like every root view, settle only once the first load has been handled.
    // A response that arrives after the owner has moved on only touches the
    // detached calendar, never the newly selected view.
    await cal.loaded;
  }

  // "+" opens the modal empty; an event in any view opens it populated.
  _openNewEvent(cal, opener) {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    getModal().open({
      opener,
      title: 'New event',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true, maxLength: 200 },
        { name: 'startAt', label: 'Starts', type: 'datetime', required: true },
        { name: 'endAt', label: 'Ends', type: 'datetime', required: true },
        { name: 'location', label: 'Location', type: 'text', maxLength: 200 },
      ],
      values: { startAt: start.toISOString(), endAt: end.toISOString() },
      notice: 'Creating an event is an action on your behalf, so your policy may ask you to approve it first.',
      submitLabel: 'Create event',
      validate: (values) => (Date.parse(values.endAt) <= Date.parse(values.startAt) ? { endAt: 'End must be after the start.' } : null),
      onSubmit: async (values) => {
        requireExecuted(await api.createCalendarEvent(values), 'create the event');
        await cal.reload();
      },
    });
  }

  _openEvent(event, opener) {
    const attendees = (event.attendees || []).map((a) => a.name || a.email).filter(Boolean).join(', ');
    getModal().open({
      opener,
      title: 'Event',
      cancelLabel: 'Close',
      fields: [
        { name: 'title', label: 'Title', type: 'text', readOnly: true },
        { name: 'startAt', label: 'Starts', type: 'datetime', readOnly: true },
        { name: 'endAt', label: 'Ends', type: 'datetime', readOnly: true },
        { name: 'location', label: 'Location', type: 'text', readOnly: true },
        { name: 'attendees', label: 'Attendees', type: 'text', readOnly: true },
      ],
      values: { title: event.title, startAt: event.start_at, endAt: event.end_at, location: event.location, attendees },
    });
  }

  async _renderTasks() {
    const generation = this._routeGeneration;
    this._setWorkspace('', this._loading('Loading tasks...'));
    try {
      const { tasks } = await api.getTasks();
      if (!this._isCurrentRoute(generation)) return;
      const header = document.createElement('u2-section');
      header.heading = 'Tasks';
      header.addLabel = 'New task';
      header.addEventListener('u2-section-add', (event) => this._openTask(null, event.detail.opener));
      const list = document.createElement('u2-task-list');
      list.setAttribute('selectable', '');
      list.tasks = tasks;
      list.addEventListener('u2-task-select', (event) => this._openTask(event.detail.task, event.detail.opener));
      const wrap = document.createElement('div');
      wrap.append(header, list);
      this._setWorkspace('', wrap);
      // Reloads replace only the list, so the "+" button that opened the
      // modal stays in the page and can take focus back when it closes.
      this._reloadTasks = async () => {
        const fresh = await api.getTasks();
        if (this._isCurrentRoute(generation)) list.tasks = fresh.tasks;
      };
    } catch (err) {
      if (!this._isCurrentRoute(generation)) return;
      this._setWorkspace(this._header('Tasks'), this._error(err));
    }
  }

  // "+" opens the modal empty; a list row opens it populated (#434).
  _openTask(task, opener = null) {
    const modal = getModal();
    const fields = [
      { name: 'title', label: 'Title', type: 'text', required: true, maxLength: 200 },
      { name: 'dueAt', label: 'Due date', type: 'date' },
    ];
    if (!task) {
      modal.open({
        opener,
        title: 'New task',
        fields,
        submitLabel: 'Create task',
        onSubmit: async (values) => {
          requireExecuted(await api.createTask({ title: values.title, dueAt: values.dueAt }), 'create the task');
          await this._reloadTasks();
        },
      });
      return;
    }
    const completed = task.status === 'completed';
    const reload = () => this._reloadTasks();
    modal.open({
      opener,
      title: 'Task',
      fields: fields.map((field) => ({ ...field, readOnly: false })),
      values: { title: task.title, dueAt: task.due_at },
      notice: completed ? 'This task is completed.' : '',
      submitLabel: 'Save',
      onSubmit: async (values) => {
        await api.updateTask(task.id, { title: values.title, dueAt: values.dueAt });
        await reload();
      },
      actions: [completed
        ? { label: 'Reopen', onClick: async () => { await api.updateTask(task.id, { status: 'open' }); await reload(); } }
        : { label: 'Mark complete', onClick: async () => { requireExecuted(await api.completeTask(task.id), 'complete the task'); await reload(); } }],
    });
  }

  _renderConnectors() {
    // u2-connectors owns its own header, data-fetching, and state -- same
    // "self-fetching custom element" pattern as u2-timeline's standalone
    // mode. Nothing for u2-app to await or wrap here.
    this._setWorkspace('', document.createElement('u2-connectors'));
  }

  _renderVoice() {
    // u2-voice (Phase 5 enrollment) is the same self-fetching pattern as
    // u2-connectors -- nothing for u2-app to await or wrap here either.
    this._setWorkspace('', document.createElement('u2-voice'));
  }

  _renderDevices() {
    // u2-devices (docs/devices.md Phase 6) -- same self-fetching pattern.
    this._setWorkspace('', document.createElement('u2-devices'));
  }

  _renderTriggers() {
    this._setWorkspace('', document.createElement('u2-triggers'));
  }

  _renderOperations() {
    this._setWorkspace('', document.createElement('u2-operations'));
  }

  _renderGoals() {
    this._setWorkspace('', document.createElement('u2-goals'));
  }

  _renderDiagnostics() {
    this._setWorkspace('', document.createElement('u2-diagnostics'));
  }

  // Reopening the wizard from the nav/Settings (#413): unlike
  // _renderOnboarding()'s full-page first-run takeover, this never re-gates
  // an already onboarded owner -- finishing just marks onboarding complete
  // again (idempotent) and returns to the dashboard.
  _renderOnboardingRoute() {
    const el = document.createElement('u2-onboarding');
    el.addEventListener('u2-onboarding-complete', () => { window.location.hash = '#/home'; }, { once: true });
    this._setWorkspace('', el);
  }

  _isCurrentRoute(generation) {
    return this.isConnected && generation === this._routeGeneration;
  }

  async _renderMemory(generation = this._routeGeneration) {
    if (!this._isCurrentRoute(generation)) return;
    this._setWorkspace(this._header('Memory'), this._loading('Loading...'));
    try {
      const [{ entities }, { candidates }] = await Promise.all([api.getMemoryEntities(), api.getMemoryCandidates()]);
      if (!this._isCurrentRoute(generation)) return;
      const wrap = document.createElement('div');
      if (candidates.length) {
        const heading = document.createElement('div'); heading.className = 'entity-detail__section-title'; heading.textContent = 'Pending memories'; wrap.appendChild(heading);
        for (const candidate of candidates) {
          const card = document.createElement('form'); card.className = 'dashboard-card';
          card.innerHTML = `<p>${escapeHtml(candidate.content)}</p><label>Attach to <select name="entityId" required>${entities.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name || e.id)}</option>`).join('')}</select></label><label>Fact key <input name="key" required placeholder="preference"></label><button type="submit">Accept</button> <button type="button" data-reject>Reject</button>`;
          card.addEventListener('submit', async (event) => { event.preventDefault(); if (!this._isCurrentRoute(generation)) return; await api.acceptMemoryCandidate(candidate.id, { entityId: card.elements.entityId.value, key: card.elements.key.value }); this._renderMemory(generation); });
          card.querySelector('[data-reject]').addEventListener('click', async () => { if (!this._isCurrentRoute(generation)) return; await api.rejectMemoryCandidate(candidate.id); this._renderMemory(generation); });
          wrap.appendChild(card);
        }
      }
      const list = document.createElement('div'); list.className = 'entity-list';
      for (const entity of entities) {
        const row = document.createElement('div'); row.className = 'entity-row';
        row.innerHTML = `<span class="entity-row__name">${escapeHtml(entity.name)}</span><span class="entity-row__type">${escapeHtml(entity.type)}</span>`;
        row.addEventListener('click', () => { window.location.hash = `#/memory/${encodeURIComponent(entity.id)}`; }); list.appendChild(row);
      }
      if (!entities.length) list.innerHTML = '<div class="empty-state">Nothing here yet.</div>';
      wrap.appendChild(list); this._setWorkspace(this._header('Memory'), wrap);
    } catch (err) { if (this._isCurrentRoute(generation)) this._setWorkspace(this._header('Memory'), this._error(err)); }
  }

  async _renderEntityList({ title, linkBase, type }) {
    const generation = this._routeGeneration;
    this._setWorkspace(this._header(title), this._loading('Loading...'));
    try {
      const { entities } = await api.getMemoryEntities(type ? { type } : {});
      if (!this._isCurrentRoute(generation)) return;
      const list = document.createElement('div');
      list.className = 'entity-list';

      if (!entities.length) {
        list.innerHTML = `<div class="empty-state">Nothing here yet.</div>`;
      } else {
        for (const entity of entities) {
          const row = document.createElement('div');
          row.className = 'entity-row';
          row.innerHTML = `
            <span class="entity-row__name">${escapeHtml(entity.name)}</span>
            <span class="entity-row__type">${escapeHtml(entity.type)}</span>
          `;
          row.addEventListener('click', () => {
            window.location.hash = `${linkBase}/${encodeURIComponent(entity.id)}`;
          });
          list.appendChild(row);
        }
      }

      this._setWorkspace(this._header(title), list);
    } catch (err) {
      if (!this._isCurrentRoute(generation)) return;
      this._setWorkspace(this._header(title), this._error(err));
    }
  }

  async _renderEntityDetail(id, generation = this._routeGeneration) {
    if (!this._isCurrentRoute(generation)) return;
    this._memoryDrafts ||= new Map();
    for (const row of this._workspace?.querySelectorAll('.fact-row[data-fact-id]') || []) {
      const input = row.querySelector('[data-correct] input[name="value"]');
      if (input && input.value !== input.defaultValue) this._memoryDrafts.set(row.dataset.factId, input.value);
    }
    this._setWorkspace('', this._loading('Loading...'));
    try {
      const { entity, facts, relationships } = await api.getMemoryEntity(id);
      if (!this._isCurrentRoute(generation)) return;
      const wrap = document.createElement('div');

      const back = document.createElement('a');
      back.className = 'entity-detail__back';
      back.href = '#';
      back.textContent = '← Back';
      back.addEventListener('click', (e) => {
        e.preventDefault();
        window.history.back();
      });
      wrap.appendChild(back);

      const attrEntries = Object.entries(entity.attributes || {});
      const factMarkup = facts.length
        ? facts.map((f) => {
          const provenance = Object.keys(f.provenance || {}).length ? JSON.stringify(f.provenance) : 'No additional provenance';
          const current = f.status === 'current';
          return `<article class="fact-row fact-row--${escapeHtml(f.status)}" data-fact-id="${escapeHtml(f.id)}">
            <div class="fact-row__heading"><strong>${escapeHtml(humanizeKey(f.key))}:</strong> <span class="fact-row__value">${escapeHtml(JSON.stringify(f.value))}</span><span class="fact-row__status">${escapeHtml(f.status)}</span></div>
            <dl class="fact-row__metadata">
              <div><dt>Source</dt><dd>${escapeHtml(f.source)}</dd></div>
              <div><dt>Authority</dt><dd><span class="fact-origin" data-origin="${escapeHtml(f.origin)}">${escapeHtml(humanizeKey(f.origin))}</span></dd></div>
              <div><dt>Confidence</dt><dd>${Math.round((f.confidence ?? 1) * 100)}%</dd></div>
              <div><dt>Classification</dt><dd>${escapeHtml(f.classification)}</dd></div>
              <div><dt>Last confirmed</dt><dd>${f.last_confirmed_at ? escapeHtml(new Date(f.last_confirmed_at).toLocaleString()) : 'Never'}</dd></div>
            </dl>
            <details><summary>Provenance</summary><code>${escapeHtml(provenance)}</code></details>
            <div class="fact-row__controls">
              ${current ? '<button type="button" data-confirm>Confirm</button>' : ''}
              <form data-classification><label>Classification <select name="classification">${['public', 'personal', 'private', 'sensitive'].map((value) => `<option value="${value}"${f.classification === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label><button type="submit">Save</button></form>
              ${current ? `<form data-correct><label>Correct value <input name="value" value="${escapeHtml(typeof f.value === 'string' ? f.value : JSON.stringify(f.value))}" required></label><button type="submit">Correct</button></form>` : ''}
              <button type="button" class="fact-row__delete" data-delete>Delete</button>
            </div>
            <div class="fact-row__error" role="alert" aria-live="polite"></div>
          </article>`;
        }).join('')
        : '<div class="empty-state">No facts recorded yet.</div>';
      wrap.insertAdjacentHTML(
        'beforeend',
        `
        ${this._header(entity.name, entity.type)}
        <div class="fact-row__controls"><button type="button" class="btn-danger" data-delete-entity>Delete ${escapeHtml(entity.type)}</button></div>
        <div class="fact-row__error" data-entity-delete-error role="alert" aria-live="polite"></div>
        ${
          attrEntries.length
            ? `<dl class="u2-approval__args">${attrEntries
                .map(([k, v]) => `<dt>${escapeHtml(humanizeKey(k))}</dt><dd>${escapeHtml(String(v))}</dd>`)
                .join('')}</dl>`
            : ''
        }
        <div class="entity-detail__section-title">Facts</div>
        ${factMarkup}
        <div class="entity-detail__section-title">Relationships</div>
        ${
          relationships.length
            ? relationships
                .map((r) => {
                  const direction = r.from_entity_id === entity.id ? `${r.relation} → ${r.to_entity_id}` : `${r.from_entity_id} → ${r.relation}`;
                  return `<div class="rel-row" data-relationship-id="${escapeHtml(r.id)}"><span class="mono">${escapeHtml(direction)}</span>${r.inferred ? ' <span class="mono">(inferred)</span>' : ''} <button type="button" class="btn-danger" data-delete-relationship>Delete relationship</button></div>`;
                })
                .join('')
            : `<div class="empty-state">No relationships recorded yet.</div>`
        }
      `
      );
      const currentIds = new Set();
      for (const row of wrap.querySelectorAll('.fact-row--current[data-fact-id]')) {
        currentIds.add(row.dataset.factId);
        const draft = this._memoryDrafts.get(row.dataset.factId);
        if (draft !== undefined) row.querySelector('[data-correct] input[name="value"]').value = draft;
      }
      for (const draftId of this._memoryDrafts.keys()) if (!currentIds.has(draftId)) this._memoryDrafts.delete(draftId);

      wrap.querySelector('[data-delete-entity]').addEventListener('click', async () => {
        if (!this._isCurrentRoute(generation)) return;
        const error = wrap.querySelector('[data-entity-delete-error]'); error.textContent = '';
        try {
          const preview = await api.getMemoryEntityDeletionPreview(id);
          if (!this._isCurrentRoute(generation)) return;
          const { facts, relationships: relationCount, tasks, calendarEvents } = preview.counts;
          const message = `Delete ${entity.name}? This hides the entity but retains audit history and linked records. Impact: ${facts} facts, ${relationCount} relationships, ${tasks} tasks, ${calendarEvents} calendar events.`;
          if (!window.confirm(message)) return;
          await api.deleteMemoryEntity(id, preview.token);
          if (!this._isCurrentRoute(generation)) return;
          window.location.hash = '#/memory';
        } catch (err) { error.textContent = err.message; }
      });

      for (const row of wrap.querySelectorAll('[data-relationship-id]')) {
        row.querySelector('[data-delete-relationship]').addEventListener('click', async () => {
          if (!this._isCurrentRoute(generation)) return;
          if (!window.confirm('Delete this relationship? Its audit history will be retained.')) return;
          try { await api.deleteMemoryRelationship(row.dataset.relationshipId); await this._renderEntityDetail(id, generation); }
          catch (err) { wrap.querySelector('[data-entity-delete-error]').textContent = err.message; }
        });
      }

      for (const row of wrap.querySelectorAll('[data-fact-id]')) {
        const factId = row.dataset.factId;
        const run = async (operation) => {
          if (!this._isCurrentRoute(generation)) return;
          const error = row.querySelector('.fact-row__error'); error.textContent = '';
          try { await operation(); await this._renderEntityDetail(id, generation); } catch (err) { error.textContent = err.message; }
        };
        row.querySelector('[data-confirm]')?.addEventListener('click', () => run(() => api.confirmMemoryFact(factId)));
        row.querySelector('[data-classification]').addEventListener('submit', (event) => {
          event.preventDefault(); const classification = event.currentTarget.elements.namedItem('classification').value;
          run(() => api.updateMemoryFact(factId, { classification }));
        });
        row.querySelector('[data-correct]')?.addEventListener('submit', (event) => {
          event.preventDefault(); const value = event.currentTarget.querySelector('input[name="value"]').value;
          run(() => api.updateMemoryFact(factId, { value }));
        });
        row.querySelector('[data-delete]').addEventListener('click', () => {
          if (!this._isCurrentRoute(generation)) return;
          if (window.confirm('Delete this fact? Its audit history will be retained.')) run(() => api.deleteMemoryFact(factId));
        });
      }

      this._setWorkspace('', wrap);
    } catch (err) {
      if (!this._isCurrentRoute(generation)) return;
      this._setWorkspace(this._header('Memory'), this._error(err));
    }
  }

  _renderNotFound(hash) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = `Nothing here for ${hash}.`;
    this._setWorkspace(this._header('Not found'), div);
  }
}

function cacheNote(cache) {
  const note = document.createElement('p');
  note.className = 'connector-meta';
  if (cache?.source === 'demo-fixture') {
    note.textContent = 'Demo fixture data — not a connected personal service.';
  } else {
    const freshness = cache?.lastSyncAt ? `Selected account last synced ${new Date(cache.lastSyncAt).toLocaleString()}.` : 'Last sync unknown.';
    note.textContent = `Local cached records; may include other accounts. ${cache?.connected ? '' : 'No connected service is selected. '}${freshness}`;
  }
  return note;
}

customElements.define('u2-app', U2App);
