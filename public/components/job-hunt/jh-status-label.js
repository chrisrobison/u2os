import { el } from './jh-util.js';
import { define, TONES, toneOf } from './jh-primitives.js';
/**
 * <jh-status-label tone="success|active|attention|danger|agent|neutral" label="Ready">:
 * the text is always rendered; the tone adds a colour and a distinct glyph.
 * Without a `label` attribute the element's initial text is kept.
 */
export class JhStatusLabel extends HTMLElement {
  static get observedAttributes() { return ['tone', 'label']; }

  connectedCallback() {
    if (this._initial === undefined) this._initial = this.hasAttribute('label') ? '' : this.textContent;
    this._render();
  }

  attributeChangedCallback() { if (this._ready) this._render(); }

  _render() {
    this._ready = true;
    const tone = toneOf(this.getAttribute('tone'));
    this.classList.add('jh-status');
    this.setAttribute('data-tone', tone);
    this.replaceChildren(
      el('span', { class: 'jh-status__glyph', 'aria-hidden': 'true', text: TONES[tone].glyph }),
      el('span', { class: 'jh-status__text', text: this.getAttribute('label') ?? this._initial ?? '' }),
    );
  }
}

define('jh-status-label', JhStatusLabel);
