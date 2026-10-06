import { getAddons } from '../services/api.js';

// Each route is [hash, label, icon]; icon is a name from public/styles/icons.css.
// Navigation groups (#435). One data structure so add-ons can contribute
// entries later (ADR 0010). `open` is the default state; the owner's own
// choice is remembered per browser, and the group holding the current route
// is always shown.
export const NAV_GROUPS = [
  { id: 'today', label: 'Today', open: true, routes: [
    ['#/home', 'Home', 'house'],
    ['#/briefing', 'Briefing', 'sun'],
    ['#/dashboards', 'Dashboards', 'chart-pie'],
  ] },
  { id: 'apps', label: 'Apps', open: true, routes: [
    ['#/mail', 'Mail', 'envelope'],
    ['#/calendar', 'Calendar', 'calendar-days'],
    ['#/tasks', 'Tasks', 'list-check'],
    ['#/projects', 'Projects', 'diagram-project'],
    ['#/people', 'People', 'user-group'],
  ] },
  { id: 'memory', label: 'Memory & automation', open: true, routes: [
    ['#/memory', 'Memory', 'brain'],
    ['#/routines', 'Routines', 'repeat'],
    ['#/goals', 'Goals', 'bullseye'],
    ['#/applications', 'Applications', 'briefcase'],
    ['#/automation', 'Automation', 'bolt'],
    ['#/activity', 'Activity', 'clock-rotate-left'],
  ] },
  { id: 'addons', label: 'Add-ons', open: false, routes: [
    ['#/addons', 'Add-ons', 'cubes'],
    ['#/packages', 'Packages', 'puzzle-piece'],
  ] },
  { id: 'settings', label: 'Settings', open: false, routes: [
    ['#/connectors', 'Connectors', 'plug'],
    ['#/model', 'Model', 'microchip'],
    ['#/devices', 'Devices', 'display'],
    ['#/voice', 'Voice', 'microphone'],
    ['#/vault', 'Vault', 'vault'],
    ['#/onboarding', 'Setup wizard', 'wand-magic-sparkles'],
  ] },
  { id: 'system', label: 'System', open: false, routes: [
    ['#/operations', 'Operations', 'gears'],
    ['#/diagnostics', 'Diagnostics', 'stethoscope'],
  ] },
];

// Icons an enabled add-on's navigation entry may use (the self-hosted subset in icons.css).
const KNOWN_ICONS = new Set(NAV_GROUPS.flatMap((group) => group.routes.map(([, , icon]) => icon)));
const EXACT_ROUTES = new Set(['#/addons']);

const STATE_KEY = 'u2-nav-groups';

function readState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore -- private mode / storage disabled */
  }
}

function routeMatches(current, route) {
  return current === route || current.startsWith(`${route}/`);
}

// Left navigation. Highlights the current hash route and stays in sync
// with browser back/forward via `hashchange`.
export class U2Nav extends HTMLElement {
  constructor() {
    super();
    this._onHashChange = this._onHashChange.bind(this);
    this._onAddonsChanged = () => this._loadAddonRoutes();
  }

  connectedCallback() {
    this._render();
    window.addEventListener('hashchange', this._onHashChange);
    window.addEventListener('u2-addons-changed', this._onAddonsChanged);
    this._loadAddonRoutes();
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this._onHashChange);
    window.removeEventListener('u2-addons-changed', this._onAddonsChanged);
  }

  _onHashChange() {
    this._updateActive();
  }

  _render() {
    this._state = readState();
    const current = this._current();
    for (const group of NAV_GROUPS) {
      const section = document.createElement('div');
      section.className = 'nav-group';
      section.dataset.group = group.id;

      const listId = `nav-group-${group.id}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'nav-group__toggle';
      toggle.setAttribute('aria-controls', listId);
      toggle.dataset.group = group.id;
      const groupLabel = document.createElement('span');
      groupLabel.textContent = group.label;
      const chevron = document.createElement('span');
      chevron.className = 'nav-group__chevron';
      chevron.setAttribute('aria-hidden', 'true');
      toggle.append(groupLabel, chevron);

      const list = document.createElement('ul');
      list.className = 'nav-list';
      list.id = listId;
      for (const [hash, text, icon] of group.routes) {
        const li = document.createElement('li');
        li.className = 'nav-list__item';
        const a = document.createElement('a');
        a.href = hash;
        if (icon) {
          // Decorative: the text label is the link's name.
          const glyph = document.createElement('span');
          glyph.className = `u2-icon u2-icon--${icon}`;
          glyph.setAttribute('aria-hidden', 'true');
          a.append(glyph);
        }
        const label = document.createElement('span');
        label.textContent = text;
        a.append(label);
        a.dataset.route = hash;
        li.appendChild(a);
        list.appendChild(li);
      }

      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        this._setOpen(section, open);
        this._state[group.id] = open;
        writeState(this._state);
      });

      section.append(toggle, list);
      this.appendChild(section);

      const stored = this._state[group.id];
      const open = typeof stored === 'boolean' ? stored : group.open;
      this._setOpen(section, open || group.routes.some(([hash]) => routeMatches(current, hash)));
    }

    const footer = document.createElement('div');
    footer.className = 'nav-footer';
    footer.textContent = 'local instance';
    this.appendChild(footer);

    this._updateActive();
  }

  // Enabled add-ons may contribute navigation entries through their manifest
  // (ADR 0010, point 7). Each opens that add-on's page; an unknown group falls
  // back to Add-ons and an unknown icon to the puzzle piece.
  async _loadAddonRoutes() {
    let data;
    try { data = await getAddons(); } catch { return; }
    if (!this.isConnected) return;
    this.querySelectorAll('[data-addon-route]').forEach((node) => node.remove());
    for (const addon of data?.addons || []) {
      if (!addon.enabled) continue;
      for (const entry of addon.nav || []) {
        const wanted = NAV_GROUPS.find((group) => group.label.toLowerCase() === String(entry.group || '').toLowerCase()) || NAV_GROUPS.find((group) => group.id === 'addons');
        const list = this.querySelector(`.nav-group[data-group="${wanted.id}"] .nav-list`);
        if (!list) continue;
        const hash = `#/addons/${encodeURIComponent(addon.id)}`;
        const li = document.createElement('li');
        li.className = 'nav-list__item';
        li.dataset.addonRoute = addon.id;
        const a = document.createElement('a');
        a.href = hash; a.dataset.route = hash;
        const glyph = document.createElement('span');
        glyph.className = `u2-icon u2-icon--${KNOWN_ICONS.has(entry.icon) ? entry.icon : 'puzzle-piece'}`;
        glyph.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = entry.title;
        a.append(glyph, text);
        li.appendChild(a);
        list.appendChild(li);
      }
    }
    this._updateActive();
  }

  _current() {
    return (window.location.hash || '#/home').split('?')[0];
  }

  _setOpen(section, open) {
    section.querySelector('.nav-group__toggle').setAttribute('aria-expanded', String(open));
    section.querySelector('.nav-list').hidden = !open;
  }

  _updateActive() {
    const current = this._current();
    this.querySelectorAll('a[data-route]').forEach((a) => {
      a.classList.toggle('is-active', EXACT_ROUTES.has(a.dataset.route) ? current === a.dataset.route : routeMatches(current, a.dataset.route));
    });
    // Following a link or the browser's back button into a collapsed group
    // opens it, without overwriting what the owner chose to remember.
    this.querySelectorAll('.nav-group').forEach((section) => {
      if (section.querySelector('a.is-active')) this._setOpen(section, true);
    });
  }
}

customElements.define('u2-nav', U2Nav);
