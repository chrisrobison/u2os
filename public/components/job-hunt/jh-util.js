// Small helpers shared by the job-hunt dashboard components. Everything the
// dashboard shows comes from scraped postings, so text is only ever set with
// textContent (el() below) and URLs are checked before they become links.

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(node, props, children) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function el(tag, props, ...children) {
  return apply(document.createElement(tag), props, children);
}

export function svg(tag, props, ...children) {
  return apply(document.createElementNS(SVG_NS, tag), props, children);
}

/** http(s) URLs only: a posting can carry any string, including javascript: URLs. */
export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

export function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

/** A hue (0-359) derived only from the name, so a company keeps its colour everywhere. */
export function toneHue(name) {
  let hash = 0;
  for (const ch of String(name || '').toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 360;
}

export function monogram(name, size = 'md') {
  const node = el('span', { class: `jh-mono jh-mono--${size}`, 'aria-hidden': 'true', text: initials(name) });
  node.style.setProperty('--jh-hue', String(toneHue(name)));
  return node;
}

export function relTime(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** Fit bands: high 85+, good 70-84, lower under 70, none when unscored. */
export function fitBand(score) {
  if (score === null || score === undefined) return 'none';
  if (score >= 85) return 'high';
  if (score >= 70) return 'good';
  return 'low';
}

export const FIT_BANDS = [
  { id: 'high', label: 'High fit (85+)' },
  { id: 'good', label: 'Good fit (70-84)' },
  { id: 'low', label: 'Lower fit (under 70)' },
  { id: 'none', label: 'Not scored' },
];

export function fitChip(score) {
  const band = fitBand(score);
  return el('span', { class: `jh-fit jh-fit--${band}`, text: band === 'none' ? 'No score' : `${score}% fit` });
}

export function formatDay(iso) {
  const d = new Date(iso || '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatStamp(iso) {
  const d = new Date(iso || '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function titleCase(status) {
  const text = String(status || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function emptyNote(text, className = 'jh-empty') {
  return el('p', { class: className, text });
}
