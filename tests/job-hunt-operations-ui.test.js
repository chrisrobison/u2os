import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// #640: the Agent Operations view and the chat context chip. No DOM library in this repo, so a minimal shim stands in for
// the browser (the approach of tests/job-hunt-overview-ui.test.js).

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
  await import('../public/components/job-hunt/u2-job-operations.js');
  await import('../public/components/u2-agent-context.js');
});

const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().disconnectedCallback?.(); });

after(() => { globalThis.fetch = realFetch; globalThis.setInterval = realSetInterval; });

const all = (root, pred, out = []) => { for (const c of root.children) { if (pred(c)) out.push(c); all(c, pred, out); } return out; };
const byTag = (root, tag) => all(root, (n) => n.tagName === tag.toUpperCase());
const byPart = (root, part) => all(root, (n) => n.getAttribute('data-part') === part);
const textOf = (node) => node.textContent;
const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const JOB = 'job_0123456789abcdef';

function payload(over = {}) {
  return {
    generatedAt: '2026-10-28T12:00:00.000Z',
    autopilot: { mode: 'dry_run', execution: 'running', detail: null, lastRunAt: '2026-10-28T11:55:00.000Z', cycleRunning: true, lastCycle: { startedAt: '2026-10-28T11:50:00.000Z', finishedAt: '2026-10-28T11:55:00.000Z', mode: 'dry_run', actions: 3, needsYou: 1, errors: 0 }, settingsChangedAt: null },
    running: { count: 1, items: [{ id: 'act_1', tool: 'jobs.submit_application', label: 'Submit application form', status: 'executing', requestedBy: 'job-autopilot', jobId: JOB, company: 'Notion', role: 'Engineer', attempts: 2, since: '2026-10-28T11:58:00.000Z' }] },
    awaitingApproval: { count: 2, items: [
      { id: 'act_2', tool: 'jobs.send_application', label: 'Send application email', status: 'pending', requestedBy: 'job-autopilot', jobId: JOB, company: 'Notion', role: 'Engineer', since: '2026-10-28T10:00:00.000Z' },
      { id: 'act_3', tool: 'email.send', label: 'Send email', status: 'pending', requestedBy: 'owner', jobId: null, company: null, role: null, since: '2026-10-28T09:00:00.000Z' },
    ] },
    recent: [{ id: 'act_4', tool: 'jobs.send_application', label: 'Send application email', status: 'executed', requestedBy: 'job-autopilot', jobId: JOB, company: 'Notion', role: 'Engineer', at: '2026-10-28T08:00:00.000Z' }],
    failures: [
      { source: 'autopilot', id: null, label: 'Autopilot cycle', status: 'error', at: '2026-10-28T11:55:00.000Z', message: 'score: model timeout', jobId: null, company: null, role: null },
      { source: 'action', id: 'act_5', tool: 'jobs.submit_application', label: 'Submit application form', status: 'failed', at: '2026-10-28T07:00:00.000Z', message: HOSTILE, jobId: JOB, company: HOSTILE, role: null },
    ],
    lastActivity: { autopilotCycleAt: '2026-10-28T11:55:00.000Z', lastActionAt: '2026-10-28T08:00:00.000Z', lastFailureAt: '2026-10-28T11:55:00.000Z' },
    ...over,
  };
}
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const mount = (tag = 'u2-job-operations') => { const node = document.createElement(tag); node.isConnected = true; node.connectedCallback(); mounted.push(node); return node; };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const body = (node) => node.children[1];
const states = (node) => byTag(body(node), 'jh-state');

test('the model maps statuses to labels and never invents a value', async () => {
  const m = await import('../public/components/job-hunt/jh-operations-model.js');
  assert.deepEqual(m.statusOf('pending'), ['attention', 'Awaiting approval']);
  assert.deepEqual(m.statusOf('executed'), ['success', 'Done']);
  assert.deepEqual(m.statusOf('retry_wait'), ['attention', 'Waiting to retry']);
  assert.deepEqual(m.statusOf('something_new'), ['neutral', 'something new']);
  assert.deepEqual(m.statusOf(null), ['neutral', '—']);
  assert.equal(m.jobLabel({ company: 'Notion', role: 'Engineer' }), 'Notion — Engineer');
  assert.equal(m.jobLabel({ company: 'Notion', role: null }), 'Notion');
  assert.equal(m.jobLabel({}), '—');
  assert.equal(m.countText(null), '—');
  assert.equal(m.countText(0), '0');
  assert.equal(m.rowJobHref({ jobId: 'javascript:alert(1)' }), null);
  assert.match(m.liveSummary(payload()), /1 running, 2 awaiting your approval, 2 recent failures/);
  assert.equal(m.liveSummary(null), '');
});

test('the autopilot panel shows mode, status and the last cycle from the data, with dashes for the unknown', async () => {
  const { autopilotPanel } = await import('../public/components/job-hunt/jh-operations-parts.js');
  const panel = autopilotPanel(payload());
  assert.deepEqual([byPart(panel, 'mode')[0].getAttribute('label'), byPart(panel, 'execution')[0].getAttribute('label')], ['Dry run', 'Running cycle']);
  assert.match(textOf(byPart(panel, 'mode-note')[0]), /sends nothing/);
  assert.match(textOf(panel), /Actions in that cycle3/);
  assert.match(textOf(panel), /Settings last changed—/);
  const none = autopilotPanel(payload({ autopilot: { mode: 'paused', execution: 'idle', detail: null, lastRunAt: null, cycleRunning: false, lastCycle: null, settingsChangedAt: null } }));
  assert.match(textOf(none), /Actions in that cycle—/);
  assert.equal(textOf(byPart(none, 'last-cycle')[0]), '—');
  const missing = autopilotPanel(payload({ autopilot: null }));
  assert.equal(byTag(missing, 'a').length, 0);
  assert.match(textOf(missing), /not available/);
});

test('approvals link to the existing approval page and the job; running and recent rows name their job', async () => {
  const { approvalsPanel, runningPanel, recentPanel } = await import('../public/components/job-hunt/jh-operations-parts.js');
  const approvals = approvalsPanel(payload(), NOW);
  assert.equal(textOf(byPart(approvals, 'approval-count')[0]), '2');
  assert.equal(byPart(approvals, 'approvals-link')[0].getAttribute('href'), '#/operations');
  assert.deepEqual(byTag(approvals, 'a').map((a) => a.getAttribute('href')).filter((h) => h.includes('/jobs/')), [`#/job-hunt/jobs/${JOB}`]);
  assert.match(textOf(approvals), /Send application email/);
  assert.match(textOf(approvals), /—/, 'an approval with no job shows a dash');
  const running = runningPanel(payload(), NOW);
  assert.match(textOf(running), /Submit application form/);
  assert.match(textOf(running), /attempt 2/);
  assert.deepEqual([byTag(running, 'jh-status-label')[0].getAttribute('label')], ['Running']);
  assert.match(textOf(recentPanel(payload(), NOW)), /Notion — Engineer/);
  const empty = approvalsPanel(payload({ awaitingApproval: { count: 0, items: [] } }), NOW);
  assert.equal(byTag(empty, 'a').length, 0, 'no review link when nothing waits');
  assert.equal(byTag(empty, 'jh-state')[0].getAttribute('kind'), 'empty');
  assert.match(textOf(approvalsPanel(payload({ awaitingApproval: { count: 30, items: payload().awaitingApproval.items } }), NOW)), /Showing 2 of 30/);
});

test('hostile company and error text stays text', async () => {
  const { failuresPanel } = await import('../public/components/job-hunt/jh-operations-parts.js');
  const panel = failuresPanel(payload(), NOW);
  assert.equal(byTag(panel, 'img').length + byTag(panel, 'script').length, 0);
  assert.ok(textOf(panel).includes(HOSTILE));
  assert.match(textOf(panel), /score: model timeout/);
  const none = failuresPanel(payload({ failures: [] }), NOW);
  assert.equal(byTag(none, 'jh-state')[0].getAttribute('title'), 'No recent failures');
});

test('the page has no control: only links (and the retry of a failed load) are interactive', async () => {
  fetchCalls = []; respond = async () => payload();
  const node = mount();
  await settle();
  assert.deepEqual(fetchCalls, ['/api/job-hunt/operations']);
  assert.equal(byTag(node, 'h1')[0].textContent, 'Agent Operations');
  assert.equal(byTag(node, 'button').length + byTag(node, 'input').length + byTag(node, 'select').length + byTag(node, 'form').length, 0);
  assert.ok(byTag(node, 'a').every((a) => /^#\//.test(a.getAttribute('href'))));
  assert.ok(!byTag(node, 'a').some((a) => /approve|reject|autopilot\/run/.test(a.getAttribute('href'))));
  node.disconnectedCallback();
});

test('loading, then data; a first failure retries; a failed refresh keeps the last data and says so', async () => {
  fetchCalls = []; let fail = true; respond = async () => (fail ? new Error('database is locked') : payload());
  const node = mount();
  assert.equal(states(node)[0].getAttribute('kind'), 'loading');
  await settle();
  const [error] = states(node);
  assert.deepEqual([error.getAttribute('kind'), error.getAttribute('title'), error.getAttribute('message')], ['error', "Couldn't load agent operations", 'database is locked']);
  fail = false;
  error.dispatchEvent(new CustomEvent('jh-retry', { bubbles: true }));
  await settle();
  assert.equal(byPart(body(node), 'approval-count')[0].textContent, '2');
  fail = true;
  (windowListeners['u2-event'] ?? []).forEach((fn) => fn({ detail: { type: 'agent.action.failed' } }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  await settle();
  assert.equal(byPart(body(node), 'approval-count')[0].textContent, '2', 'the old numbers stay');
  assert.equal(states(node).find((s) => s.getAttribute('kind') === 'error').getAttribute('title'), 'Showing the last data we loaded');
  node.disconnectedCallback();
});

test('a change is announced in the live region, an unchanged poll is not, and only agent.action events refresh', async () => {
  fetchCalls = []; let data = payload(); respond = async () => data;
  const node = mount();
  await settle();
  const live = byPart(node, 'live')[0];
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(textOf(live), '', 'the first load is not announced');
  (windowListeners['u2-event'] ?? []).forEach((fn) => fn({ detail: { type: 'calendar.event_changed' } }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(fetchCalls.length, 1, 'an unrelated event does not refresh');
  data = payload({ awaitingApproval: { count: 3, items: payload().awaitingApproval.items } });
  (windowListeners['u2-event'] ?? []).forEach((fn) => fn({ detail: { type: 'agent.action.proposed' } }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  await settle();
  assert.match(textOf(live), /3 awaiting your approval/);
  const announced = textOf(live);
  live.textContent = '';
  (windowListeners['u2-event'] ?? []).forEach((fn) => fn({ detail: { type: 'agent.action.completed' } }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  await settle();
  assert.equal(textOf(live), '', `no repeat of "${announced}" when nothing changed`);
  node.disconnectedCallback();
});

test('an older response is ignored; leaving the page removes the listener and drops late answers', async () => {
  fetchCalls = []; const pending = []; respond = () => new Promise((resolve) => pending.push(resolve));
  const node = mount();
  node._load();
  pending[1](payload({ awaitingApproval: { count: 9, items: [] } }));
  await settle();
  pending[0](payload());
  await settle();
  assert.equal(byPart(body(node), 'approval-count')[0].textContent, '9');
  const before = (windowListeners['u2-event'] ?? []).length;
  node.disconnectedCallback();
  assert.equal((windowListeners['u2-event'] ?? []).length, before - 1);
});

test('a view with nothing recorded shows empty states and dashes, not zeros it invented', async () => {
  fetchCalls = [];
  respond = async () => payload({ autopilot: null, running: { count: 0, items: [] }, awaitingApproval: { count: 0, items: [] }, recent: [], failures: [], lastActivity: { autopilotCycleAt: null, lastActionAt: null, lastFailureAt: null } });
  const node = mount();
  await settle();
  assert.deepEqual(states(node).map((s) => s.getAttribute('title')), ['Nothing is waiting for you', 'Nothing is running', 'No recent failures', 'No agent actions yet']);
  assert.equal(textOf(byPart(node, 'last-action-at')[0]), '—');
  node.disconnectedCallback();
});

// ---- the context chip -------------------------------------------------------------------

const chipOf = (chip) => byTag(chip, 'div').find((n) => n.getAttribute('role') === 'group');

test('the chip states which job is attached, exposes only { kind, jobId } and announces itself', () => {
  const chip = mount('u2-agent-context');
  assert.equal(chip.value, null);
  assert.equal(chip.attach({ kind: 'job', jobId: JOB, label: 'Notion — Engineer' }), true);
  assert.deepEqual(chip.value, { kind: 'job', jobId: JOB });
  assert.equal(textOf(byTag(chip, 'span').find((s) => s.getAttribute('class') === 'agent-context__text')), 'Job context: Notion — Engineer');
  const remove = byTag(chip, 'button')[0];
  assert.equal(remove.getAttribute('aria-label'), 'Remove job context: Notion — Engineer');
  assert.equal(remove.getAttribute('type'), 'button');
  const live = byTag(chip, 'span').find((s) => s.getAttribute('role') === 'status');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.match(textOf(live), /Job context attached: Notion — Engineer/);
  assert.equal(chip.hidden, false);
});

test('the chip refuses anything but a known kind and a real job id, and shows hostile labels as text', () => {
  const chip = mount('u2-agent-context');
  for (const bad of [{}, { kind: 'mail', jobId: JOB }, { kind: 'job', jobId: 'nope' }, { kind: 'job', jobId: `${JOB}x` }, null, undefined]) assert.equal(chip.attach(bad), false);
  assert.equal(chip.value, null);
  assert.equal(chip.hidden, true);
  assert.equal(chip.attach({ kind: 'job', jobId: JOB, label: HOSTILE }), true);
  assert.equal(byTag(chip, 'img').length + byTag(chip, 'script').length, 0);
  assert.ok(textOf(chip).includes('<img'));
});

test('removing the chip: the button, Delete and Backspace each clear it, tell the host and announce it', () => {
  for (const how of ['click', 'Delete', 'Backspace']) {
    const chip = mount('u2-agent-context');
    let removed = 0;
    chip.addEventListener('u2-agent-context-removed', () => { removed += 1; });
    chip.attach({ kind: 'job', jobId: JOB, label: 'Notion' });
    if (how === 'click') byTag(chip, 'button')[0].click();
    else chipOf(chip).dispatchEvent(new Ev('keydown', { bubbles: true, key: how }));
    assert.equal(chip.value, null, how);
    assert.equal(removed, 1, how);
    assert.equal(chip.hidden, true);
    assert.match(textOf(byTag(chip, 'span').find((s) => s.getAttribute('role') === 'status')), /Context removed/);
  }
  const chip = mount('u2-agent-context');
  chipOf(chip).dispatchEvent(new Ev('keydown', { bubbles: true, key: 'a' }));
  chip.attach({ kind: 'job', jobId: JOB });
  chipOf(chip).dispatchEvent(new Ev('keydown', { bubbles: true, key: 'a' }));
  assert.deepEqual(chip.value, { kind: 'job', jobId: JOB }, 'other keys do nothing');
});

test('the chat API helper sends context only when one is attached', async () => {
  const { sendAgentMessage } = await import('../public/services/api.js');
  const bodies = [];
  const keep = globalThis.fetch;
  globalThis.fetch = async (url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    await sendAgentMessage('hi', 'conv_1');
    await sendAgentMessage('hi', 'conv_1', { kind: 'job', jobId: JOB });
  } finally { globalThis.fetch = keep; }
  assert.deepEqual(bodies, [{ text: 'hi', conversationId: 'conv_1' }, { text: 'hi', conversationId: 'conv_1', context: { kind: 'job', jobId: JOB } }]);
});
