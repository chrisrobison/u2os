import { el } from './jh-util.js';
import { define } from './jh-primitives.js';
/**
 * <jh-state kind="empty|loading|error" title message [retry] [retry-label]>:
 * empty and loading are polite status regions, error is an alert. An error
 * with `retry` shows a button that fires `jh-retry`.
 */
export class JhState extends HTMLElement {
  static get observedAttributes() { return ['kind', 'title', 'message', 'retry', 'retry-label']; }

  connectedCallback() { this._render(); }
  attributeChangedCallback() { if (this._ready) this._render(); }

  _render() {
    this._ready = true;
    const raw = this.getAttribute('kind');
    const kind = raw === 'loading' || raw === 'error' ? raw : 'empty';
    this.classList.add('jh-state');
    this.setAttribute('data-kind', kind);
    this.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (kind === 'loading') this.setAttribute('aria-busy', 'true'); else this.removeAttribute('aria-busy');
    const parts = [];
    if (kind === 'loading') parts.push(el('span', { class: 'jh-state__spinner', 'aria-hidden': 'true' }));
    if (this.getAttribute('title')) parts.push(el('p', { class: 'jh-state__title', text: this.getAttribute('title') }));
    if (this.getAttribute('message')) parts.push(el('p', { class: 'jh-state__message', text: this.getAttribute('message') }));
    if (kind === 'error' && this.hasAttribute('retry')) {
      const button = el('button', { class: 'jh-state__retry', type: 'button', text: this.getAttribute('retry-label') || 'Try again' });
      button.addEventListener('click', () => this.dispatchEvent(new CustomEvent('jh-retry', { bubbles: true })));
      parts.push(button);
    }
    this.replaceChildren(...parts);
  }
}

define('jh-state', JhState);
