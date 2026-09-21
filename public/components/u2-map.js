export class U2Map extends HTMLElement {
  set data(value) { this._data = value || {}; this._render(); }
  get data() { return this._data || {}; }
  connectedCallback() { this._render(); }
  _render() {
    if (!this.isConnected && !this._data) return;
    const d = this.data; this.textContent = ''; this.classList.add('u2-map');
    if (d.title) { const title = document.createElement('strong'); title.textContent = d.title; this.append(title); }
    const plot = document.createElement('div'); plot.className = 'u2-map__plot'; plot.setAttribute('role', 'img'); plot.setAttribute('aria-label', 'Relative location plot');
    const list = document.createElement('ul');
    for (const location of d.locations || []) { const marker = document.createElement('span'); marker.className = 'u2-map__marker'; marker.style.left = `${(location.longitude + 180) / 360 * 100}%`; marker.style.top = `${(90 - location.latitude) / 180 * 100}%`; marker.title = location.label; plot.append(marker); const item = document.createElement('li'); item.textContent = `${location.label} (${location.latitude}, ${location.longitude})`; list.append(item); }
    this.append(plot, list);
  }
}

customElements.define('u2-map', U2Map);
