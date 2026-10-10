import { el, svg } from './jh-util.js';

// Job search analytics: four tiles over a window, with the change against the
// window before it, and a bar sparkline of applications sent per day. Rates
// are null when nothing was sent, which is shown as a dash, never as 0%.

const WINDOWS = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']];
const DAY = 86_400_000;

const pct = (value) => (value == null ? '–' : `${Math.round(value * 100)}%`);

function delta(metric, kind, days) {
  if (metric.change == null) return { text: 'No earlier data', dir: 'flat' };
  const amount = kind === 'rate' ? Math.round(metric.change * 100) : metric.change;
  const unit = kind === 'rate' ? ' pts' : '';
  if (amount === 0) return { text: `No change vs prior ${days} days`, dir: 'flat' };
  return { text: `${amount > 0 ? '+' : '−'}${Math.abs(amount)}${unit} vs prior ${days} days`, dir: amount > 0 ? 'up' : 'down' };
}

/** One value per calendar day of the window (UTC, as the API buckets them), zero where nothing was sent. */
export function dailySeries(analytics) {
  const counts = new Map((analytics.sentByDay || []).map((entry) => [entry.date, entry.count]));
  const start = Date.parse(`${analytics.window.from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${analytics.window.to.slice(0, 10)}T00:00:00Z`);
  const series = [];
  for (let t = start; t <= end; t += DAY) { const date = new Date(t).toISOString().slice(0, 10); series.push({ date, count: counts.get(date) ?? 0 }); }
  return series;
}

export function sparkline(series, label) {
  const max = Math.max(1, ...series.map((point) => point.count));
  const step = 8;
  const root = svg('svg', { class: 'jh-spark', viewBox: `0 0 ${series.length * step} 28`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
  series.forEach((point, i) => {
    const height = point.count ? Math.max(3, (point.count / max) * 26) : 1.5;
    root.append(svg('rect', { class: point.count ? 'jh-spark__bar' : 'jh-spark__bar jh-spark__bar--zero', x: i * step + 1, y: 28 - height, width: step - 2, height, rx: 1 }));
  });
  return root;
}

export class U2JobAnalytics extends HTMLElement {
  constructor() { super(); this._built = false; this._analytics = null; }

  connectedCallback() {
    if (!this._built) this._build();
    this._render();
  }

  _build() {
    this._built = true;
    this.classList.add('jh-panel');
    this.setAttribute('role', 'region');
    this.setAttribute('aria-labelledby', 'jh-analytics-title');
    this._select = el('select', { id: 'jh-window', class: 'jh-select' }, WINDOWS.map(([value, label]) => el('option', { value, text: label })));
    this._select.value = '30';
    this._select.addEventListener('change', () => this.dispatchEvent(new CustomEvent('jh-window', { bubbles: true, detail: { days: Number(this._select.value) } })));
    this._body = el('div', { class: 'jh-analytics' });
    this.append(
      el('div', { class: 'jh-panel__head' }, el('h2', { id: 'jh-analytics-title', class: 'jh-panel__title', text: 'Job Search Analytics' }),
        el('div', { class: 'jh-groupby' }, el('label', { class: 'sr-only', for: 'jh-window', text: 'Time window' }), this._select)),
      this._body);
  }

  update(analytics) {
    this._analytics = analytics;
    if (this._built) this._render();
  }

  _tile(label, value, metric, kind, extra) {
    const days = this._analytics.window.days;
    const change = delta(metric, kind, days);
    return el('div', { class: 'jh-tile' },
      el('div', { class: 'jh-tile__label', text: label }),
      el('div', { class: 'jh-tile__value', text: value }),
      el('div', { class: `jh-tile__delta jh-tile__delta--${change.dir}` }, change.dir === 'flat' ? null : el('span', { 'aria-hidden': 'true', text: change.dir === 'up' ? '▲ ' : '▼ ' }), change.text),
      extra);
  }

  _render() {
    const a = this._analytics;
    this._body.textContent = '';
    if (!a) { this._body.append(el('p', { class: 'jh-empty', text: 'Loading...' })); return; }
    this._select.value = String(a.window.days);
    const series = dailySeries(a);
    const sent = a.applicationsSent.value;
    const spark = sent ? sparkline(series, `Applications sent per day over the last ${a.window.days} days: ${sent} in total`) : null;
    const rateNote = (metric) => (metric.denominator ? null : el('div', { class: 'jh-tile__note', text: 'Nothing sent in this window' }));
    this._body.append(el('div', { class: 'jh-tiles' },
      this._tile('Applications Sent', String(sent), a.applicationsSent, 'count', spark),
      this._tile('Interview Rate', pct(a.interviewRate.value), a.interviewRate, 'rate', rateNote(a.interviewRate)),
      this._tile('Response Rate', pct(a.responseRate.value), a.responseRate, 'rate', rateNote(a.responseRate)),
      this._tile('Offers', String(a.offers.value), a.offers, 'count', null)));
    if (!sent) this._body.append(el('p', { class: 'jh-note', text: 'Nothing has been sent in this window yet. These numbers fill in as applications go out.' }));
  }
}

customElements.define('u2-job-analytics', U2JobAnalytics);
