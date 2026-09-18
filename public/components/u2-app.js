import { escapeHtml, humanizeKey } from './util.js';
import * as api from '../services/api.js';
import { EventsService } from '../services/events.js';
import './u2-nav.js';
import './u2-agent.js';
import './u2-dashboard.js';
import './u2-schedule.js';
import './u2-task-list.js';
import './u2-email-summary.js';
import './u2-connectors.js';
import './u2-timeline.js';

// Dashboard contexts the #/dashboards picker offers, per PROMPT.md section
// 10's examples + docs/dashboards.md's Phase 2 contexts. 'before-meeting'
// and 'project' each need the user to pick which person/project via a
// <select> populated from /api/memory/entities.
const DASHBOARD_CONTEXTS = [
  { id: 'morning', label: 'Morning' },
  { id: 'before-meeting', label: 'Before a meeting', entityType: 'Person', paramKey: 'personId' },
  { id: 'project', label: 'Project', entityType: 'Project', paramKey: 'projectId' },
];

const THEME_KEY = 'u2-theme';

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
  connectedCallback() {
    if (this._built) return;
    this._built = true;

    this.innerHTML = `
      <div class="shell">
        <header class="shell__header">
          <button type="button" class="icon-btn shell__drawer-toggle" data-toggle="nav" aria-label="Toggle navigation">&#9776;</button>
          <span class="shell__brand">U2OS</span>
          <span class="shell__header-spacer"></span>
          <button type="button" class="icon-btn" data-toggle="theme" aria-label="Toggle color theme"></button>
          <button type="button" class="icon-btn shell__drawer-toggle" data-toggle="agent" aria-label="Toggle agent panel">&#128172;</button>
        </header>
        <nav class="shell__nav"><u2-nav></u2-nav></nav>
        <main class="shell__main"><div class="workspace" id="workspace"></div></main>
        <aside class="shell__agent"><u2-agent></u2-agent></aside>
        <div class="shell__scrim"></div>
      </div>
    `;

    this._workspace = this.querySelector('#workspace');
    this._themeBtn = this.querySelector('[data-toggle="theme"]');
    this._updateThemeIcon(document.documentElement.dataset.theme || effectiveTheme());

    this._themeBtn.addEventListener('click', () => this._toggleTheme());
    this.querySelector('[data-toggle="nav"]').addEventListener('click', () => this._toggleDrawer('nav'));
    this.querySelector('[data-toggle="agent"]').addEventListener('click', () => this._toggleDrawer('agent'));
    this.querySelector('.shell__scrim').addEventListener('click', () => this._closeDrawers());

    // One SSE connection for the life of the app, independent of routing.
    this._events = new EventsService();

    window.addEventListener('hashchange', () => {
      this._closeDrawers();
      this._route();
    });
    this._route();
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
      case 'memory':
        if (sub) this._renderEntityDetail(sub);
        else this._renderEntityList({ title: 'Memory', linkBase: '#/memory' });
        break;
      case 'projects':
        if (sub) this._renderEntityDetail(sub);
        else this._renderEntityList({ title: 'Projects', linkBase: '#/projects', type: 'Project' });
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
    this._setWorkspace('', this._loading('Loading briefing...'));
    try {
      const schema = await api.getDashboard();
      const dashboardEl = document.createElement('u2-dashboard');
      dashboardEl.schema = schema;
      this._setWorkspace('', dashboardEl);
    } catch (err) {
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

      if (!contextDef.entityType) {
        select.hidden = true;
        select.innerHTML = '';
        await generateFor(contextDef, null);
        return;
      }

      select.hidden = false;
      setBody(this._loading('Loading...'));
      try {
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
      const { emails } = await api.getEmails(folder);
      const el = document.createElement('u2-email-summary');
      el.emails = emails;
      body.replaceWith(el);
    } catch (err) {
      body.replaceWith(this._error(err));
    }
  }

  async _renderCalendar() {
    this._setWorkspace(this._header('Calendar', 'Upcoming events'), this._loading('Loading calendar...'));
    try {
      const { events } = await api.getCalendarEvents('upcoming');
      const el = document.createElement('u2-schedule');
      el.events = events;
      this._setWorkspace(this._header('Calendar', 'Upcoming events'), el);
    } catch (err) {
      this._setWorkspace(this._header('Calendar'), this._error(err));
    }
  }

  async _renderTasks() {
    this._setWorkspace(this._header('Tasks'), this._loading('Loading tasks...'));
    try {
      const { tasks } = await api.getTasks();
      const el = document.createElement('u2-task-list');
      el.tasks = tasks;
      this._setWorkspace(this._header('Tasks'), el);
    } catch (err) {
      this._setWorkspace(this._header('Tasks'), this._error(err));
    }
  }

  _renderConnectors() {
    // u2-connectors owns its own header, data-fetching, and state -- same
    // "self-fetching custom element" pattern as u2-timeline's standalone
    // mode. Nothing for u2-app to await or wrap here.
    this._setWorkspace('', document.createElement('u2-connectors'));
  }

  async _renderEntityList({ title, linkBase, type }) {
    this._setWorkspace(this._header(title), this._loading('Loading...'));
    try {
      const { entities } = await api.getMemoryEntities(type ? { type } : {});
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
      this._setWorkspace(this._header(title), this._error(err));
    }
  }

  async _renderEntityDetail(id) {
    this._setWorkspace('', this._loading('Loading...'));
    try {
      const { entity, facts, relationships } = await api.getMemoryEntity(id);
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
      wrap.insertAdjacentHTML(
        'beforeend',
        `
        ${this._header(entity.name, entity.type)}
        ${
          attrEntries.length
            ? `<dl class="u2-approval__args">${attrEntries
                .map(([k, v]) => `<dt>${escapeHtml(humanizeKey(k))}</dt><dd>${escapeHtml(String(v))}</dd>`)
                .join('')}</dl>`
            : ''
        }
        <div class="entity-detail__section-title">Facts</div>
        ${
          facts.length
            ? facts
                .map(
                  (f) => `
              <div class="fact-row">
                <strong>${escapeHtml(humanizeKey(f.key))}:</strong> ${escapeHtml(JSON.stringify(f.value))}
                <span class="mono"> -- ${escapeHtml(f.source)}${f.inferred ? ', inferred' : ''}, confidence ${Math.round((f.confidence ?? 1) * 100)}%</span>
              </div>`
                )
                .join('')
            : `<div class="empty-state">No facts recorded yet.</div>`
        }
        <div class="entity-detail__section-title">Relationships</div>
        ${
          relationships.length
            ? relationships
                .map((r) => {
                  const direction = r.from_entity_id === entity.id ? `${r.relation} → ${r.to_entity_id}` : `${r.from_entity_id} → ${r.relation}`;
                  return `<div class="rel-row"><span class="mono">${escapeHtml(direction)}</span>${r.inferred ? ' <span class="mono">(inferred)</span>' : ''}</div>`;
                })
                .join('')
            : `<div class="empty-state">No relationships recorded yet.</div>`
        }
      `
      );

      this._setWorkspace('', wrap);
    } catch (err) {
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

customElements.define('u2-app', U2App);
