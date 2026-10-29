import { test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// #634: the job detail panel (and the Opportunities page that hosts it). No DOM library in this repo, so a minimal shim
// stands in for the browser (the pattern of tests/job-hunt-opportunities-ui.test.js). The shim does not run
// connectedCallback on children, so tests connect the elements they click in.

class Ev { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.detail = init.detail; this.key = init.key; this.target = null; this.defaultPrevented = false; } preventDefault() { this.defaultPrevented = true; } stopPropagation() { this.stopped = true; } }
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
  constructor(tag = 'custom-element') { super(); this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.listeners = {}; this.isConnected = true; this.value = ''; this.style = { setProperty() {} }; this.classList = { add: (...c) => { const s = new Set((this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); this.attrs.set('class', [...s].join(' ')); }, contains: (c) => (this.attrs.get('class') ?? '').split(/\s+/).includes(c), remove: () => {}, toggle: () => {} }; }
  get children() { return this.childNodes.filter((n) => n instanceof ElementShim); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = [new TextShim(v)]; }
  append(...nodes) { for (const n of nodes) { const node = typeof n === 'string' ? new TextShim(n) : n; node.parentNode?.childNodes && (node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node)); node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this); }
  setAttribute(k, v) { const old = this.attrs.get(k) ?? null; this.attrs.set(k, String(v)); if (this.constructor.observedAttributes?.includes(k)) this.attributeChangedCallback?.(k, old, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); if (this.constructor.observedAttributes?.includes(k)) this.attributeChangedCallback?.(k, null, null); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : force; if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  dispatchEvent(e) { e.target ??= this; for (let n = this; n; n = e.bubbles && !e.stopped ? n.parentNode : null) for (const fn of n.listeners?.[e.type] ?? []) fn(e); return true; }
  descendants(out = []) { for (const c of this.children) { out.push(c); c.descendants(out); } return out; }
  querySelectorAll(selector) { const sels = selector.split(',').map((s) => s.trim()); return this.descendants().filter((n) => sels.some((s) => matchesSimple(n, s))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { const sels = selector.split(',').map((s) => s.trim()); for (let n = this; n instanceof ElementShim; n = n.parentNode) if (sels.some((s) => matchesSimple(n, s))) return n; return null; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  focus() { document.activeElement = this; this.dispatchEvent(new Ev('focusin', { bubbles: true })); }
  click() { this.dispatchEvent(new Ev('click', { bubbles: true })); }
  showModal() { queueMicrotask(() => (dialogAnswer ? this.querySelector('[data-confirm]') : this.querySelectorAll('button')[1])?.click()); }
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
    sessionStorage: (() => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), clear: () => data.clear() }; })(),
    matchMedia: () => ({ matches: false }),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
      const body = await respond(String(url), options);
      if (body?.__status) { const { __status: status, ...rest } = body; return { ok: false, status, statusText: 'Error', text: async () => JSON.stringify(rest) }; }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  await import('../public/components/job-hunt/u2-job-opportunities.js');
});

after(() => { globalThis.fetch = realFetch; });

const mounted = [];
beforeEach(() => { fetchCalls = []; urlWrites.length = 0; window.location.hash = ''; document.activeElement = null; document.body.childNodes = []; dialogAnswer = true; sessionStorage.clear(); respond = async () => ({}); });
afterEach(() => { while (mounted.length) mounted.pop().disconnectedCallback?.(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 8; i += 1) await sleep(0); };
const J = (n) => `job_${String(n).padStart(16, '0')}`;
const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const press = (target, key) => { const e = new Ev('keydown', { bubbles: true, key }); target.dispatchEvent(e); return e; };

/** A full GET /api/job-hunt/jobs/:id answer. */
function jobFixture(n = 1, over = {}) {
  return {
    id: J(n), company: `Company ${n}`, role: `Engineer ${n}`, status: 'qualified', locations: ['Oakland, CA'], remote: true, salary: '$180K - $220K',
    technologies: ['Node', 'SQLite'], contactEmails: ['hire@example.com'], applicationUrls: ['https://jobs.example.com/apply/1'], companyUrl: 'https://example.com', firstSeenAt: '2026-10-02T00:00:00.000Z',
    score: { score: 88, label: 'strong', confidence: 0.8, degraded: false, model: 'claude-x', scoredAt: '2026-10-03T00:00:00.000Z', narrative: 'staff-principal', reasons: ['Direct overlap with agent systems'], concerns: ['Team size unclear'], projects: [{ name: 'u2', url: 'https://github.com/me/u2', why: 'An agent runtime' }], flags: [] },
    dimensions: { experience: { points: 22, max: 25, reason: 'Ten years of backend work' }, technical: { points: 14, max: 15, reason: 'Node and SQLite match' }, seniority: { points: 6, max: 20, reason: 'Level unclear' }, location: { points: 8, max: 10, reason: 'Remote, US-compatible' }, compensation: { points: 5, max: 5, reason: 'Range $180K - $220K meets the minimum' } },
    strategy: { name: 'DIRECT_EMAIL', reason: 'The listing has an email address.' }, draft: null, materials: [], emails: [],
    sources: [{ source: 'hackernews', author: 'pat', url: 'https://news.ycombinator.com/item?id=1', postedAt: '2026-10-01T12:00:00.000Z', rawText: 'text' }],
    events: [{ id: 1, at: '2026-10-02T00:00:00.000Z', type: 'status', fromStatus: null, toStatus: 'qualified' }],
    applications: [], reviews: [], contacts: [], tasks: [], interviews: [], attention: { needsYou: false, reasons: [] }, sendRoutes: { gmail: true, apple_mail: false, apple_mail_draft: false },
    ...over,
  };
}
const plannedApplication = (over = {}) => ({ id: 7, url: 'https://jobs.example.com/apply/1', status: 'planned', planHash: 'abc123', createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z', plan: { ready: true, needs: [], blockers: [], unresolved: [], fields: [{ label: 'Email', required: true, origin: 'profile', value: 'pat@example.com' }] }, result: { outcome: null, reason: null, errors: [], at: null, screenshots: [] }, ...over });

const answerFor = (map) => async (url, options) => {
  const key = Object.keys(map).find((k) => url.includes(k) && (!k.includes(' ') || true));
  const value = key ? map[key] : {};
  return typeof value === 'function' ? value(url, options) : value;
};

async function mountPanel() {
  await import('../public/components/job-hunt/u2-job-detail-panel.js');
  const panel = new (registry.get('u2-job-detail-panel'))();
  mounted.push(panel);
  panel.connectedCallback();
  return panel;
}
const part = (root, name) => root.querySelector(`[data-part="${name}"]`);
const tabBody = (panel) => panel.querySelector('[role="tabpanel"]');
const textOf = (node) => node?.textContent ?? '';
const statusOf = (root) => part(root, 'status')?.getAttribute('label');

// ---- model -------------------------------------------------------------------------

test('the selected job lives in the hash next to the table state, and only a real job id is believed', async () => {
  const m = await import('../public/components/job-hunt/jh-detail-model.js');
  assert.equal(m.jobFromHash(`#/job-hunt/opportunities?filter=ready&job=${J(5)}&page=2`), J(5));
  assert.equal(m.jobFromHash('#/job-hunt/opportunities?job=../../etc/passwd'), null);
  assert.equal(m.jobFromHash('#/job-hunt/opportunities?job=job_ABCDEF0123456789'), null);
  assert.equal(m.jobFromHash('#/job-hunt/opportunities'), null);
  assert.equal(m.withJobInHash('#/job-hunt/opportunities?filter=ready&q=a%20b&statuses=applied,contacted', J(3)), `#/job-hunt/opportunities?filter=ready&q=a+b&statuses=applied,contacted&job=${J(3)}`);
  assert.equal(m.withJobInHash(`#/job-hunt/opportunities?filter=ready&job=${J(3)}`, null), '#/job-hunt/opportunities?filter=ready');
  assert.equal(m.withJobInHash('#/job-hunt/opportunities', J(3)), `#/job-hunt/opportunities?job=${J(3)}`);
  assert.equal(m.withJobInHash('#/job-hunt/opportunities', 'nope'), '#/job-hunt/opportunities');
});

test('the primary action is derived from the job\'s real state', async () => {
  const m = await import('../public/components/job-hunt/jh-detail-model.js');
  const { jobActions } = await import('../public/components/job-hunt/u2-job-actions.js');
  const pick = (job) => m.primaryAction(job, jobActions(job));
  const question = { key: 'q1', label: 'Why us?', required: true };
  assert.equal(pick(jobFixture(1, { materials: [{ kind: 'resume', file: 'r.pdf' }] }))?.type, 'link', 'prepared and nothing waiting: open the posting');
  assert.equal(pick(jobFixture(1))?.label, 'Prepare application', 'nothing prepared yet');
  assert.deepEqual(pick(jobFixture(1, { applications: [plannedApplication({ status: 'needs_input', plan: { ready: false, needs: [], blockers: [], unresolved: [question], fields: [] } })] })), { key: 'answers', label: 'Answer questions (1)', type: 'answers' });
  assert.equal(pick(jobFixture(1, { applications: [plannedApplication()] }))?.type, 'review');
  assert.equal(pick(jobFixture(1, { applications: [plannedApplication({ status: 'failed', plan: { ready: false, needs: [], blockers: [], unresolved: [], fields: [] } })] }))?.label, 'Retry planning');
  assert.equal(pick(jobFixture(1, { status: 'applied' }))?.type, 'link', 'a settled job offers nothing to start');
  assert.equal(pick(jobFixture(1, { status: 'applied', applicationUrls: [], sources: [] })), null);
  assert.equal(pick(jobFixture(1, { applicationUrls: ['javascript:alert(1)'], sources: [], materials: [{ kind: 'resume', file: 'r.pdf' }] })), null, 'an unsafe link is never offered');
  const menu = m.menuActions(jobFixture(1), jobActions(jobFixture(1)), { key: 'online' });
  assert.equal(menu.some((item) => item.key === 'online'), false, 'the primary action is not repeated in the menu');
  assert.equal(menu.find((item) => item.key === 'reject').label, 'Mark not interested');
});

test('Match Analysis classifies only from stored data and never mixes missing evidence with a gap', async () => {
  const { matchAnalysis } = await import('../public/components/job-hunt/jh-detail-model.js');
  const base = matchAnalysis(jobFixture(1));
  assert.deepEqual(base.verified.map((item) => item.kind).sort(), ['project', 'rule', 'rule']);
  assert.equal(base.verified.find((item) => item.kind === 'project').sourceUrl, 'https://github.com/me/u2');
  const judged = base.unverified.filter((item) => item.kind === 'judged');
  assert.equal(judged.length, 3, 'model-judged dimensions have no stored source, so none is verified');
  assert.match(judged[0].note, /No source for this claim is stored/);
  assert.equal(base.gaps.length, 0);
  assert.equal(base.overall.confidence, 80);

  const gappy = matchAnalysis(jobFixture(1, {
    score: { ...jobFixture(1).score, flags: ['relocation_required', 'salary_below_threshold'], concerns: ['On-site in Austin, outside the Bay Area: relocation required', 'Top of range ($90K) is below your minimum', 'Scored by rules without a model; capped below the autonomous threshold', 'Visa policy unclear'] },
    dimensions: { location: { points: 1, max: 10, reason: 'On-site away from home' }, compensation: { points: 0, max: 5, reason: 'Compensation below the minimum' } },
  }));
  assert.deepEqual(gappy.gaps.map((gap) => gap.text), ['On-site away from home', 'Compensation below the minimum']);
  assert.deepEqual(gappy.unverified.map((item) => item.text), ['Visa policy unclear'], 'rule concerns are shown once, as gaps; the rules-only caveat is not a requirement');

  const missing = matchAnalysis(jobFixture(1, { dimensions: { location: { points: 5, max: 10, reason: 'Location not stated' }, compensation: { points: 3, max: 5, reason: 'Compensation not stated' } }, score: { ...jobFixture(1).score, flags: ['relocation_required'], projects: [], concerns: [] } }));
  assert.equal(missing.gaps.length, 0, 'a posting that says nothing is not a gap');
  assert.equal(missing.unverified.length, 2);
  assert.match(missing.unverified[0].note, /not a gap/);

  const reviewed = matchAnalysis(jobFixture(1, {
    reviews: [{ id: 3, kind: 'application', decision: 'reject', model: 'm', createdAt: '2026-10-05T00:00:00.000Z', notes: '', concerns: [{ severity: 'minor', text: 'Resume gap year' }],
      checks: [{ name: 'form_answers_supported_by_facts', pass: false, detail: 'Kubernetes' }, { name: 'materials_claims_supported', pass: true }, { name: 'no_relocation_unless_allowed', pass: false, detail: 'Berlin' }] }],
    applications: [plannedApplication({ status: 'needs_input', plan: { ready: false, needs: [], blockers: [], unresolved: [{ key: 'k', label: 'Years of Rust' }], fields: [] } })],
  }));
  const unsupported = reviewed.unverified.find((item) => item.kind === 'unsupported');
  assert.match(unsupported.text, /not supported by your facts: Kubernetes/);
  assert.match(unsupported.note, /missing evidence, not proof/);
  assert.ok(reviewed.verified.some((item) => /claim nothing your facts do not support/.test(item.text) && /Review of 2026-10-05/.test(item.source)));
  assert.ok(reviewed.gaps.some((gap) => /relocation/.test(gap.text)));
  assert.ok(reviewed.unverified.some((item) => item.text === 'No answer on file: Years of Rust'));
  assert.ok(reviewed.unverified.some((item) => item.text === 'Resume gap year'));

  const degraded = matchAnalysis(jobFixture(1, { score: { ...jobFixture(1).score, degraded: true, confidence: null, model: null } }));
  assert.equal(degraded.overall.confidence, null, 'confidence is shown only when stored');
  assert.ok(degraded.caveats.length);
  assert.equal(matchAnalysis(jobFixture(1, { score: null })).scored, false);
});

// ---- panel -------------------------------------------------------------------------

test('the header shows what is stored, the heading takes focus on open, and a deep link does not steal it', async () => {
  respond = answerFor({ '/api/job-hunt/jobs/': jobFixture(1) });
  const panel = await mountPanel();
  await panel.show(J(1), { focus: true });
  await flush();
  assert.equal(textOf(part(panel, 'company')), 'Company 1');
  assert.equal(textOf(part(panel, 'heading')), 'Engineer 1');
  assert.equal(textOf(part(panel, 'fit')), '88% fit');
  assert.equal(statusOf(panel), 'Qualified');
  assert.equal(textOf(part(panel, 'meta')), 'Oakland, CA · Remote · $180K - $220K · Posted Oct 1, 2026');
  assert.equal(part(panel, 'posting').getAttribute('href'), 'https://jobs.example.com/apply/1');
  assert.equal(part(panel, 'posting').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(part(panel, 'full-page').getAttribute('href'), `#/job-hunt/jobs/${J(1)}`);
  assert.equal(document.activeElement, part(panel, 'heading'), 'focus is on the heading');
  assert.equal(panel.getAttribute('aria-labelledby'), 'jh-detail-title');

  document.activeElement = null;
  const quiet = await mountPanel();
  await quiet.show(J(1));
  await flush();
  assert.equal(document.activeElement, null, 'no focus change without an owner action');
});

test('missing data is shown as missing: no score, no location, no pay, no posting link', async () => {
  respond = answerFor({ '/api/job-hunt/jobs/': jobFixture(1, { score: null, dimensions: {}, locations: [], remote: null, salary: null, applicationUrls: [], sources: [], events: [] }) });
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  assert.equal(textOf(part(panel, 'fit')), 'Not scored');
  assert.equal(textOf(part(panel, 'meta')), 'No location, pay or date stored.');
  assert.equal(part(panel, 'posting'), null);
  assert.match(textOf(tabBody(panel)), /has not been scored yet/);
  panel.querySelector('[data-tab="match"]').click();
  assert.equal(tabBody(panel).querySelector('jh-state').getAttribute('title'), 'Not scored yet');
});

test('the tabs are an ARIA tablist with one tab stop and arrow-key navigation', async () => {
  respond = answerFor({ '/api/job-hunt/jobs/': jobFixture(1) });
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  const list = panel.querySelector('[role="tablist"]');
  const tabs = list.querySelectorAll('[role="tab"]');
  assert.deepEqual(tabs.map((tab) => tab.textContent), ['Overview', 'Match Analysis', 'Application', 'Company', 'Notes']);
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false', 'false', 'false', 'false']);
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1']);
  assert.equal(tabBody(panel).getAttribute('aria-labelledby'), 'jh-detail-tab-overview');
  tabs[0].focus();
  press(tabs[0], 'ArrowRight');
  assert.equal(panel.tab, 'match');
  assert.equal(document.activeElement.getAttribute('data-tab'), 'match');
  assert.equal(tabBody(panel).getAttribute('aria-labelledby'), 'jh-detail-tab-match');
  press(document.activeElement, 'End');
  assert.equal(panel.tab, 'notes');
  press(document.activeElement, 'ArrowRight');
  assert.equal(panel.tab, 'overview', 'wraps around');
  press(document.activeElement, 'ArrowLeft');
  assert.equal(panel.tab, 'notes');
});

test('Overview and Match Analysis render the classification, sources and honest limits, with no numeric bars', async () => {
  respond = answerFor({ '/api/job-hunt/jobs/': jobFixture(1, { applications: [plannedApplication({ status: 'needs_input', plan: { ready: false, needs: [], blockers: [], unresolved: [{ key: 'k', label: 'Years of Rust' }], fields: [] } })], attention: { needsYou: true, reasons: [{ kind: 'needs_answers', title: '1 required question could not be answered', items: ['Years of Rust: U2OS has no answer'], action: 'Answer it.' }] } }) });
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  let text = textOf(tabBody(panel));
  assert.match(text, /Why this is a strong match/);
  assert.match(text, /Direct overlap with agent systems/);
  assert.match(text, /Gaps to address/);
  assert.match(text, /Team size unclear/);
  assert.match(text, /1 required question could not be answered/);
  panel.querySelector('[data-goto-tab="match"]').click();
  assert.equal(panel.tab, 'match');
  const body = tabBody(panel);
  assert.match(textOf(part(body, 'overall')), /Overall fit 88% \(Strong\) · scorer confidence 80% · model claude-x/);
  const group = (id) => body.querySelector(`[data-match="${id}"]`);
  assert.deepEqual(['verified', 'unverified', 'gaps'].map((id) => textOf(group(id).querySelector('h3'))), ['Verified match1', 'Unverified or insufficient evidence5', 'Confirmed gap0'].map((x, i) => x.replace(/\d+$/, ['3', '5', '0'][i]) ));
  assert.match(textOf(group('verified')), /Related project of yours: u2/);
  assert.equal(group('verified').querySelector('a').getAttribute('href'), 'https://github.com/me/u2');
  assert.match(textOf(group('unverified')), /No answer on file: Years of Rust/);
  assert.match(textOf(group('gaps')), /No gap is confirmed by a rule/);
  assert.match(textOf(body.querySelector('details')), /not split into individual requirements/);
  assert.equal(body.querySelectorAll('progress, meter, [role="progressbar"]').length, 0, 'no per-requirement bars');
  assert.doesNotMatch(textOf(body), /\b22\/25\b|\b14\/15\b/, 'dimension points are not shown as per-skill scores');
});

test('Application and Company tabs render real data, a shared approval box and a limited history; unsafe links are dropped', async () => {
  const job = jobFixture(1, {
    companyUrl: 'javascript:alert(1)', materials: [{ kind: 'resume', file: 'Pat_Resume.pdf' }], draft: { to: 'hire@example.com', subject: 'Hello', text: `Hi ${HOSTILE}`, attachments: [], needsInput: [] },
    applications: [plannedApplication()], reviews: [{ id: 3, kind: 'application', decision: 'approve', checks: [], concerns: [], notes: '', model: 'm', createdAt: '2026-10-05T00:00:00.000Z' }],
    events: Array.from({ length: 40 }, (_, i) => ({ id: i, at: '2026-10-02T00:00:00.000Z', type: 'status', fromStatus: null, toStatus: i === 39 ? 'qualified' : 'scored' })),
    contacts: [{ name: 'Rae', email: 'rae@example.com', roleKind: 'recruiter' }],
    sources: [{ source: 'hackernews', author: 'pat', url: 'javascript:alert(2)', postedAt: '2026-10-01T12:00:00.000Z', rawText: '' }, { source: 'greenhouse', author: null, url: 'https://boards.example.com/1', postedAt: null, rawText: '' }],
  });
  respond = answerFor({ '/api/job-hunt/jobs/': job });
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  panel.querySelector('[data-tab="application"]').click();
  let body = tabBody(panel);
  assert.match(textOf(body), /Qualified · latest attempt Planned/);
  assert.ok(body.querySelector('[data-submit-box]'), 'the Ready to submit box (with its two-step approval) is the shared component');
  assert.match(textOf(part(body, 'review')), /Latest review: approved/);
  assert.match(textOf(body), /resume: Pat_Resume\.pdf/i);
  assert.equal(part(body, 'history').children.length, 25, 'history is capped');
  assert.match(textOf(part(body, 'history').children[0]), /Qualified/, 'newest first');
  assert.equal(body.querySelectorAll('img, script').length, 0, 'hostile draft text stays text');
  assert.ok(textOf(body).includes(HOSTILE));
  panel.querySelector('[data-tab="company"]').click();
  body = tabBody(panel);
  assert.equal(body.querySelectorAll('a').filter((a) => /^javascript:/i.test(a.getAttribute('href') ?? '')).length, 0);
  assert.deepEqual(part(body, 'sources').children.map((li) => li.textContent), ['Hackernews · pat · Oct 1, 2026', 'Greenhouse ↗']);
  assert.match(textOf(body), /Rae <rae@example.com> · Recruiter/);
  assert.match(textOf(body), /does not store research about a company yet/);
  assert.match(textOf(body), /No company site is stored/);
});

test('hostile company, role and notes text is always text', async () => {
  respond = answerFor({ '/notes': { jobId: J(1), path: 'x', exists: true, body: HOSTILE, revision: 'a'.repeat(64), updatedAt: null, maxBytes: 65536 }, '/api/job-hunt/jobs/': jobFixture(1, { company: HOSTILE, role: HOSTILE, score: { ...jobFixture(1).score, reasons: [HOSTILE], concerns: [HOSTILE] } }) });
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  assert.equal(panel.descendants().filter((node) => ['IMG', 'SCRIPT'].includes(node.tagName)).length, 0);
  assert.equal(textOf(part(panel, 'heading')), HOSTILE);
  assert.equal(panel.querySelector('textarea').value, HOSTILE);
});

test('an answer that arrives after the owner moved on is ignored; a missing job and a failed load explain themselves', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve(jobFixture(1)), 30));
  respond = async (url) => (url.includes(J(1)) ? slow : jobFixture(2));
  const panel = await mountPanel();
  const first = panel.show(J(1));
  await sleep(1);
  await panel.show(J(2));
  await first;
  await sleep(50);
  assert.equal(panel.jobId, J(2));
  assert.equal(textOf(part(panel, 'heading')), 'Engineer 2', 'the late answer for job 1 did not replace job 2');

  respond = async () => ({ __status: 404, error: 'No such job' });
  await panel.show(J(3));
  await flush();
  assert.equal(textOf(part(panel, 'heading')), 'Job not found');
  assert.match(panel.querySelector('jh-state').getAttribute('message'), /no longer exists/);
  assert.equal(panel.querySelector('[data-detail-action="retry"]'), null, 'nothing to retry for a deleted job');

  let calls = 0;
  respond = async () => { calls += 1; return calls === 1 ? { __status: 500, error: 'boom' } : jobFixture(4); };
  await panel.show(J(4));
  await flush();
  assert.match(panel.querySelector('jh-state').getAttribute('message'), /boom/);
  panel.querySelector('[data-detail-action="retry"]').click();
  await flush();
  assert.equal(textOf(part(panel, 'heading')), 'Engineer 4');

  respond = async () => ({ items: [] });
  await panel.show(J(5));
  await flush();
  assert.match(panel.querySelector('jh-state').getAttribute('message'), /unexpected answer/, 'a payload for some other job is not rendered');
});

// ---- actions and approvals -----------------------------------------------------------

const ALLOWED = [
  ['GET', /^\/api\/job-hunt\/jobs\/job_\d{16}$/], ['GET', /^\/api\/job-hunt\/jobs\/job_\d{16}\/notes$/], ['PUT', /^\/api\/job-hunt\/jobs\/job_\d{16}\/notes$/],
  ['POST', /^\/api\/job-hunt\/jobs\/job_\d{16}\/(status|plan|prefill|answers|email|approve-and-submit)$/],
];

test('Mark not interested goes through the status endpoint after a confirmation, and nothing else is called', async () => {
  const job = jobFixture(1, { materials: [{ kind: 'resume', file: 'r.pdf' }] });
  respond = async (url, options) => {
    if (url.endsWith('/status')) return { changed: true };
    return options.method === 'POST' ? {} : { ...job, status: fetchCalls.some((call) => call.url.endsWith('/status')) ? 'rejected' : 'qualified' };
  };
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  const item = panel.querySelector('[data-detail-action="reject"]');
  assert.equal(textOf(item), 'Mark not interested');
  dialogAnswer = false;
  item.click();
  await flush();
  assert.equal(fetchCalls.filter((call) => call.method !== 'GET').length, 0, 'cancelling the confirmation does nothing');
  dialogAnswer = true;
  const updated = [];
  panel.addEventListener('jh-job-updated', (event) => updated.push(event.detail.job.status));
  panel.querySelector('[data-detail-action="reject"]').click();
  await flush();
  const writes = fetchCalls.filter((call) => call.method !== 'GET');
  assert.deepEqual(writes.map((call) => [call.url, call.method, call.body]), [[`/api/job-hunt/jobs/${J(1)}/status`, 'POST', { status: 'rejected' }]]);
  assert.deepEqual(updated, ['rejected']);
  assert.equal(statusOf(panel), 'Rejected');
  assert.match(textOf(part(panel, 'notice')), /Rejected/);
});

test('approval cannot be bypassed: the panel\'s review action sends nothing, and submitting still takes Approve then Yes with the plan hash and confirm', async () => {
  const job = jobFixture(1, { applications: [plannedApplication()] });
  respond = async (url, options) => (options.method === 'POST' ? { status: 'submitted', job: { ...job, status: 'applied', applications: [plannedApplication({ status: 'submitted' })] } } : job);
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  const primary = panel.querySelector('[data-detail-action="primary"]');
  assert.equal(textOf(primary), 'Review and approve');
  fetchCalls = [];
  primary.click();
  await flush();
  assert.equal(panel.tab, 'application', 'it only takes the owner to the approval box');
  assert.equal(fetchCalls.length, 0, 'no request was made');
  const box = panel.querySelector('[data-submit-box]');
  assert.ok(box.querySelector('[data-approve-submit]'));
  assert.equal(box.querySelector('[data-confirm-submit]'), null, 'the final confirmation is not shown yet');

  box.querySelector('[data-approve-submit]').click();
  await flush();
  assert.equal(fetchCalls.length, 0, 'the first click only asks again');
  const yes = panel.querySelector('[data-confirm-submit]');
  assert.ok(yes);
  yes.click();
  await flush();
  assert.deepEqual(fetchCalls.map((call) => [call.method, call.url, call.body]), [['POST', `/api/job-hunt/jobs/${J(1)}/approve-and-submit`, { planHash: 'abc123', confirm: true }]]);
  assert.equal(statusOf(panel), 'Applied');
});

test('every request the panel can make is an existing job-hunt endpoint; prepare plans the form and submits nothing', async () => {
  const job = jobFixture(1);
  respond = async (url, options) => {
    if (url.endsWith('/plan')) return { ready: true, status: 'planned', job: { ...job, applications: [plannedApplication()] } };
    return options.method === 'POST' ? {} : job;
  };
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  const primary = panel.querySelector('[data-detail-action="primary"]');
  assert.equal(textOf(primary), 'Prepare application');
  primary.click();
  await flush();
  assert.deepEqual(fetchCalls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.url]), [['POST', `/api/job-hunt/jobs/${J(1)}/plan`]]);
  assert.equal(panel.querySelector('[data-detail-action="primary"]').textContent, 'Review and approve', 'the next step follows the new state');
  for (const call of fetchCalls) assert.ok(ALLOWED.some(([method, pattern]) => method === call.method && pattern.test(call.url)), `${call.method} ${call.url}`);
  assert.equal(fetchCalls.some((call) => /approve-and-submit|\/send|\/email/.test(call.url)), false);
});

test('a disabled menu action says why, and Answer questions opens the existing dialog', async () => {
  const job = jobFixture(1, { contactEmails: [], applicationUrls: [], applications: [plannedApplication({ status: 'needs_input', plan: { ready: false, needs: [], blockers: [], unresolved: [{ key: 'k1', label: 'Years of Rust', required: true }], fields: [] } })] });
  respond = answerFor({ '/api/job-hunt/jobs/': job });
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  const prefill = panel.querySelector('[data-detail-action="prefill"]');
  assert.equal(prefill.disabled, true);
  assert.equal(prefill.getAttribute('title'), 'This listing has no application link.');
  assert.equal(panel.querySelector('[data-detail-action="send"]').getAttribute('title'), 'This listing has no email address.');
  const primary = panel.querySelector('[data-detail-action="primary"]');
  assert.equal(textOf(primary), 'Answer questions (1)');
  primary.click();
  assert.ok(document.body.querySelector('dialog[data-answers-dialog]'), 'the existing answers dialog opened');
});

// ---- notes -------------------------------------------------------------------------

const NOTE = (over = {}) => ({ jobId: J(1), path: `job-hunt/notes/${J(1)}.md`, exists: true, body: 'hello', revision: 'a'.repeat(64), updatedAt: '2026-10-29T12:00:00.000Z', maxBytes: 65536, ...over });

test('Notes: load, edit, save with the revision, and re-read when the tab opens again', async () => {
  let note = NOTE();
  respond = async (url, options) => {
    if (url.endsWith('/notes')) {
      if (options.method === 'PUT') { note = NOTE({ body: options.body ? JSON.parse(options.body).body.trim() : '', revision: 'b'.repeat(64) }); return note; }
      return note;
    }
    return jobFixture(1);
  };
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  const area = panel.querySelector('textarea');
  assert.equal(area.value, 'hello');
  const save = panel.querySelector('[data-notes-part="save"]');
  assert.equal(save.disabled, true, 'nothing to save yet');
  area.value = 'hello **world**\n';
  area.dispatchEvent(new Ev('input', { bubbles: true }));
  assert.equal(panel.querySelector('[data-notes-part="save"]').disabled, false);
  panel.querySelector('[data-notes-part="save"]').click();
  await flush();
  const puts = fetchCalls.filter((call) => call.method === 'PUT');
  assert.deepEqual(puts.map((call) => [call.url, call.body]), [[`/api/job-hunt/jobs/${J(1)}/notes`, { body: 'hello **world**\n', revision: 'a'.repeat(64) }]]);
  assert.match(textOf(part(panel, 'notice') ?? panel.querySelector('[data-notes-part="message"]')), /Saved/);
  assert.equal(panel.querySelector('[data-notes-part="save"]').disabled, true, 'saved: trailing whitespace is not a change');

  note = NOTE({ body: 'edited in an editor', revision: 'c'.repeat(64) });
  panel.querySelector('[data-tab="overview"]').click();
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  assert.equal(panel.querySelector('textarea').value, 'edited in an editor', 'the file is read again when the tab opens');
});

test('Notes: a conflict does not overwrite, offers a reload, and the reload shows the file', async () => {
  respond = async (url, options) => {
    if (url.endsWith('/notes')) {
      if (options.method === 'PUT') return { __status: 409, error: 'This note changed since you opened it', code: 'CONFLICT', note: NOTE({ body: 'someone else wrote this', revision: 'd'.repeat(64) }) };
      return NOTE();
    }
    return jobFixture(1);
  };
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  const area = panel.querySelector('textarea');
  area.value = 'my edit';
  area.dispatchEvent(new Ev('input', { bubbles: true }));
  panel.querySelector('[data-notes-part="save"]').click();
  await flush();
  const conflict = panel.querySelector('[data-notes-part="conflict"]');
  assert.ok(conflict);
  assert.equal(conflict.getAttribute('role'), 'alert');
  assert.equal(panel.querySelector('textarea').value, 'my edit', 'the text is kept until the owner decides');
  panel.querySelector('[data-notes-part="keep"]').click();
  assert.equal(panel.querySelector('[data-notes-part="conflict"]'), null);
  panel.querySelector('[data-notes-part="save"]').click();
  await flush();
  panel.querySelector('[data-notes-part="reload"]').click();
  await flush();
  assert.equal(panel.querySelector('textarea').value, 'someone else wrote this');
  assert.equal(panel.querySelector('[data-notes-part="conflict"]'), null);
});

test('Notes: unsaved text is saved when the owner moves to another job; a failed save keeps a restorable draft', async () => {
  let failing = false;
  respond = async (url, options) => {
    if (url.endsWith('/notes')) {
      if (options.method === 'PUT') return failing ? { __status: 409, error: 'changed', code: 'CONFLICT', note: NOTE({ body: 'file now', revision: 'e'.repeat(64) }) } : NOTE({ body: 'saved on leave', revision: 'f'.repeat(64) });
      return url.includes(J(1)) ? NOTE() : NOTE({ jobId: J(2), body: '' , exists: false, revision: null });
    }
    return jobFixture(url.includes(J(2)) ? 2 : 1);
  };
  const panel = await mountPanel();
  await panel.show(J(1));
  await flush();
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  let area = panel.querySelector('textarea');
  area.value = 'unsaved thought';
  area.dispatchEvent(new Ev('input', { bubbles: true }));
  await panel.show(J(2));
  await flush();
  assert.deepEqual(fetchCalls.filter((call) => call.method === 'PUT').map((call) => call.body.body), ['unsaved thought'], 'saved on the way out');

  failing = true;
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  area = panel.querySelector('textarea');
  area.value = 'second thought';
  area.dispatchEvent(new Ev('input', { bubbles: true }));
  await panel.show(J(1));
  await flush();
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  // The draft belongs to job 2; going back to it offers the text again.
  await panel.show(J(2));
  await flush();
  panel.querySelector('[data-tab="notes"]').click();
  await flush();
  const draft = panel.querySelector('[data-notes-part="draft"]');
  assert.ok(draft, 'the unsaved text is offered back');
  panel.querySelector('[data-notes-part="restore"]').click();
  assert.equal(panel.querySelector('textarea').value, 'second thought');
});

// ---- the Opportunities page ----------------------------------------------------------

const row = (n) => ({ id: J(n), company: `Company ${n}`, role: `Engineer ${n}`, locations: ['Oakland, CA'], remote: true, compensation: '$180K', skills: ['Node'], status: 'qualified', stage: 'qualified', needsInput: false, fit: 90 - n, fitLabel: 'strong', postedAt: '2026-10-01T12:00:00.000Z', firstSeenAt: '2026-10-02T00:00:00.000Z' });
const COUNTS = { all: 3, needs_input: 0, ready: 0, applied: 0, responded: 0, archived: 0 };

async function mountPage() {
  respond = async (url) => (url.includes('/api/job-hunt/opportunities') ? { items: [row(1), row(2), row(3)], total: 3, page: 1, limit: 25, counts: COUNTS } : jobFixture(Number(/job_0+(\d+)/.exec(url)?.[1] ?? 1)));
  const node = new (registry.get('u2-job-opportunities'))();
  mounted.push(node);
  node.connectedCallback();
  node.querySelector('u2-job-detail-panel').connectedCallback();
  await flush();
  return node;
}
const rowsOf = (node) => node.querySelectorAll('tr[data-job]');

test('selecting a row opens the panel beside the table, puts the job in the URL next to the table state, and keeps the row marked', async () => {
  window.location.hash = '#/job-hunt/opportunities?filter=all&sort=company&q=eng';
  const node = await mountPage();
  const ws = node.querySelector('jh-workspace');
  assert.equal(ws.hasAttribute('detail-collapsed'), true, 'closed until a job is chosen');
  assert.ok(ws.querySelector('[data-region="main"] table'), 'the table is the main region');
  assert.ok(ws.querySelector('[data-region="detail"] u2-job-detail-panel'));
  const seen = [];
  node.addEventListener('jh-opportunity-select', (e) => seen.push(e.detail.jobId));
  rowsOf(node)[1].querySelector('td[data-col="location"]').click();
  await flush();
  assert.deepEqual(seen, [J(2)]);
  assert.equal(ws.hasAttribute('detail-collapsed'), false);
  assert.equal(window.location.hash, `#/job-hunt/opportunities?q=eng&sort=company&job=${J(2)}`, 'the table state is kept and the job added');
  assert.equal(urlWrites.at(-1)[0], 'push', 'a new history entry, so Back closes the panel');
  assert.equal(rowsOf(node)[1].getAttribute('aria-current'), 'true');
  assert.equal(textOf(part(node, 'heading')), 'Engineer 2');
  assert.equal(document.activeElement, part(node, 'heading'), 'focus moves to the panel heading');
  const requests = fetchCalls.map((call) => call.url);
  assert.ok(requests.includes(`/api/job-hunt/jobs/${J(2)}`));

  // Changing the table keeps the selected job in the URL.
  node.querySelector('[data-page="next"]')?.click();
  node.querySelector('[data-action="toggle-dir"]').click();
  await flush();
  assert.match(window.location.hash, new RegExp(`job=${J(2)}`));
  assert.match(window.location.hash, /dir=desc|dir=asc/);
});

test('closing the panel clears the job from the URL, returns focus to the row and keeps the row marked; Escape on a narrow screen does the same', async () => {
  window.location.hash = '#/job-hunt/opportunities';
  const node = await mountPage();
  rowsOf(node)[0].querySelector('td[data-col="location"]').click();
  await flush();
  assert.match(window.location.hash, /job=/);
  node.querySelector('[data-detail-action="close"]').click();
  await flush();
  assert.equal(window.location.hash, '#/job-hunt/opportunities');
  assert.equal(node.querySelector('jh-workspace').hasAttribute('detail-collapsed'), true);
  assert.equal(document.activeElement, rowsOf(node)[0]);
  assert.equal(rowsOf(node)[0].getAttribute('aria-current'), 'true', 'the selected row stays marked');
  assert.equal(node.querySelector('u2-job-detail-panel').children.length, 0, 'the panel is emptied');

  // The drawer layout closes through the workspace (Escape calls collapseDetail), which must clear the selection too.
  rowsOf(node)[2].querySelector('td[data-col="location"]').click();
  await flush();
  assert.match(window.location.hash, new RegExp(`job=${J(3)}`));
  node.querySelector('jh-workspace').collapseDetail();
  await flush();
  assert.equal(window.location.hash, '#/job-hunt/opportunities');
  assert.equal(document.activeElement, rowsOf(node)[2]);
});

test('a deep link opens the panel on load without taking focus; Enter selects instead of leaving the table; the role link and double-click still open the job page', async () => {
  window.location.hash = `#/job-hunt/opportunities?job=${J(3)}`;
  const node = await mountPage();
  assert.equal(node.querySelector('jh-workspace').hasAttribute('detail-collapsed'), false);
  assert.equal(textOf(part(node, 'heading')), 'Engineer 3');
  assert.equal(document.activeElement, null);
  assert.equal(rowsOf(node)[2].getAttribute('aria-current'), 'true', 'the deep-linked row is marked');
  assert.equal(urlWrites.length, 0, 'loading does not rewrite the URL');

  window.location.hash = '#/job-hunt/opportunities?job=not-a-job';
  const bad = await mountPage();
  assert.equal(bad.querySelector('jh-workspace').hasAttribute('detail-collapsed'), true, 'a bad id in the URL is ignored');

  const rows = rowsOf(node);
  rows[0].focus();
  press(rows[0], 'Enter');
  await flush();
  assert.match(window.location.hash, new RegExp(`job=${J(1)}`));
  assert.equal(textOf(part(node, 'heading')), 'Engineer 1');
  assert.equal(rows[0].querySelector('a[data-part="role"]').getAttribute('href'), `#/job-hunt/jobs/${J(1)}`);
});

test('an open job that the table no longer lists stays in the panel; a deleted one says so', async () => {
  window.location.hash = `#/job-hunt/opportunities?job=${J(9)}`;
  const node = await mountPage();
  assert.equal(textOf(part(node, 'heading')), 'Engineer 9', 'the panel does not depend on the page of rows');
  respond = async (url) => (url.includes('/opportunities') ? { items: [row(1)], total: 1, page: 1, limit: 25, counts: COUNTS } : { __status: 404, error: 'No such job' });
  node.dispatchEvent(new Ev('jh-job-updated', { bubbles: true, detail: {} }));
  await flush();
  const panel = node.querySelector('u2-job-detail-panel');
  await panel.show(J(8));
  await flush();
  assert.equal(textOf(part(node, 'heading')), 'Job not found');
});
