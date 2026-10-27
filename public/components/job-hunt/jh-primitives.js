import { safeUrl } from './jh-util.js';

// Layout and display primitives for the Job Hunt redesign (#627). Light DOM,
// styled by job-hunt.css (.jh-* classes, theme tokens only). Nothing here is
// wired to data: a host sets attributes and children, and every string is
// written with textContent or an attribute, never as HTML.

export const TONES = Object.freeze({
  success: { glyph: '✓' },
  active: { glyph: '●' },
  attention: { glyph: '!' },
  danger: { glyph: '✕' },
  agent: { glyph: '✦' },
  neutral: { glyph: '○' },
});

export function toneOf(value) {
  const tone = String(value ?? '').toLowerCase();
  return Object.hasOwn(TONES, tone) ? tone : 'neutral';
}

/** In-app routes (#/x, /x) and http(s) URLs only; javascript: and friends are dropped. */
export function safeHref(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('#') || (text.startsWith('/') && !text.startsWith('//') && !text.startsWith('/\\'))) return text;
  return safeUrl(text);
}

/** Defines a custom element once, however many times the module is evaluated. */
export function define(name, ctor) {
  if (!customElements.get(name)) customElements.define(name, ctor);
}
