export class U2PhotoGrid extends HTMLElement {
  set data(value) { this._data = value || {}; this._render(); }
  get data() { return this._data || {}; }
  connectedCallback() { this._render(); }
  _render() {
    if (!this.isConnected && !this._data) return;
    const d = this.data; this.textContent = ''; this.classList.add('u2-photo-grid');
    if (d.title) { const title = document.createElement('strong'); title.textContent = d.title; this.append(title); }
    const grid = document.createElement('div'); grid.className = 'u2-photo-grid__items';
    for (const photo of d.photos || []) { const figure = document.createElement('figure'); const image = document.createElement('img'); image.src = photo.src; image.alt = photo.alt || photo.caption || ''; image.loading = 'lazy'; figure.append(image); if (photo.caption) { const caption = document.createElement('figcaption'); caption.textContent = photo.caption; figure.append(caption); } grid.append(figure); }
    this.append(grid);
  }
}

customElements.define('u2-photo-grid', U2PhotoGrid);
