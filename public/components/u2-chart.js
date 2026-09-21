export class U2Chart extends HTMLElement {
  set data(value) { this._data = value || {}; this._render(); }
  get data() { return this._data || {}; }
  connectedCallback() { this._render(); }
  _render() {
    if (!this.isConnected && !this._data) return;
    const d = this.data; this.textContent = ''; this.classList.add('u2-chart');
    if (d.title) { const title = document.createElement('strong'); title.textContent = d.title; this.append(title); }
    const values = (d.series || []).flatMap((series) => series.values || []).map((point) => Math.abs(point.value));
    const max = Math.max(...values, 1);
    for (const series of d.series || []) {
      const group = document.createElement('section'); const heading = document.createElement('h4'); heading.textContent = series.label; group.append(heading);
      for (const point of series.values || []) { const row = document.createElement('div'); row.className = 'u2-chart__row'; const label = document.createElement('span'); label.textContent = point.label; const bar = document.createElement('span'); bar.className = 'u2-chart__bar'; bar.style.setProperty('--bar-size', `${Math.min(100, Math.abs(point.value) / max * 100)}%`); const value = document.createElement('span'); value.textContent = String(point.value); row.append(label, bar, value); group.append(row); }
      this.append(group);
    }
  }
}

customElements.define('u2-chart', U2Chart);
