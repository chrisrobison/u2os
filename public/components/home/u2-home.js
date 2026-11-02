import * as api from '../../services/api.js';
import { el } from './home-util.js';
import { greetingFor, dateLabel, JOURNAL_LIMIT } from './home-model.js';
import { header, tiles, timeline, routinesPanel, world, decisions, trust, ask } from './home-parts.js';

// #/home: the Home overview (#495). Each panel reads one or more existing
// endpoints and renders its own loading, error and empty state. Sources load
// independently, so one failing never blanks the rest. Responses that arrive
// after the page was left (or after a newer request for the same source) are
// discarded. Approve/Reject on the decision cards go through <u2-home-decision>,
// which calls the existing approval API; nothing here decides anything.

const REFRESH_EVENT = /^(agent\.action\.|routine\.|vault\.|email\.sent|task\.|commitment\.)/;

const SOURCES = {
  owner: () => api.getOwnerEntity().then((r) => r?.entity?.name || null),
  pending: () => api.getPendingActions(),
  routines: () => api.getRoutines(),
  journal: () => api.getVaultJournal({ limit: JOURNAL_LIMIT }),
  people: () => api.getVaultRecords('Person').then((r) => r.records.length),
  projects: () => api.getVaultRecords('Project').then((r) => r.records.length),
  commitments: () => api.getMemoryEntities({ type: 'Commitment' }).then((r) => r.entities.length),
  vault: () => api.getVaultStatus(),
  model: () => api.getModelStatus(),
  connectors: () => api.getConnectors(),
};

// Panel -> the sources it reads. A panel re-renders only when one of these changed.
const DAY_PANELS = new Set(['header', 'tiles', 'timeline']);
const PANELS = {
  header: { deps: ['owner'], render: (s, ctx) => header(s, ctx.now, { greeting: greetingFor(ctx.now, s.owner.data), date: dateLabel(ctx.now) }) },
  tiles: { deps: ['pending', 'routines', 'journal'], render: (s, ctx) => tiles(s, ctx.now) },
  timeline: { deps: ['journal'], render: (s, ctx) => timeline(s, ctx.now) },
  routines: { deps: ['routines'], render: (s) => routinesPanel(s) },
  world: { deps: ['people', 'projects', 'commitments'], render: (s) => world(s) },
  decisions: { deps: ['pending'], render: (s) => decisions(s) },
  trust: { deps: ['vault', 'model', 'connectors'], render: (s) => trust(s) },
};
const MAIN = ['header', 'tiles', 'timeline'];
const LOWER = ['routines', 'world'];
const RAIL = ['decisions', 'trust'];
const LIVE_RELOAD = ['pending', 'routines', 'journal', 'vault', 'people', 'projects', 'commitments'];

export class U2Home extends HTMLElement {
  constructor() {
    super();
    this._seq = {};
    this._state = Object.fromEntries(Object.keys(SOURCES).map((key) => [key, { status: 'loading', data: null, error: null }]));
    this._sigs = {};
    this._nodes = {};
    this._onEvent = (event) => {
      if (!REFRESH_EVENT.test(event.detail?.type || '')) return;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => LIVE_RELOAD.forEach((key) => this._load(key)), 300);
    };
    this._onResolved = (event) => {
      const { title, label } = event.detail || {};
      if (this._live) this._live.textContent = `${title || 'Action'}: ${label || 'updated'}.`;
      ['pending', 'journal'].forEach((key) => this._load(key));
    };
  }

  connectedCallback() {
    this._workspace = this.closest?.('.workspace');
    this._workspace?.classList.add('workspace--wide');
    this.classList.add('home');
    this._live = el('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const slot = (key) => { this._nodes[key] = el('div', { class: `home-slot home-slot--${key}`, 'data-slot': key }); return this._nodes[key]; };
    const askSlot = el('div', { class: 'home-slot home-slot--ask' }, el('section', { class: 'home-panel', 'aria-label': 'Ask U2' }, ask((text) => this._ask(text))));
    this.replaceChildren(
      this._live,
      el('div', { class: 'home-layout' },
        el('div', { class: 'home-main' }, ...MAIN.map(slot), el('div', { class: 'home-lower' }, ...LOWER.map(slot))),
        el('aside', { class: 'home-rail', 'aria-label': 'Decisions and system status' }, askSlot, ...RAIL.map(slot))));
    this.addEventListener('u2-action-resolved', this._onResolved);
    window.addEventListener('u2-event', this._onEvent);
    this._renderAll();
    Object.keys(SOURCES).forEach((key) => this._load(key));
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
    this.removeEventListener('u2-action-resolved', this._onResolved);
    clearTimeout(this._debounce);
    for (const key of Object.keys(SOURCES)) this._seq[key] = (this._seq[key] || 0) + 1; // discard anything still in flight
    this._workspace?.classList.remove('workspace--wide');
  }

  _ask(text) {
    const detail = { text, accepted: null };
    this.dispatchEvent(new CustomEvent('u2-home-ask', { bubbles: true, composed: true, detail }));
    return detail.accepted === null ? 'unavailable' : detail.accepted ? true : 'busy';
  }

  async _load(key) {
    const seq = (this._seq[key] = (this._seq[key] || 0) + 1);
    let next;
    try {
      next = { status: 'ready', data: await SOURCES[key](), error: null };
    } catch (err) {
      next = { status: 'error', data: null, error: err?.message || 'the request failed' };
    }
    if (seq !== this._seq[key] || !this.isConnected) return; // newer request, or the page was left
    // A failed refresh keeps the last good data on screen rather than blanking the panel.
    if (next.status === 'error' && this._state[key].status === 'ready') return;
    this._state[key] = next;
    this._renderAll();
  }

  _renderAll() {
    const ctx = { now: new Date() };
    for (const [name, def] of Object.entries(PANELS)) {
      const slice = Object.fromEntries(def.deps.map((dep) => [dep, this._state[dep]]));
      const sig = JSON.stringify(slice) + (DAY_PANELS.has(name) ? ctx.now.toDateString() : '');
      if (this._sigs[name] === sig) continue;
      this._sigs[name] = sig;
      this._nodes[name]?.replaceChildren(def.render(slice, ctx));
    }
  }
}

customElements.define('u2-home', U2Home);
