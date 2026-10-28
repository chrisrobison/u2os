import * as api from '../../services/api.js';
import { el } from './jh-util.js';
import { FILTER_TABS, FIT_FLOORS, PAGE_SIZE, SORTS, apiParams, hasNarrowing, jobPageHref, naturalDir, nextSort, opportunitiesHref, pageCount, parseOpportunitiesHash } from './jh-opportunities-model.js';
import { applyTabStops, bulkBar, filterTabs, opportunityGrid, pager, scopeChips } from './jh-opportunities-parts.js';
import { confirmDialog } from './u2-job-actions.js';
import './u2-job-menu.js';
import './jh-all.js';

// #/job-hunt/opportunities: the searchable, server-queried opportunities table (#631). The server filters, searches,
// sorts and pages (GET /api/job-hunt/opportunities); this host keeps the state in the URL hash, ignores responses that
// arrive out of order, and offers keyboard navigation (roving tabindex over rows: arrows move, Space toggles the
// checkbox, Enter opens the job). Choosing a row fires `jh-opportunity-select` for the Phase 4 detail panel; until that
// exists, Enter, double-click and the role link open the job page. Bulk actions use the existing status endpoint only.

const SEARCH_DELAY_MS = 250;
const REFRESH_EVENT = /^agent\.action\./;
const STORAGE_KEY = 'u2.jobOpportunities.current';
const FILTER_KEYS = ['filter', 'q', 'stage', 'statuses', 'minScore', 'remote'];

function readCurrent() {
  try { return sessionStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
}
function saveCurrent(id) {
  try { if (id) sessionStorage.setItem(STORAGE_KEY, id); else sessionStorage.removeItem(STORAGE_KEY); } catch { /* not remembered */ }
}

export class U2JobOpportunities extends HTMLElement {
  constructor() {
    super();
    this._seq = 0;
    this._data = null;
    this._error = null;
    this._loading = false;
    this._state = parseOpportunitiesHash(typeof window === 'undefined' ? '' : window.location.hash);
    this._checked = new Set();
    this._currentId = readCurrent();
    this._activeId = null;
    this._filtersOpen = false;
    this._busy = false;
    this._notice = null;
    this._onEvent = (event) => {
      if (!REFRESH_EVENT.test(event.detail?.type || '')) return;
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this._load(), 300);
    };
  }

  connectedCallback() {
    this._workspace = this.closest?.('.workspace');
    this._workspace?.classList.add('workspace--wide');
    this.classList.add('jh', 'jh-opp');
    this._buildFrame();
    this.addEventListener('click', (event) => this._onClick(event));
    this.addEventListener('dblclick', (event) => this._onDoubleClick(event));
    this.addEventListener('change', (event) => this._onChange(event));
    this.addEventListener('input', (event) => this._onInput(event));
    this.addEventListener('keydown', (event) => this._onKeydown(event));
    this.addEventListener('focusin', (event) => this._onFocusin(event));
    this.addEventListener('jh-retry', () => this._load());
    // A row's menu changed the job (rejected, pre-filled, ...): show what happened and reload.
    this.addEventListener('jh-job-updated', (event) => { this._notice = event.detail?.notice ?? null; this._load(); });
    window.addEventListener('u2-event', this._onEvent);
    this._syncControls();
    this._render();
    this._load();
  }

  disconnectedCallback() {
    window.removeEventListener('u2-event', this._onEvent);
    clearTimeout(this._searchTimer);
    clearTimeout(this._refreshTimer);
    this._seq += 1;
    this._workspace?.classList.remove('workspace--wide');
  }

  // ---- frame -----------------------------------------------------------------

  /** The parts that must survive a refresh (the search box, the tabs, the filter controls) are built once. */
  _buildFrame() {
    this._search = el('input', { type: 'search', class: 'jh-search__input', 'aria-label': 'Search opportunities', placeholder: 'Search company, role, location or skill', maxlength: '200', autocomplete: 'off', 'data-part': 'search' });
    this._filtersButton = el('button', { type: 'button', class: 'btn', 'data-action': 'toggle-filters', 'aria-expanded': 'false', 'aria-controls': 'jh-opp-filters', text: 'Filters' });
    this._sortSelect = el('select', { class: 'jh-select', 'aria-label': 'Sort by', 'data-part': 'sort' }, SORTS.map(([id, label]) => el('option', { value: id, text: label })));
    this._dirButton = el('button', { type: 'button', class: 'btn', 'data-action': 'toggle-dir' });
    this._floor = el('select', { class: 'jh-select', id: 'jh-opp-floor', 'data-part': 'floor' }, FIT_FLOORS.map(([value, label]) => el('option', { value: String(value), text: label })));
    this._remote = el('input', { type: 'checkbox', id: 'jh-opp-remote', 'data-part': 'remote' });
    this._filtersPanel = el('div', { class: 'jh-opp__filters', id: 'jh-opp-filters', role: 'group', 'aria-label': 'Filters', hidden: '' },
      el('label', { class: 'jh-opp__field', for: 'jh-opp-floor' }, el('span', { text: 'Fit score' }), this._floor),
      el('label', { class: 'jh-opp__field jh-opp__field--check', for: 'jh-opp-remote' }, this._remote, el('span', { text: 'Remote only' })),
      el('button', { type: 'button', class: 'btn', 'data-action': 'clear-filters', text: 'Clear filters' }));
    this._tabs = filterTabs(this._state, null);
    this._chips = el('div', { class: 'jh-opp__chips-slot' });
    this._bulk = el('div', { class: 'jh-opp__bulk-slot' });
    this._noticeEl = el('div', { class: 'jh-opp__notice', role: 'status', 'aria-live': 'polite' });
    this._body = el('div', { class: 'jh-opp__body' });
    this._foot = el('div', { class: 'jh-opp__foot' });
    this.replaceChildren(
      el('div', { class: 'jh-head' }, el('div', { class: 'jh-head__text' },
        el('h1', { class: 'jh-ov__title', text: 'Opportunities' }),
        el('p', { class: 'jh-ov__sub', text: 'Every job U2OS has found, searchable and sortable. Select a row to open it.' }))),
      el('section', { class: 'jh-panel jh-opp__panel', 'aria-label': 'Opportunities' },
        this._tabs,
        el('div', { class: 'jh-opp__toolbar' },
          el('div', { class: 'jh-search jh-opp__search' }, this._search),
          this._filtersButton,
          el('div', { class: 'jh-opp__sortbox' }, el('span', { class: 'jh-ov__muted', text: 'Sort' }), this._sortSelect, this._dirButton)),
        this._filtersPanel, this._chips, this._bulk, this._noticeEl, this._body, this._foot));
  }

  /** Puts the controls in step with the state (after a navigation, or on first render). */
  _syncControls() {
    const state = this._state;
    if (this._search.value !== state.q) this._search.value = state.q;
    this._sortSelect.value = state.sort;
    this._dirButton.textContent = state.dir === 'asc' ? '↑ Ascending' : '↓ Descending';
    this._dirButton.setAttribute('aria-label', `Sort direction: ${state.dir === 'asc' ? 'ascending' : 'descending'}. Activate to reverse.`);
    this._floor.value = String(state.minScore ?? 0);
    this._remote.checked = state.remote;
    this._filtersButton.setAttribute('aria-expanded', String(this._filtersOpen));
    this._filtersPanel.toggleAttribute('hidden', !this._filtersOpen);
    this._filtersButton.textContent = state.minScore || state.remote ? 'Filters (on)' : 'Filters';
    for (const button of this._tabs.children) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-filter') === state.filter));
    }
  }

  // ---- data ------------------------------------------------------------------

  async _load() {
    const seq = ++this._seq;
    this._loading = true;
    this._body.setAttribute('aria-busy', 'true');
    let data;
    try {
      data = await api.getJobHuntOpportunities(apiParams(this._state, PAGE_SIZE));
      if (!data || !Array.isArray(data.items)) throw new Error('The server sent an unexpected answer.');
    } catch (err) {
      if (seq !== this._seq) return; // a newer request is in flight, or the page was left
      this._loading = false;
      this._error = err?.message || 'The request failed';
      this._render();
      return;
    }
    if (seq !== this._seq) return; // an older answer arriving late must not replace a newer one
    this._loading = false;
    this._data = data;
    this._error = null;
    // The list shrank under the current page (rejected or archived rows): go to the last page that exists.
    const pages = pageCount(data.total, data.limit || PAGE_SIZE);
    if (!data.items.length && data.total > 0 && this._state.page > pages) {
      this._navigate({ page: pages }, { replace: true });
      return;
    }
    // Selections that no longer exist anywhere cannot be acted on; ones on another page stay.
    this._render();
  }

  /** Changes the query state, mirrors it into the URL and reloads. Any change but the page returns to page 1. */
  _navigate(partial, { replace = false } = {}) {
    this._notice = null;
    const next = { ...this._state, ...partial };
    if (!('page' in partial)) next.page = 1;
    if (FILTER_KEYS.some((key) => JSON.stringify(next[key]) !== JSON.stringify(this._state[key]))) this._checked.clear();
    this._state = next;
    this._writeUrl(replace);
    this._syncControls();
    this._load();
  }

  _writeUrl(replace) {
    const hash = opportunitiesHref(this._state);
    try {
      if (window.location.hash === hash) return;
      if (typeof history !== 'undefined' && history.pushState) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
      else window.location.hash = hash;
    } catch { /* the URL is a convenience */ }
  }

  // ---- rendering -------------------------------------------------------------

  _focusKey() {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!active || !active.closest || !this.contains?.(active)) return null;
    for (const attribute of ['data-sort', 'data-page', 'data-select', 'data-select-all']) {
      const holder = active.closest(`[${attribute}]`);
      if (holder) return [attribute, holder.getAttribute(attribute)];
    }
    const row = active.closest('tr[data-job]');
    return row && row === active ? ['row', row.getAttribute('data-job')] : null;
  }

  _refocus(key) {
    if (!key) return;
    const [attribute, value] = key;
    const found = [...this.querySelectorAll(attribute === 'row' ? 'tr[data-job]' : `[${attribute}]`)].find((node) => (attribute === 'row' ? node.getAttribute('data-job') : node.getAttribute(attribute)) === value);
    const target = found && !found.hasAttribute('disabled') ? found : this.querySelector('tr[data-job][tabindex="0"]');
    target?.focus?.();
  }

  _render() {
    const focus = this._focusKey();
    const data = this._data;
    const state = this._state;
    this._body.removeAttribute('aria-busy');
    // Tabs and counts update in place, so a focused tab keeps focus.
    for (const button of this._tabs.children) {
      const count = button.children[0];
      const next = data?.counts?.[button.getAttribute('data-filter')];
      count.textContent = typeof next === 'number' ? next.toLocaleString('en-US') : '—';
    }
    this._chips.replaceChildren(state.stage || state.statuses?.length ? scopeChips(state, this._stageLabel()) : '');
    this._bulk.replaceChildren(this._checked.size ? bulkBar(this._checked.size, this._busy) : '');
    const notices = [];
    if (this._notice) notices.push(el('p', { class: this._notice.error ? 'load-error' : 'jh-note', text: this._notice.text }));
    if (data && this._error) notices.push(el('jh-state', { kind: 'error', title: 'Showing the last data we loaded', message: `The refresh failed: ${this._error}.`, retry: '', 'retry-label': 'Refresh' }));
    this._noticeEl.replaceChildren(...notices);

    if (!data) {
      this._body.replaceChildren(this._error
        ? el('jh-state', { kind: 'error', title: "Couldn't load opportunities", message: this._error, retry: '', 'retry-label': 'Try again' })
        : el('jh-state', { kind: 'loading', title: 'Loading opportunities...' }));
      this._foot.replaceChildren();
      return;
    }
    if (!data.items.length) {
      const narrowed = hasNarrowing(state);
      this._body.replaceChildren(el('jh-state', {
        kind: 'empty', title: narrowed ? 'No opportunities match' : state.filter === 'all' ? 'No opportunities yet' : `Nothing under ${FILTER_TABS.find((tab) => tab.id === state.filter)?.label ?? 'this filter'}`,
        message: narrowed ? 'Try a different search or clear the filters.' : state.filter === 'all' ? 'Run discovery or turn on the autopilot, and jobs appear here.' : 'Jobs show up here as they reach this stage.',
      }), narrowed ? el('div', { class: 'jh-opp__empty-actions' }, el('button', { type: 'button', class: 'btn', 'data-action': 'clear-filters', text: 'Clear search and filters' })) : '');
      this._foot.replaceChildren(data.total ? pager(state, data.total, data.limit, 0) : '');
      this._refocus(focus);
      return;
    }
    this._body.replaceChildren(opportunityGrid({ items: data.items, state, total: data.total, limit: data.limit, checked: this._checked, currentId: this._currentId }));
    this._activeId = applyTabStops(this, data.items.some((item) => item.id === this._activeId) ? this._activeId : (data.items.some((item) => item.id === this._currentId) ? this._currentId : null));
    this._foot.replaceChildren(pager(state, data.total, data.limit, data.items.length));
    this._refocus(focus);
  }

  _stageLabel() {
    const labels = { discovered: 'Discovered', qualified: 'Qualified', preparing: 'Preparing', submitted: 'Submitted', responded: 'Responded', interviewing: 'Interviewing', offer: 'Offer', needs_input: 'Needs Input' };
    return labels[this._state.stage] ?? this._state.stage;
  }

  // ---- interaction -----------------------------------------------------------

  _rows() { return [...this.querySelectorAll('tr[data-job]')]; }

  _onClick(event) {
    const target = event.target;
    if (!target?.closest) return;
    const action = target.closest('[data-action]');
    const act = action?.getAttribute('data-action');
    if (act === 'toggle-filters') { this._filtersOpen = !this._filtersOpen; this._syncControls(); return; }
    if (act === 'toggle-dir') { this._navigate({ dir: this._state.dir === 'asc' ? 'desc' : 'asc' }); return; }
    if (act === 'clear-filters') { this._navigate({ q: '', stage: null, statuses: null, minScore: null, remote: false }); return; }
    if (act === 'clear-scope') { this._navigate(action.getAttribute('data-scope') === 'stage' ? { stage: null } : { statuses: null }); return; }
    if (act === 'clear-selection') { this._checked.clear(); this._render(); return; }
    if (act === 'bulk-reject') { this._bulkReject(); return; }
    const tab = target.closest('[data-filter]');
    if (tab) { this._navigate({ filter: tab.getAttribute('data-filter') }); return; }
    const sort = target.closest('[data-sort]');
    if (sort) { this._navigate(nextSort(this._state, sort.getAttribute('data-sort'))); return; }
    const page = target.closest('[data-page]');
    if (page) {
      const pages = pageCount(this._data?.total ?? 0, this._data?.limit || PAGE_SIZE);
      const next = page.getAttribute('data-page') === 'next' ? Math.min(pages, this._state.page + 1) : Math.max(1, this._state.page - 1);
      if (next !== this._state.page) this._navigate({ page: next });
      return;
    }
    // Anything interactive inside a row does its own thing; the rest of the row selects it.
    if (target.closest('a, button, input, select, u2-job-menu, [role="menu"]')) return;
    const row = target.closest('tr[data-job]');
    if (row) this._setCurrent(row.getAttribute('data-job'));
  }

  _onDoubleClick(event) {
    const row = event.target?.closest?.('tr[data-job]');
    if (row && !event.target.closest('a, button, input, select, u2-job-menu')) this._open(row.getAttribute('data-job'));
  }

  _onChange(event) {
    const target = event.target;
    if (!target?.closest) return;
    const pick = target.closest('[data-select]');
    if (pick) { this._toggleChecked(pick.getAttribute('data-select'), target.checked); return; }
    if (target.closest('[data-select-all]')) {
      for (const item of this._data?.items ?? []) { if (target.checked) this._checked.add(item.id); else this._checked.delete(item.id); }
      this._render();
      return;
    }
    if (target === this._sortSelect) { this._navigate({ sort: target.value, dir: naturalDir(target.value) }); return; }
    if (target === this._floor) { this._navigate({ minScore: Number(target.value) || null }); return; }
    if (target === this._remote) { this._navigate({ remote: target.checked }); }
  }

  _onInput(event) {
    if (event.target !== this._search) return;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._navigate({ q: this._search.value.trim() }, { replace: true }), SEARCH_DELAY_MS);
  }

  _toggleChecked(id, on) {
    if (on) this._checked.add(id); else this._checked.delete(id);
    const row = this._rows().find((node) => node.getAttribute('data-job') === id);
    row?.setAttribute('aria-selected', String(on));
    const box = row?.querySelector('[data-select]');
    if (box && box.checked !== on) box.checked = on;
    const items = this._data?.items ?? [];
    const all = this.querySelector('[data-select-all]');
    if (all) {
      const picked = items.filter((item) => this._checked.has(item.id)).length;
      all.checked = items.length > 0 && picked === items.length;
      all.indeterminate = picked > 0 && picked < items.length;
    }
    this._bulk.replaceChildren(this._checked.size ? bulkBar(this._checked.size, this._busy) : '');
  }

  _onFocusin(event) {
    const row = event.target?.closest?.('tr[data-job]');
    if (!row) return;
    this._activeId = applyTabStops(this, row.getAttribute('data-job'));
  }

  /** The row the owner is working on: it stays marked across refreshes and pages, and tells the detail panel to open. */
  _setCurrent(id) {
    this._currentId = id;
    saveCurrent(id);
    for (const row of this._rows()) {
      const on = row.getAttribute('data-job') === id;
      if (on) { row.setAttribute('aria-current', 'true'); row.setAttribute('data-current', ''); } else { row.removeAttribute('aria-current'); row.removeAttribute('data-current'); }
    }
    const job = (this._data?.items ?? []).find((item) => item.id === id) ?? null;
    this.dispatchEvent(new CustomEvent('jh-opportunity-select', { bubbles: true, detail: { jobId: id, job } }));
  }

  _open(id) {
    this._setCurrent(id);
    const href = jobPageHref(id);
    if (href) window.location.hash = href;
  }

  _onKeydown(event) {
    const target = event.target;
    if (!target?.closest || target.closest('[role="menu"]') || target === this._search) return;
    const row = target.closest('tr[data-job]');
    if (!row) return;
    const rows = this._rows();
    const at = rows.indexOf(row);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (move !== undefined && !target.closest('select')) {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, move))]?.focus();
      return;
    }
    if (target !== row) return; // Space and Enter belong to the checkbox, link or button that has focus
    const id = row.getAttribute('data-job');
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      this._toggleChecked(id, !this._checked.has(id));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this._open(id);
    }
  }

  // ---- bulk ------------------------------------------------------------------

  /** Rejects every selected job through POST /api/job-hunt/jobs/:id/status (the same call as a row's Reject), one by one. */
  async _bulkReject() {
    const ids = [...this._checked];
    if (!ids.length || this._busy) return;
    const opener = this.querySelector('[data-action="bulk-reject"]');
    const yes = await confirmDialog({
      title: `Reject ${ids.length} job${ids.length === 1 ? '' : 's'}`, confirmText: 'Reject', danger: true, opener,
      body: [`Move ${ids.length === 1 ? 'the selected job' : `all ${ids.length} selected jobs`} to Rejected. Nothing is sent to the companies, and the autopilot will not pick them up again. Jobs that cannot be rejected (an offer, say) are left alone.`],
    });
    if (!yes) return;
    this._busy = true;
    this._notice = { text: `Rejecting ${ids.length}...` };
    this._render();
    let done = 0; const failures = [];
    for (const id of ids) {
      try { await api.moveJobHuntJob(id, 'rejected'); done += 1; this._checked.delete(id); } catch (error) { failures.push(String(error?.message ?? error).slice(0, 120)); }
    }
    this._busy = false;
    this._notice = failures.length
      ? { error: true, text: `Rejected ${done} of ${ids.length}. ${failures.length} could not be rejected: ${[...new Set(failures)].slice(0, 3).join('; ')}. They stay selected.` }
      : { text: `Rejected ${done} job${done === 1 ? '' : 's'}.` };
    await this._load();
  }
}

if (!customElements.get('u2-job-opportunities')) customElements.define('u2-job-opportunities', U2JobOpportunities);
