import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// #627: Job Hunt layout/display primitives. There is no DOM library in this repo,
// so a minimal shim stands in for the browser. It records children and text
// separately so a test can prove hostile strings never become elements.

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
let narrow = false;

before(async () => {
  Object.assign(globalThis, {
    Node: NodeShim, HTMLElement: ElementShim, CustomEvent: Ev,
    customElements: { get: (n) => registry.get(n), define: (n, c) => registry.set(n, c) },
    document: { createElement: (t) => (registry.has(t) ? new (registry.get(t))() : new ElementShim(t)), createTextNode: (t) => new TextShim(t) },
    matchMedia: () => ({ matches: narrow }),
  });
  await import('../public/components/job-hunt/jh-all.js');
});

function mount(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.isConnected = true;
  node.connectedCallback();
  return node;
}

const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';

test('all four primitives register', () => {
  for (const n of ['jh-workspace', 'jh-summary-card', 'jh-status-label', 'jh-state']) assert.ok(registry.has(n), n);
});

test('summary card renders label, value and sublabel as text', () => {
  const card = mount('jh-summary-card', { label: 'Strong matches', value: '186', sublabel: '80+ score' });
  assert.equal(card.findClass('jh-summary-card__value').textContent, '186');
  assert.equal(card.findClass('jh-summary-card__label').textContent, 'Strong matches');
  assert.equal(card.findClass('jh-summary-card__sub').textContent, '80+ score');
  assert.equal(card.findClass('jh-summary-card__body').tagName, 'DIV');
  card.setAttribute('value', '187');
  assert.equal(card.findClass('jh-summary-card__value').textContent, '187');
});

test('summary card with href is a link; interactive is a button; unsafe href is not a link', () => {
  const link = mount('jh-summary-card', { label: 'a', value: '1', href: '#/job-hunt/leads' });
  const body = link.findClass('jh-summary-card__body');
  assert.equal(body.tagName, 'A');
  assert.equal(body.getAttribute('href'), '#/job-hunt/leads');
  assert.equal(mount('jh-summary-card', { label: 'a', value: '1', href: 'https://example.com/x' }).findClass('jh-summary-card__body').tagName, 'A');
  for (const bad of ['javascript:alert(1)', '//evil.example', 'data:text/html,hi']) {
    assert.equal(mount('jh-summary-card', { label: 'a', value: '1', href: bad }).findClass('jh-summary-card__body').tagName, 'DIV', bad);
  }
  const button = mount('jh-summary-card', { label: 'a', value: '1', interactive: '' });
  let fired = 0;
  button.addEventListener('jh-card-activate', () => fired++);
  const inner = button.findClass('jh-summary-card__body');
  assert.equal(inner.tagName, 'BUTTON');
  assert.equal(inner.getAttribute('type'), 'button');
  inner.click();
  assert.equal(fired, 1);
});

test('status label maps every tone and always shows its text', () => {
  for (const tone of ['success', 'active', 'attention', 'danger', 'agent', 'neutral']) {
    const s = mount('jh-status-label', { tone, label: `Label ${tone}` });
    assert.equal(s.getAttribute('data-tone'), tone);
    assert.equal(s.findClass('jh-status__text').textContent, `Label ${tone}`);
    assert.equal(s.findClass('jh-status__glyph').getAttribute('aria-hidden'), 'true');
  }
  assert.equal(mount('jh-status-label', { tone: 'bogus', label: 'x' }).getAttribute('data-tone'), 'neutral');
  assert.equal(mount('jh-status-label', { label: 'x' }).getAttribute('data-tone'), 'neutral');
  const s = mount('jh-status-label', { tone: 'success', label: 'Ready' });
  s.setAttribute('tone', 'danger');
  assert.equal(s.getAttribute('data-tone'), 'danger');
});

test('state sets roles and the retry button emits jh-retry', () => {
  const loading = mount('jh-state', { kind: 'loading', title: 'Loading' });
  assert.equal(loading.getAttribute('role'), 'status');
  assert.equal(loading.getAttribute('aria-busy'), 'true');
  const empty = mount('jh-state', { title: 'No jobs', message: 'Nothing yet' });
  assert.equal(empty.getAttribute('data-kind'), 'empty');
  assert.equal(empty.getAttribute('role'), 'status');
  assert.equal(empty.findClass('jh-state__retry'), null);

  const error = mount('jh-state', { kind: 'error', title: 'Failed', message: 'Boom', retry: '' });
  assert.equal(error.getAttribute('role'), 'alert');
  const button = error.findClass('jh-state__retry');
  assert.equal(button.textContent, 'Try again');
  let fired = 0;
  error.addEventListener('jh-retry', () => fired++);
  button.click();
  assert.equal(fired, 1);
  assert.equal(mount('jh-state', { kind: 'error', title: 'x' }).findClass('jh-state__retry'), null);
  assert.equal(mount('jh-state', { kind: 'empty', retry: '' }).findClass('jh-state__retry'), null);
});

test('workspace detail collapses and reopens, fires events, and Escape closes the narrow drawer', () => {
  narrow = false;
  const ws = mount('jh-workspace');
  assert.ok(ws.classList.contains('jh-workspace'));
  assert.equal(ws.detailCollapsed, false);
  const seen = [];
  ws.addEventListener('jh-detail-toggle', (e) => seen.push(e.detail.collapsed));
  ws.toggleDetail();
  assert.equal(ws.hasAttribute('detail-collapsed'), true);
  ws.openDetail();
  assert.equal(ws.detailCollapsed, false);
  ws.collapseDetail();
  ws.collapseDetail();
  assert.deepEqual(seen, [true, false, true]);

  ws.openDetail();
  ws.dispatchEvent(new Ev('keydown', { key: 'Escape' }));
  assert.equal(ws.detailCollapsed, false, 'Escape does nothing outside drawer mode');
  narrow = true;
  ws.dispatchEvent(new Ev('keydown', { key: 'Escape' }));
  assert.equal(ws.detailCollapsed, true);
  assert.equal(mount('jh-workspace').detailCollapsed, true, 'starts as a closed drawer when narrow');
  assert.equal(mount('jh-workspace', { }).hasAttribute('detail-collapsed'), true);
  narrow = false;
});

test('hostile strings are text only and never become elements or attributes with markup', () => {
  const card = mount('jh-summary-card', { label: HOSTILE, value: HOSTILE, sublabel: HOSTILE });
  assert.equal(card.findClass('jh-summary-card__label').textContent, HOSTILE);
  const status = mount('jh-status-label', { tone: HOSTILE, label: HOSTILE });
  assert.equal(status.findClass('jh-status__text').textContent, HOSTILE);
  assert.equal(status.getAttribute('data-tone'), 'neutral');
  const state = mount('jh-state', { kind: HOSTILE, title: HOSTILE, message: HOSTILE });
  assert.equal(state.findClass('jh-state__title').textContent, HOSTILE);
  for (const root of [card, status, state]) {
    assert.equal(root.find((n) => ['IMG', 'SCRIPT'].includes(n.tagName)), null);
  }
  const initial = document.createElement('jh-status-label');
  initial.textContent = HOSTILE;
  initial.connectedCallback();
  assert.equal(initial.findClass('jh-status__text').textContent, HOSTILE);
});

test('themes define success and agent tokens in all four blocks, and the css uses only tokens', () => {
  const themes = fs.readFileSync(new URL('../public/styles/themes.css', import.meta.url), 'utf8');
  for (const token of ['--accent-success:', '--accent-success-soft:', '--accent-agent:', '--accent-agent-soft:']) {
    assert.equal(themes.split(token).length - 1, 4, token);
  }
  const css = fs.readFileSync(new URL('../public/components/job-hunt/job-hunt.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('/* ---------- primitives (#627)')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), 'no hard-coded colours');
  assert.match(block, /:focus-visible/);
  assert.match(block, /prefers-reduced-motion/);
  assert.match(block, /pointer: coarse/);
});
