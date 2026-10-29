import { test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_STATUSES } from '../mcp/jobs/hunt/storage/store.js';

// #631: the Opportunities table. No DOM library in this repo, so a minimal shim stands in for the browser (the same
// approach as tests/job-hunt-overview-ui.test.js, with a small selector engine, focus and event targets added).

class Ev { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.detail = init.detail; this.key = init.key; this.target = null; this.defaultPrevented = false; } preventDefault() { this.defaultPrevented = true; } }
class NodeShim { constructor() { this.parentNode = null; this.childNodes = []; } }
class TextShim extends NodeShim { constructor(t) { super(); this.data = String(t); } get textContent() { return this.data; } }

function matchesSimple(node, sel) {
  const tag = /^[a-z][a-z0-9-]*/i.exec(sel)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const rest = sel.slice(tag?.length ?? 0);
  for (const [, cls] of rest.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(cls)) return false;
  for (const [, name, value] of rest.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (!node.hasAttribute(name)) return false;
    if (value !== undefined && node.getAttribute(name) !== value) return false;
  }
  return true;
}

class ElementShim extends NodeShim {
  constructor(tag = 'custom-element') { super(); this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.listeners = {}; this.isConnected = true; this.style = { setProperty() {} }; this.classList = { add: (...c) => { const s = new Set((this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); this.attrs.set('class', [...s].join(' ')); }, contains: (c) => (this.attrs.get('class') ?? '').split(/\s+/).includes(c), remove: () => {}, toggle: () => {} }; }
  get children() { return this.childNodes.filter((n) => n instanceof ElementShim); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = [new TextShim(v)]; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? new TextShim(n) : n; node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this); }
  setAttribute(k, v) { const old = this.attrs.get(k) ?? null; this.attrs.set(k, String(v)); if (this.constructor.observedAttributes?.includes(k)) this.attributeChangedCallback?.(k, old, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); if (this.constructor.observedAttributes?.includes(k)) this.attributeChangedCallback?.(k, null, null); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : force; if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  dispatchEvent(e) { e.target ??= this; for (let n = this; n; n = e.bubbles ? n.parentNode : null) for (const fn of n.listeners?.[e.type] ?? []) fn(e); return true; }
  descendants(out = []) { for (const c of this.children) { out.push(c); c.descendants(out); } return out; }
  querySelectorAll(selector) { const sels = selector.split(',').map((s) => s.trim()); return this.descendants().filter((n) => sels.some((s) => matchesSimple(n, s))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { const sels = selector.split(',').map((s) => s.trim()); for (let n = this; n instanceof ElementShim; n = n.parentNode) if (sels.some((s) => matchesSimple(n, s))) return n; return null; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  focus() { document.activeElement = this; this.dispatchEvent(new Ev('focusin', { bubbles: true })); }
  click() { this.dispatchEvent(new Ev('click', { bubbles: true })); }
  showModal() { queueMicrotask(() => (dialogAnswer ? this.querySelector('[data-confirm]') : this.querySelectorAll('button')[1]).click()); }
  close() { this.dispatchEvent(new Ev('close')); }
}

const registry = new Map();
const windowListeners = {};
const urlWrites = [];
let fetchCalls = [];
let respond = async () => ({});
let dialogAnswer = true;
const realFetch = globalThis.fetch;

before(async () => {
  Object.assign(globalThis, {
    Node: NodeShim, HTMLElement: ElementShim, CustomEvent: Ev,
    customElements: { get: (n) => registry.get(n), define: (n, c) => registry.set(n, c) },
    document: { createElement: (t) => { const node = registry.has(t) ? new (registry.get(t))() : new ElementShim(t); node.tagName = t.toUpperCase(); return node; }, createTextNode: (t) => new TextShim(t), hidden: false, activeElement: null, body: new ElementShim('body') },
    window: { addEventListener: (t, fn) => { (windowListeners[t] ??= []).push(fn); }, removeEventListener: (t, fn) => { windowListeners[t] = (windowListeners[t] ?? []).filter((f) => f !== fn); }, location: { hash: '' } },
    history: { pushState: (s, t, hash) => { urlWrites.push(['push', hash]); window.location.hash = hash; }, replaceState: (s, t, hash) => { urlWrites.push(['replace', hash]); window.location.hash = hash; } },
    sessionStorage: (() => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) }; })(),
    matchMedia: () => ({ matches: false }),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? 'GET' });
      const body = await respond(String(url), options);
      if (body instanceof Error) return { ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ error: body.message }) };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  await import('../public/components/job-hunt/u2-job-opportunities.js');
});

after(() => { globalThis.fetch = realFetch; });

const mounted = [];
beforeEach(() => { fetchCalls = []; urlWrites.length = 0; window.location.hash = ''; document.activeElement = null; dialogAnswer = true; globalThis.sessionStorage.removeItem('u2.jobOpportunities.current'); });
afterEach(() => { while (mounted.length) mounted.pop().disconnectedCallback(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 6; i += 1) await sleep(0); };
const J = (n) => `job_${String(n).padStart(16, '0')}`;
const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';

const row = (n, over = {}) => ({ id: J(n), company: `Company ${n}`, role: `Engineer ${n}`, locations: ['Oakland, CA'], remote: true, compensation: '$180K', skills: ['Node'], status: 'qualified', stage: 'qualified', needsInput: false, fit: 90 - n, fitLabel: 'strong', postedAt: '2026-10-01T00:00:00.000Z', firstSeenAt: '2026-10-02T00:00:00.000Z', ...over });
const COUNTS = { all: 120, needs_input: 3, ready: 7, applied: 11, responded: 2, archived: 5 };
const page = (items, over = {}) => ({ items, total: 120, page: 1, limit: 25, counts: COUNTS, ...over });

async function mount(items = [row(1), row(2), row(3)], over = {}) {
  respond = async () => page(items, over);
  const node = new (registry.get('u2-job-opportunities'))();
  mounted.push(node);
  node.connectedCallback();
  await flush();
  return node;
}

const rowsOf = (node) => node.querySelectorAll('tr[data-job]');
const part = (r, name) => r.querySelector(`[data-part="${name}"]`);
const press = (target, key) => { const e = new Ev('keydown', { bubbles: true, key }); target.dispatchEvent(e); return e; };
const lastUrl = () => new URL(fetchCalls.at(-1).url, 'http://x');
const params = () => Object.fromEntries(lastUrl().searchParams.entries());

test('the URL state round-trips, omits defaults and drops anything unknown', async () => {
  const m = await import('../public/components/job-hunt/jh-opportunities-model.js');
  assert.equal(m.opportunitiesHref(), '#/job-hunt/opportunities');
  assert.deepEqual(m.parseOpportunitiesHash('#/job-hunt/opportunities'), m.defaultState());
  const state = { filter: 'ready', stage: 'submitted', statuses: ['applied', 'contacted'], q: 'staff & "rust"', sort: 'company', dir: 'desc', minScore: 80, remote: true, page: 3 };
  const href = m.opportunitiesHref(state);
  assert.deepEqual(m.parseOpportunitiesHash(href), state);
  assert.equal(m.opportunitiesHref({ sort: 'company' }), '#/job-hunt/opportunities?sort=company', 'a natural direction is left out');
  assert.equal(m.opportunitiesHref({ sort: 'company', dir: 'desc' }), '#/job-hunt/opportunities?sort=company&dir=desc');
  const junk = m.parseOpportunitiesHash('#/job-hunt/opportunities?filter=nope&stage=nope&statuses=Applied,<b>,ok_status&sort=description&dir=up&min_score=999&page=-2&remote=yes');
  assert.deepEqual(junk, { ...m.defaultState(), statuses: ['ok_status'] });
  assert.equal(m.parseOpportunitiesHash(`#/x?q=${'a'.repeat(500)}`).q.length, 200);
  assert.deepEqual(m.apiParams({ ...m.defaultState(), q: 'x', page: 2 }, 25), { q: 'x', sort: 'fit', dir: 'desc', page: '2', limit: '25' });
  assert.deepEqual(m.nextSort({ sort: 'fit', dir: 'desc' }, 'fit'), { sort: 'fit', dir: 'asc' });
  assert.deepEqual(m.nextSort({ sort: 'fit', dir: 'desc' }, 'company'), { sort: 'company', dir: 'asc' });
});

test('every real job status has an owner-facing label, and missing values are dashes', async () => {
  const m = await import('../public/components/job-hunt/jh-opportunities-model.js');
  for (const status of JOB_STATUSES) assert.ok(m.STATUS_LABELS[status], `${status} has a label`);
  assert.deepEqual(Object.keys(m.STATUS_LABELS).sort(), [...JOB_STATUSES].sort(), 'no label for a status that does not exist');
  assert.deepEqual(m.statusOf({ status: 'materials_generated' }), ['agent', 'Ready to apply']);
  assert.deepEqual(m.statusOf({ status: 'scored', needsInput: true }), ['attention', 'Needs input'], 'a job waiting on you says so');
  assert.deepEqual(m.statusOf({ status: 'uncertain', needsInput: true }), ['attention', 'Outcome unknown']);
  assert.deepEqual(m.statusOf({ status: 'rejected', needsInput: true }), ['danger', 'Rejected']);
  assert.deepEqual(m.statusOf({ status: 'brand_new' }), ['neutral', 'Brand new']);
  assert.equal(m.locationText({ locations: [], remote: null }), '—');
  assert.equal(m.locationText({ locations: ['Oakland'], remote: true }), 'Oakland · Remote');
  assert.equal(m.locationText({ locations: ['Remote (US)'], remote: true }), 'Remote (US)');
  assert.equal(m.compensationText({ compensation: null }), '—');
  assert.equal(m.postedText({ postedAt: null }), '—');
  assert.equal(m.fitText({ fit: null }), '—');
  assert.equal(m.fitText({ fit: 0 }), '0');
  assert.equal(m.rangeText(2, 25, 4059, 25), '26–50 of 4,059');
  assert.equal(m.rangeText(1, 25, 0, 0), '0 results');
});

test('the table is an ARIA grid with the data in it, tab counts, and one tab stop', async () => {
  const node = await mount();
  const table = node.querySelector('table');
  assert.equal(table.getAttribute('role'), 'grid');
  assert.equal(table.getAttribute('aria-multiselectable'), 'true');
  assert.equal(table.getAttribute('aria-rowcount'), '121', 'total rows plus the header');
  assert.equal(table.getAttribute('aria-label'), 'Opportunities');
  const rows = rowsOf(node);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-rowindex')), ['2', '3', '4']);
  assert.ok(rows.every((r) => r.getAttribute('role') === 'row' && r.getAttribute('aria-selected') === 'false'));
  assert.deepEqual(rows.map((r) => r.getAttribute('tabindex')), ['0', '-1', '-1'], 'roving tabindex: exactly one row is a tab stop');
  assert.equal(part(rows[0], 'company').textContent, 'Company 1');
  assert.equal(part(rows[0], 'role').textContent, 'Engineer 1');
  assert.equal(part(rows[0], 'role').getAttribute('href'), `#/job-hunt/jobs/${J(1)}`);
  assert.equal(part(rows[0], 'location').textContent, 'Oakland, CA · Remote');
  assert.equal(part(rows[0], 'comp').textContent, '$180K');
  assert.equal(part(rows[0], 'fit').textContent, '89');
  assert.equal(part(rows[0], 'status').getAttribute('label'), 'Qualified');
  assert.equal(part(rows[0], 'posted').textContent.length > 3, true);
  assert.equal(node.querySelectorAll('th').filter((th) => th.getAttribute('aria-sort')).map((th) => th.getAttribute('aria-sort')).join(), 'descending', 'the sorted column says so');
  const tabs = node.querySelectorAll('[data-filter]');
  assert.deepEqual(tabs.map((t) => t.children[0].textContent), ['120', '3', '7', '11', '2', '5']);
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-pressed')), ['true', 'false', 'false', 'false', 'false', 'false']);
  assert.equal(part(node, 'range').textContent, '1–3 of 120');
  assert.equal(part(node, 'page').textContent, 'Page 1 of 5');
  assert.equal(fetchCalls[0].url, '/api/job-hunt/opportunities?sort=fit&dir=desc&page=1&limit=25');
});

test('missing optional values show a dash and hostile text stays text', async () => {
  const node = await mount([row(1, { role: null, locations: [], remote: null, compensation: null, fit: null, postedAt: null }), row(2, { company: HOSTILE, role: HOSTILE, locations: [HOSTILE] })]);
  const [bare, evil] = rowsOf(node);
  assert.deepEqual(['role', 'location', 'comp', 'fit', 'posted'].map((p) => part(bare, p).textContent), ['—', '—', '—', '—', '—']);
  assert.equal(part(evil, 'company').textContent, HOSTILE);
  assert.equal(part(evil, 'role').textContent, HOSTILE);
  assert.ok(!node.descendants().some((n) => ['IMG', 'SCRIPT'].includes(n.tagName)), 'no element was created from data');
  assert.ok(node.querySelectorAll('tr[data-job]').every((r) => /^job_[0-9a-f]{16}$/.test(r.getAttribute('data-job'))));
});

test('arrow keys move between rows, Home and End jump, Space toggles selection and Enter selects the row (opening the detail panel)', async () => {
  const node = await mount();
  const [a, b, c] = rowsOf(node);
  a.focus();
  assert.equal(press(a, 'ArrowDown').defaultPrevented, true);
  assert.equal(document.activeElement, b);
  assert.deepEqual(rowsOf(node).map((r) => r.getAttribute('tabindex')), ['-1', '0', '-1'], 'the tab stop follows focus');
  assert.ok(b.querySelector('[data-select]').getAttribute('tabindex') === '0' && a.querySelector('[data-select]').getAttribute('tabindex') === '-1', 'controls in other rows are not tab stops');
  press(b, 'End'); assert.equal(document.activeElement, c);
  press(c, 'ArrowDown'); assert.equal(document.activeElement, c, 'no wrap past the end');
  press(c, 'Home'); assert.equal(document.activeElement, a);
  press(a, 'ArrowUp'); assert.equal(document.activeElement, a);
  press(a, ' ');
  assert.equal(a.getAttribute('aria-selected'), 'true');
  assert.equal(a.querySelector('[data-select]').checked, true);
  assert.equal(part(node, 'selected-count').textContent, '1 selected');
  press(a, ' ');
  assert.equal(a.getAttribute('aria-selected'), 'false');
  assert.equal(node.querySelector('.jh-opp__bulk'), null, 'no bulk bar without a selection');
  b.focus();
  press(b, 'Enter');
  assert.equal(window.location.hash, `#/job-hunt/opportunities?job=${J(2)}`, 'Enter opens the panel in place (see tests/job-hunt-detail-panel-ui.test.js), not the job page');
  window.location.hash = '';
  // Enter on a link inside a row belongs to the link, not to the row.
  const link = part(a, 'role');
  const e = press(link, 'Enter');
  assert.equal(e.defaultPrevented, false);
  assert.equal(window.location.hash, '');
});

test('select-all covers the page and shows a mixed state', async () => {
  const node = await mount();
  const all = node.querySelector('[data-select-all]');
  all.checked = true; all.dispatchEvent(new Ev('change', { bubbles: true }));
  assert.equal(rowsOf(node).every((r) => r.getAttribute('aria-selected') === 'true'), true);
  assert.equal(part(node, 'selected-count').textContent, '3 selected');
  assert.equal(node.querySelector('[data-select-all]').checked, true);
  const one = rowsOf(node)[1].querySelector('[data-select]');
  one.checked = false; one.dispatchEvent(new Ev('change', { bubbles: true }));
  assert.equal(node.querySelector('[data-select-all]').indeterminate, true);
  assert.equal(node.querySelector('[data-select-all]').checked, false);
  node.querySelector('[data-action="clear-selection"]').click();
  assert.equal(rowsOf(node).some((r) => r.getAttribute('aria-selected') === 'true'), false);
});

test('choosing a row marks it, fires jh-opportunity-select, and the mark survives a refresh and a new mount', async () => {
  const node = await mount();
  const seen = [];
  node.addEventListener('jh-opportunity-select', (e) => seen.push(e.detail));
  rowsOf(node)[1].querySelector('td[data-col="location"]').click();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].jobId, J(2));
  assert.equal(seen[0].job.company, 'Company 2');
  assert.equal(rowsOf(node)[1].getAttribute('aria-current'), 'true');
  node.querySelector('[data-page="next"]').click(); // re-renders the grid
  await flush();
  assert.equal(rowsOf(node)[1].getAttribute('aria-current'), 'true', 'still marked after the data reloads');
  part(rowsOf(node)[0], 'role').click();
  assert.equal(seen.length, 1, 'a click on the role link does not select the row');
  const again = await mount();
  assert.equal(rowsOf(again)[1].getAttribute('aria-current'), 'true', 'remembered for the session');
  rowsOf(again)[0].dispatchEvent(new Ev('dblclick', { bubbles: true }));
  assert.equal(window.location.hash, `#/job-hunt/jobs/${J(1)}`);
});

test('tabs, sort, search, filters and paging go to the server and into the URL', async () => {
  const node = await mount();
  node.querySelector('[data-filter="needs_input"]').click();
  await flush();
  assert.deepEqual(params(), { filter: 'needs_input', sort: 'fit', dir: 'desc', page: '1', limit: '25' });
  assert.equal(window.location.hash, '#/job-hunt/opportunities?filter=needs_input');
  assert.equal(urlWrites.at(-1)[0], 'push');
  assert.equal(node.querySelector('[data-filter="needs_input"]').getAttribute('aria-pressed'), 'true');

  node.querySelector('[data-page="next"]').click();
  await flush();
  assert.equal(params().page, '2');
  assert.equal(window.location.hash, '#/job-hunt/opportunities?filter=needs_input&page=2');
  assert.equal(node.querySelector('[data-page="prev"]').hasAttribute('disabled'), false);

  node.querySelector('[data-sort="company"]').click();
  await flush();
  assert.deepEqual([params().sort, params().dir, params().page], ['company', 'asc', '1'], 'a new sort starts at its natural direction and page 1');
  assert.equal(node.querySelector('th[data-col="company"]').getAttribute('aria-sort'), 'ascending');
  node.querySelector('[data-sort="company"]').click();
  await flush();
  assert.equal(params().dir, 'desc');
  assert.equal(window.location.hash, '#/job-hunt/opportunities?filter=needs_input&sort=company&dir=desc');

  const search = node.querySelector('[data-part="search"]');
  const before = fetchCalls.length;
  for (const text of ['s', 'st', 'sta', 'staff']) { search.value = text; search.dispatchEvent(new Ev('input', { bubbles: true })); }
  await sleep(40);
  assert.equal(fetchCalls.length, before, 'typing is debounced');
  await sleep(350);
  assert.equal(fetchCalls.length, before + 1, 'one request for the whole burst');
  assert.equal(params().q, 'staff');
  assert.equal(urlWrites.at(-1)[0], 'replace', 'search does not fill the history');
  assert.match(window.location.hash, /q=staff/);

  const floor = node.querySelector('[data-part="floor"]');
  floor.value = '80'; floor.dispatchEvent(new Ev('change', { bubbles: true }));
  await flush();
  assert.equal(params().min_score, '80');
  const remote = node.querySelector('[data-part="remote"]');
  remote.checked = true; remote.dispatchEvent(new Ev('change', { bubbles: true }));
  await flush();
  assert.equal(params().remote, '1');
  node.querySelector('[data-action="clear-filters"]').click();
  await flush();
  assert.equal(params().q, undefined);
  assert.equal(params().min_score, undefined);
  assert.equal(params().remote, undefined);
  assert.equal(params().filter, 'needs_input', 'clearing filters keeps the tab');
});

test('a state in the URL is applied on load, and a stage link shows its removable chip', async () => {
  window.location.hash = '#/job-hunt/opportunities?stage=submitted&sort=posted&page=2&q=rust';
  const node = await mount();
  assert.deepEqual(params(), { stage: 'submitted', q: 'rust', sort: 'posted', dir: 'desc', page: '2', limit: '25' });
  assert.equal(node.querySelector('[data-part="search"]').value, 'rust');
  assert.match(node.querySelector('.jh-opp__chip').textContent, /Stage: Submitted/);
  node.querySelector('[data-action="clear-scope"]').click();
  await flush();
  assert.equal(params().stage, undefined);
  assert.equal(node.querySelectorAll('.jh-opp__chip').length, 0);
});

test('a slow older response never replaces a newer one', async () => {
  const waiting = [];
  respond = (url) => new Promise((resolve) => waiting.push({ url, resolve }));
  const node = new (registry.get('u2-job-opportunities'))();
  mounted.push(node);
  node.connectedCallback();
  await flush();
  node.querySelector('[data-filter="applied"]').click();
  await flush();
  assert.equal(waiting.length, 2);
  waiting[1].resolve(page([row(9)], { total: 1 }));
  await flush();
  waiting[0].resolve(page([row(1), row(2)], { total: 2 }));
  await flush();
  assert.deepEqual(rowsOf(node).map((r) => r.getAttribute('data-job')), [J(9)], 'the newer answer stays');
  assert.equal(part(node, 'range').textContent, '1–1 of 1');
});

test('loading, error, retry, kept data on a failed refresh, and empty states', async () => {
  let release;
  respond = () => new Promise((resolve) => { release = resolve; });
  const node = new (registry.get('u2-job-opportunities'))();
  mounted.push(node);
  node.connectedCallback();
  assert.equal(node.querySelector('jh-state').getAttribute('kind'), 'loading');
  release(new Error('boom'));
  await flush();
  const failed = node.querySelector('jh-state');
  assert.deepEqual([failed.getAttribute('kind'), failed.getAttribute('message'), failed.hasAttribute('retry')], ['error', 'boom', true]);
  respond = async () => page([row(1)]);
  failed.dispatchEvent(new Ev('jh-retry', { bubbles: true }));
  await flush();
  assert.equal(rowsOf(node).length, 1);
  respond = async () => new Error('later failure');
  node.dispatchEvent(new Ev('jh-retry', { bubbles: true }));
  await flush();
  assert.equal(rowsOf(node).length, 1, 'the last good rows stay');
  assert.match(node.querySelector('.jh-opp__notice').children[0].getAttribute('title'), /Showing the last data/);

  const empty = await mount([], { total: 0, counts: { all: 0, needs_input: 0, ready: 0, applied: 0, responded: 0, archived: 0 } });
  assert.equal(empty.querySelector('jh-state').getAttribute('kind'), 'empty');
  assert.equal(empty.querySelector('jh-state').getAttribute('title'), 'No opportunities yet');
  empty.querySelector('[data-filter="archived"]').click();
  await flush();
  assert.match(empty.querySelector('jh-state').getAttribute('title'), /Nothing under Archived/);
  const search = empty.querySelector('[data-part="search"]');
  search.value = 'zzz'; search.dispatchEvent(new Ev('input', { bubbles: true }));
  await sleep(350);
  assert.equal(empty.querySelector('jh-state').getAttribute('title'), 'No opportunities match');
  empty.querySelector('[data-action="clear-filters"]').click();
  await flush();
  assert.equal(params().q, undefined);
});

test('a page past the end after the list shrinks goes back to the last page', async () => {
  window.location.hash = '#/job-hunt/opportunities?page=9';
  respond = async (url) => (new URL(url, 'http://x').searchParams.get('page') === '9' ? page([], { total: 30, page: 9 }) : page([row(1)], { total: 30, page: 2 }));
  const node = new (registry.get('u2-job-opportunities'))();
  mounted.push(node);
  node.connectedCallback();
  await flush();
  assert.equal(params().page, '2');
  assert.equal(window.location.hash, '#/job-hunt/opportunities?page=2');
  assert.equal(urlWrites.at(-1)[0], 'replace');
});

test('bulk reject uses the existing status endpoint once per job, confirms first and keeps failures selected', async () => {
  const node = await mount();
  for (const r of rowsOf(node)) { const box = r.querySelector('[data-select]'); box.checked = true; box.dispatchEvent(new Ev('change', { bubbles: true })); }
  dialogAnswer = false;
  node.querySelector('[data-action="bulk-reject"]').click();
  await flush();
  assert.equal(fetchCalls.filter((c) => c.method === 'POST').length, 0, 'cancel does nothing');
  assert.equal(part(node, 'selected-count').textContent, '3 selected');
  dialogAnswer = true;
  respond = async (url, options) => {
    if (options?.method === 'POST') return url.includes(J(2)) ? new Error('A job that is offer cannot move to rejected') : { changed: true };
    return page([row(2)], { total: 1 });
  };
  node.querySelector('[data-action="bulk-reject"]').click();
  await sleep(30); await flush();
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => c.url), [1, 2, 3].map((n) => `/api/job-hunt/jobs/${J(n)}/status`));
  assert.match(node.querySelector('.jh-opp__notice').textContent, /Rejected 2 of 3\. 1 could not be rejected: A job that is offer cannot move to rejected/);
  assert.equal(part(node, 'selected-count').textContent, '1 selected', 'only the failure stays selected');
});
