import { formatDateTime } from './util.js';

export class U2Document extends HTMLElement {
  set data(value) { this._data = value || {}; this._render(); }
  get data() { return this._data || {}; }
  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected && !this._data) return;
    const d = this.data; this.textContent = ''; this.classList.add('u2-domain-card');
    const header = document.createElement('header'); header.className = 'u2-domain-card__header';
    const title = document.createElement('strong'); title.textContent = d.title || 'Document'; header.append(title);
    if (d.type) { const type = document.createElement('span'); type.textContent = d.type; header.append(type); } this.append(header);
    const metadata = [d.source, d.modifiedAt ? `Modified ${formatDateTime(d.modifiedAt)}` : null].filter(Boolean).join(' · ');
    if (metadata) { const meta = document.createElement('small'); meta.className = 'u2-document__meta'; meta.textContent = metadata; this.append(meta); }
    if (d.excerpt) this.append(field('Excerpt', d.excerpt));
    if (d.whyRelevant) this.append(field('Why it is relevant', d.whyRelevant));
  }
}

function field(label, value) { const section = document.createElement('section'); const title = document.createElement('h4'); title.textContent = label; const body = document.createElement('p'); body.textContent = value; section.append(title, body); return section; }

customElements.define('u2-document', U2Document);
