import { escapeHtml } from './util.js';

// Small inline banner. property/attribute `variant` (info|warning) +
// property/attribute `message`.
export class U2Alert extends HTMLElement {
  static get observedAttributes() {
    return ['variant', 'message'];
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this._render();
  }

  set variant(v) {
    this.setAttribute('variant', v || 'info');
  }
  get variant() {
    return this.getAttribute('variant') || 'info';
  }

  set message(v) {
    this.setAttribute('message', v || '');
  }
  get message() {
    return this.getAttribute('message') || '';
  }

  _render() {
    const variant = this.variant === 'warning' ? 'warning' : 'info';
    this.classList.add('u2-alert');
    this.dataset.variant = variant;
    this.innerHTML = `<span class="u2-alert__dot"></span><span>${escapeHtml(this.message)}</span>`;
  }
}

customElements.define('u2-alert', U2Alert);
