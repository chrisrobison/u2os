import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { leadsHref, parseLeadsQuery } from '../public/components/job-hunt/leads-filter.js';

// #629: the Job Hunt Overview components. No DOM library in this repo, so a minimal shim stands in for the browser
// (the same approach as tests/job-hunt-primitives.test.js). It keeps text and children apart so a hostile string can be
// shown never to become an element.

class Ev { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.detail = init.detail; this.key = init.key; } }
class NodeShim { constructor() { this.parentNode = null; this.childNodes = []; } }
class TextShim extends NodeShim { constructor(t) { super(); this.data = String(t); } get textContent() { return this.data; } }
class ElementShim extends NodeShim {
  constructor(tag = "custom-element") { super(); this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.listeners = {}; this.isConnected = false; this.classList = { add: (...c) => { const s = new Set((this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); this.attrs.set('class', [...s].join(' ')); }, contains: (c) => (this.attrs.get('class') ?? '').split(/\s+/).includes(c) }; }
  get children() { return this.childNodes.filter((n) => n instanceof ElementShim); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = [new TextShim(v)]; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? new TextShim(n) : n; node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  setAttribute(k, v) { const old = this.attrs.get(k) ?? null; this.attrs.set(k, String(v)); if (this.constructor.observedAttributes?.includes(k)) this.attributeChangedCallback?.(k, old, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); if (this.constructor.observedAttributes?.includes(k)) this.attributeChangedCallback?.(k, null, null); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : force; if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  dispatchEvent(e) { for (let n = this; n; n = e.bubbles ? n.parentNode : null) for (const fn of n.listeners?.[e.type] ?? []) fn(e); return true; }
  click() { this.dispatchEvent(new Ev('click', { bubbles: true })); }
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c.find(pred); if (r) return r; } return null; }
  findClass(cls) { return this.find((n) => n.classList.contains(cls)); }
}


const registry = new Map();
const windowListeners = {};
let fetchCalls = [];
let respond = async () => ({});
const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;

before(async () => {
  Object.assign(globalThis, {
    Node: NodeShim, HTMLElement: ElementShim, CustomEvent: Ev,
    customElements: { get: (n) => registry.get(n), define: (n, c) => registry.set(n, c) },
    document: { createElement: (t) => { const node = registry.has(t) ? new (registry.get(t))() : new ElementShim(t); node.tagName = t.toUpperCase(); node.style = { setProperty() {} }; return node; }, createTextNode: (t) => new TextShim(t), hidden: false },
    window: { addEventListener: (t, fn) => { (windowListeners[t] ??= []).push(fn); }, removeEventListener: (t, fn) => { windowListeners[t] = (windowListeners[t] ?? []).filter((f) => f !== fn); }, location: { hash: '' } },
    matchMedia: () => ({ matches: false }),
    fetch: async (url) => { fetchCalls.push(String(url)); const body = await respond(String(url)); if (body instanceof Error) return { ok: false, status: 500, statusText: 'Server Error', text: async () => JSON.stringify({ error: body.message }) }; return { ok: true, status: 200, text: async () => JSON.stringify(body) }; },
  });
  // The embedded board pulls in the whole dashboard; give the shim a registered placeholder so it is not exercised here.
  registry.set('u2-job-dashboard', class extends ElementShim {});
  await import('../public/components/job-hunt/u2-job-overview.js');
});

const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().disconnectedCallback(); });

after(() => { globalThis.fetch = realFetch; globalThis.setInterval = realSetInterval; });

const all = (root, pred, out = []) => { for (const c of root.children) { if (pred(c)) out.push(c); all(c, pred, out); } return out; };
const byTag = (root, tag) => all(root, (n) => n.tagName === tag.toUpperCase());
const byPart = (root, part) => all(root, (n) => n.getAttribute('data-part') === part);
const textOf = (node) => node.textContent;
const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const JOB = 'job_0123456789abcdef';

function payload(over = {}) {
  return {
    generatedAt: '2026-10-27T12:00:00.000Z', strongMatchScore: 80, minimumScore: 82, offPipeline: 3,
    metrics: [
      { id: 'discovered', label: 'Jobs discovered', value: 4059, sub: '+312 this week', filter: 'all', statuses: null },
      { id: 'strong', label: 'Strong matches', value: 186, sub: 'score 80 or higher', filter: 'strong', statuses: null },
      { id: 'attention', label: 'Need your attention', value: 2, sub: 'questions, reviews, decisions', filter: 'needs_input', statuses: null },
      { id: 'submitted', label: 'Applications submitted', value: 8, sub: '2 in the last 7 days', filter: null, statuses: ['applied', 'contacted'] },
      { id: 'responded', label: 'Employer responses', value: 0, sub: '0 in the last 7 days', filter: null, statuses: ['screening', 'interview'] },
      { id: 'interviewing', label: 'Interviewing', value: 1, sub: 'active now', filter: null, statuses: ['interview'] },
    ],
    stages: [
      { id: 'discovered', label: 'Discovered', statuses: ['discovered', 'scored'], count: 4000, flag: false },
      { id: 'qualified', label: 'Qualified', statuses: ['qualified'], count: 40, flag: false },
      { id: 'preparing', label: 'Preparing', statuses: ['materials_generated', 'needs_input'], count: 12, flag: false },
      { id: 'needs_input', label: 'Needs Input', statuses: [], count: 2, flag: true },
      { id: 'submitted', label: 'Submitted', statuses: ['applied'], count: 8, flag: false },
      { id: 'responded', label: 'Responded', statuses: ['screening'], count: 2, flag: false },
      { id: 'interviewing', label: 'Interviewing', statuses: ['interview'], count: 1, flag: false },
      { id: 'offer', label: 'Offer', statuses: ['offer'], count: 0, flag: false },
    ],
    attention: { count: 2, items: [
      { jobId: JOB, company: 'Notion', role: 'Software Engineer', status: 'needs_input', score: 90, kind: 'needs_answers', kinds: ['needs_answers'], explanation: '1 required question could not be answered', detail: null, action: null, severity: 1, urgency: 0, deadline: null, since: '2026-10-27T10:00:00.000Z', question: { key: 'custom:why', label: 'Why are you interested?' } },
      { jobId: 'job_fedcba9876543210', company: 'OpenAI', role: null, status: 'uncertain', score: null, kind: 'uncertain', kinds: ['uncertain'], explanation: 'An application may have been sent, but the outcome is unknown', detail: null, action: null, severity: 3, urgency: 1, deadline: '2026-10-29T12:00:00.000Z', since: '2026-10-26T12:00:00.000Z', question: null },
    ] },
    activity: [{ id: 5, at: '2026-10-27T11:00:00.000Z', label: 'Application sent', tone: 'success', jobId: JOB, company: 'Notion', role: 'Software Engineer' }],
    autopilot: { mode: 'dry_run', execution: 'running', detail: null, lastRunAt: '2026-10-27T11:55:00.000Z' },
    ...over,
  };
}

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

test('the model helpers format counts, links and deadlines without inventing values', async () => {
  const { formatCount, jobHref, filterHref, stageHref, until } = await import('../public/components/job-hunt/jh-overview-model.js');
  assert.equal(formatCount(4059), '4,059');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
  assert.equal(jobHref(JOB), `#/job-hunt/jobs/${JOB}`);
  assert.equal(jobHref(JOB, { key: 'custom:why' }), `#/job-hunt/jobs/${JOB}?question=custom%3Awhy`);
  assert.equal(jobHref('javascript:alert(1)'), null);
  assert.equal(jobHref(null), null);
  assert.equal(filterHref({ filter: 'strong', statuses: null }), '#/job-hunt/opportunities?min_score=80');
  assert.equal(filterHref({ filter: 'strong', statuses: null }, 85), '#/job-hunt/opportunities?min_score=85');
  assert.equal(filterHref({ filter: null, statuses: ['applied', 'contacted'] }), '#/job-hunt/opportunities?statuses=applied,contacted');
  assert.equal(filterHref({ flag: true, statuses: [] }), '#/job-hunt/opportunities?filter=needs_input');
  assert.equal(filterHref({ filter: 'all', statuses: null }), '#/job-hunt/opportunities');
  assert.equal(stageHref({ id: 'submitted', flag: false }), '#/job-hunt/opportunities?stage=submitted');
  assert.equal(stageHref({ id: 'needs_input', flag: true }), '#/job-hunt/opportunities?filter=needs_input');
  assert.equal(until('2026-10-29T12:00:00.000Z', NOW), 'in 2d');
  assert.equal(until('2026-10-27T15:00:00.000Z', NOW), 'in 3h');
  assert.equal(until('2026-10-27T11:00:00.000Z', NOW), 'now');
  assert.equal(until(null, NOW), '');
});

test('leads links round-trip through parseLeadsQuery and drop unknown or malformed input', () => {
  assert.deepEqual(parseLeadsQuery(leadsHref({ filter: 'strong' })), { filter: 'strong', statuses: null });
  assert.deepEqual(parseLeadsQuery(leadsHref({ statuses: ['applied', 'followup_due'] })), { filter: null, statuses: ['applied', 'followup_due'] });
  assert.deepEqual(parseLeadsQuery('#/job-hunt/leads'), { filter: null, statuses: null });
  assert.deepEqual(parseLeadsQuery('#/job-hunt/leads?filter=bogus&statuses=Applied,<b>,ok_status'), { filter: null, statuses: ['ok_status'] });
  assert.equal(leadsHref(), '#/job-hunt/leads');
});

test('the summary bar shows every metric as a link to its filtered list', async () => {
  const { summaryBar } = await import('../public/components/job-hunt/jh-overview-parts.js');
  const bar = summaryBar(payload());
  const cards = byTag(bar, 'jh-summary-card');
  assert.deepEqual(cards.map((c) => c.getAttribute('label')), ['Jobs discovered', 'Strong matches', 'Need your attention', 'Applications submitted', 'Employer responses', 'Interviewing']);
  assert.deepEqual(cards.map((c) => c.getAttribute('value')), ['4,059', '186', '2', '8', '0', '1']);
  assert.deepEqual(cards.map((c) => c.getAttribute('href')), ['#/job-hunt/opportunities', '#/job-hunt/opportunities?min_score=80', '#/job-hunt/opportunities?filter=needs_input', '#/job-hunt/opportunities?statuses=applied,contacted', '#/job-hunt/opportunities?statuses=screening,interview', '#/job-hunt/opportunities?statuses=interview']);
  assert.equal(cards[0].getAttribute('sublabel'), '+312 this week');
  const unknown = summaryBar(payload({ metrics: [{ id: 'strong', label: 'Strong matches', value: null, sub: '', filter: 'strong', statuses: null }] }));
  assert.equal(byTag(unknown, 'jh-summary-card')[0].getAttribute('value'), '—');
});

test('the pipeline lists the eight stages in order, links each to a filtered list and states what the counts mean', async () => {
  const { pipeline } = await import('../public/components/job-hunt/jh-overview-parts.js');
  const node = pipeline(payload());
  const stages = all(node, (n) => n.getAttribute('data-stage'));
  assert.deepEqual(stages.map((s) => s.getAttribute('data-stage')), ['discovered', 'qualified', 'preparing', 'needs_input', 'submitted', 'responded', 'interviewing', 'offer']);
  assert.deepEqual(stages.map((s) => textOf(s.children[0].children[0])), ['4,000', '40', '12', '2', '8', '2', '1', '0']);
  const hrefs = stages.map((s) => s.children[0].getAttribute('href'));
  assert.deepEqual(hrefs, ['discovered', 'qualified', 'preparing'].map((id) => `#/job-hunt/opportunities?stage=${id}`).concat(['#/job-hunt/opportunities?filter=needs_input'], ['submitted', 'responded', 'interviewing', 'offer'].map((id) => `#/job-hunt/opportunities?stage=${id}`)));
  assert.ok(stages[3].hasAttribute('data-flag'), 'Needs Input is marked as a flag');
  assert.ok(!stages[0].hasAttribute('data-flag'));
  const text = textOf(node);
  assert.match(text, /not an overlapping funnel/);
  assert.match(text, /3 more are rejected/);
  assert.match(text, /4,063 in pipeline/);
});

test('the autopilot bar shows mode and execution as separate labels and links to the controls', async () => {
  const { autopilotBar } = await import('../public/components/job-hunt/jh-overview-parts.js');
  const bar = autopilotBar(payload());
  const [mode] = byPart(bar, 'mode'); const [execution] = byPart(bar, 'execution');
  assert.deepEqual([mode.getAttribute('label'), mode.getAttribute('tone')], ['Dry run', 'agent']);
  assert.deepEqual([execution.getAttribute('label'), execution.getAttribute('tone')], ['Running cycle', 'active']);
  assert.equal(byTag(bar, 'a')[0].getAttribute('href'), '#/job-hunt/leads');
  const live = autopilotBar(payload({ autopilot: { mode: 'live', execution: 'degraded', detail: 'score: model unreachable', lastRunAt: null } }));
  assert.deepEqual([byPart(live, 'mode')[0].getAttribute('label'), byPart(live, 'execution')[0].getAttribute('label')], ['Live', 'Degraded']);
  assert.equal(textOf(byPart(live, 'detail')[0]), 'score: model unreachable');
  assert.match(textOf(live), /No cycle has run yet/);
  const none = autopilotBar(payload({ autopilot: null }));
  assert.equal(none.getAttribute('data-autopilot'), 'unavailable');
  assert.match(textOf(none), /— not available/);
});

test('attention items name the company, role and reason, and Review opens the job and the specific question', async () => {
  const { attention } = await import('../public/components/job-hunt/jh-overview-parts.js');
  const node = attention(payload(), NOW);
  const items = all(node, (n) => n.getAttribute('data-job'));
  assert.equal(items.length, 2);
  const [first, second] = items;
  assert.match(textOf(first), /Notion/);
  assert.equal(textOf(byPart(first, 'explanation')[0]), '1 required question could not be answered: Why are you interested?');
  assert.equal(byPart(first, 'review')[0].getAttribute('href'), `#/job-hunt/jobs/${JOB}?question=custom%3Awhy`);
  assert.equal(byPart(second, 'review')[0].getAttribute('href'), '#/job-hunt/jobs/job_fedcba9876543210', 'no question key, so the job page only');
  assert.match(textOf(second), /— · Interview in 2d/, 'unscored shows a dash and the deadline replaces the age');
  assert.match(textOf(first), /90 fit · 2h ago/);
  assert.equal(textOf(byPart(node, 'attention-count')[0]), '2');
});

test('hostile company, role and reason text stays text, and a bad job id gets no link', async () => {
  const { attention, activity } = await import('../public/components/job-hunt/jh-overview-parts.js');
  const evil = payload();
  evil.attention.items = [{ ...evil.attention.items[0], company: HOSTILE, role: HOSTILE, explanation: HOSTILE, question: { key: 'k', label: HOSTILE } }, { ...evil.attention.items[1], jobId: 'javascript:alert(1)' }];
  evil.activity = [{ ...evil.activity[0], company: HOSTILE, role: HOSTILE, label: 'Application sent' }];
  const a = attention(evil, NOW);
  assert.equal(byTag(a, 'img').length + byTag(a, 'script').length, 0);
  assert.ok(textOf(a).includes(HOSTILE));
  assert.equal(byPart(a, 'review').length, 1, 'only the valid job id is linked');
  const b = activity(evil, NOW);
  assert.equal(byTag(b, 'img').length + byTag(b, 'script').length, 0);
  assert.ok(textOf(b).includes(HOSTILE));
});

test('empty attention and activity use jh-state', async () => {
  const { attention, activity } = await import('../public/components/job-hunt/jh-overview-parts.js');
  const empty = payload({ attention: { count: 0, items: [] }, activity: [] });
  const a = byTag(attention(empty, NOW), 'jh-state')[0];
  assert.deepEqual([a.getAttribute('kind'), a.getAttribute('title')], ['empty', 'Nothing needs you right now']);
  assert.equal(byTag(attention(empty, NOW), 'a').length, 0, 'no View all link when nothing is waiting');
  const b = byTag(activity(empty, NOW), 'jh-state')[0];
  assert.deepEqual([b.getAttribute('kind'), b.getAttribute('title')], ['empty', 'No activity yet']);
});

test('recent activity shows labelled events linked to their job, and the application ledger', async () => {
  const { activity } = await import('../public/components/job-hunt/jh-overview-parts.js');
  const node = activity(payload(), NOW);
  const labels = byTag(node, 'jh-status-label');
  assert.deepEqual([labels[0].getAttribute('label'), labels[0].getAttribute('tone')], ['Application sent', 'success']);
  const links = byTag(node, 'a');
  assert.ok(links.some((a) => a.getAttribute('href') === `#/job-hunt/jobs/${JOB}` && textOf(a) === 'Notion — Software Engineer'));
  assert.ok(links.some((a) => a.getAttribute('href') === '#/applications'));
});

function mount(tag = 'u2-job-overview') {
  const node = document.createElement(tag);
  node.isConnected = true;
  node.connectedCallback();
  mounted.push(node);
  return node;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const top = (node) => node.children[0];
const states = (node) => byTag(top(node), 'jh-state');

test('the page shows loading, then the loaded overview with the board kept below', async () => {
  fetchCalls = []; respond = async () => payload();
  const node = mount();
  assert.equal(states(node)[0].getAttribute('kind'), 'loading');
  await settle();
  assert.deepEqual(fetchCalls, ['/api/job-hunt/overview']);
  assert.equal(byTag(top(node), 'jh-summary-card').length, 6);
  assert.equal(byTag(top(node), 'h1')[0].textContent, 'Job Hunt');
  assert.equal(byTag(node, 'u2-job-dashboard').length, 1, 'the previous board is still reachable');
  node.disconnectedCallback();
});

test('a first load failure is an error state whose retry fetches again', async () => {
  fetchCalls = []; let fail = true; respond = async () => (fail ? new Error('database is locked') : payload());
  const node = mount();
  await settle();
  const [error] = states(node);
  assert.deepEqual([error.getAttribute('kind'), error.getAttribute('title'), error.getAttribute('message')], ['error', "Couldn't load the overview", 'database is locked']);
  assert.ok(error.hasAttribute('retry'));
  fail = false;
  error.dispatchEvent(new CustomEvent('jh-retry', { bubbles: true }));
  await settle();
  assert.equal(fetchCalls.length, 2);
  assert.equal(byTag(top(node), 'jh-summary-card').length, 6);
  assert.equal(states(node).filter((s) => s.getAttribute('kind') === 'error').length, 0);
  node.disconnectedCallback();
});

test('a failed refresh keeps the last data and says so', async () => {
  fetchCalls = []; let fail = false; respond = async () => (fail ? new Error('offline') : payload());
  const node = mount();
  await settle();
  fail = true;
  (windowListeners['u2-event'] ?? []).forEach((fn) => fn({ detail: { type: 'agent.action.approved' } }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  await settle();
  assert.equal(byTag(top(node), 'jh-summary-card').length, 6, 'the old numbers stay');
  const banner = states(node).find((s) => s.getAttribute('kind') === 'error');
  assert.equal(banner.getAttribute('title'), 'Showing the last data we loaded');
  assert.match(banner.getAttribute('message'), /offline/);
  node.disconnectedCallback();
});

test('an older response that arrives after a newer one is ignored', async () => {
  fetchCalls = [];
  const pending = [];
  respond = () => new Promise((resolve) => pending.push(resolve));
  const node = mount();                 // request 1
  node._load();                         // request 2 (a refresh)
  const newer = payload({ metrics: payload().metrics.map((m) => (m.id === 'discovered' ? { ...m, value: 5000 } : m)) });
  pending[1](newer);                    // the newer request answers first
  await settle();
  pending[0](payload());                // the stale one answers last (value 4059)
  await settle();
  assert.equal(byTag(top(node), 'jh-summary-card')[0].getAttribute('value'), '5,000');
  node.disconnectedCallback();
});

test('only agent.action events refresh, and leaving the page removes the listener and ignores late responses', async () => {
  fetchCalls = []; const pending = []; respond = () => new Promise((resolve) => pending.push(resolve));
  const node = mount();
  const before = (windowListeners['u2-event'] ?? []).length;
  assert.ok(before >= 1);
  (windowListeners['u2-event'] ?? []).forEach((fn) => fn({ detail: { type: 'calendar.event_changed' } }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(fetchCalls.length, 1, 'an unrelated event does not refresh');
  node.disconnectedCallback();
  assert.equal((windowListeners['u2-event'] ?? []).length, before - 1);
  pending[0](payload());
  await settle();
  assert.equal(byTag(top(node), 'jh-summary-card').length, 0, 'a response after leaving the page is dropped');
});

test('a store with no jobs shows an empty state beside the zeroed summary', async () => {
  fetchCalls = [];
  respond = async () => payload({ metrics: payload().metrics.map((m) => ({ ...m, value: 0 })), attention: { count: 0, items: [] }, activity: [] });
  const node = mount();
  await settle();
  assert.ok(states(node).some((s) => s.getAttribute('title') === 'No jobs yet'));
  assert.deepEqual(byTag(top(node), 'jh-summary-card').map((c) => c.getAttribute('value')), ['0', '0', '0', '0', '0', '0']);
  node.disconnectedCallback();
});
