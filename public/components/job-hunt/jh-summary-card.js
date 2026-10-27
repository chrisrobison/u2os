import { el } from './jh-util.js';
import { define, safeHref, toneOf } from './jh-primitives.js';
/**
 * <jh-summary-card label value sublabel [href] [interactive] [tone]>: a metric.
 * With a safe `href` the body is a real link; with `interactive` and no href it
 * is a button that fires `jh-card-activate`. Otherwise it is plain text.
 */
export class JhSummaryCard extends HTMLElement {
  static get observedAttributes() { return ['label', 'value', 'sublabel', 'href', 'interactive', 'tone']; }

  connectedCallback() { this._render(); }
  attributeChangedCallback() { if (this.isConnected !== false && this._ready) this._render(); }

  _render() {
    this._ready = true;
    this.classList.add('jh-summary-card');
    this.setAttribute('data-tone', this.hasAttribute('tone') ? toneOf(this.getAttribute('tone')) : '');
    const parts = [
      el('span', { class: 'jh-summary-card__value', text: this.getAttribute('value') ?? '' }),
      el('span', { class: 'jh-summary-card__label', text: this.getAttribute('label') ?? '' }),
    ];
    if (this.getAttribute('sublabel')) parts.push(el('span', { class: 'jh-summary-card__sub', text: this.getAttribute('sublabel') }));
    const href = safeHref(this.getAttribute('href'));
    let body;
    if (href) {
      body = el('a', { class: 'jh-summary-card__body', href }, ...parts);
    } else if (this.hasAttribute('interactive')) {
      body = el('button', { class: 'jh-summary-card__body', type: 'button' }, ...parts);
      body.addEventListener('click', () => this.dispatchEvent(new CustomEvent('jh-card-activate', { bubbles: true })));
    } else {
      body = el('div', { class: 'jh-summary-card__body' }, ...parts);
    }
    this.replaceChildren(body);
  }
}

define('jh-summary-card', JhSummaryCard);
