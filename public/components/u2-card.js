// Generic titled card. `title` attribute/property + default slot content
// (light DOM: children are kept, just wrapped). Visual elevation comes from
// a hairline border + card background token, not a shadow.
export class U2Card extends HTMLElement {
  static get observedAttributes() {
    return ['title'];
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this._render();
  }

  set title(value) {
    if (value) this.setAttribute('title', value);
    else this.removeAttribute('title');
  }

  get title() {
    return this.getAttribute('title') || '';
  }

  _render() {
    if (!this._body) {
      this._body = document.createElement('div');
      this._body.className = 'u2-card__body';
      while (this.firstChild) this._body.appendChild(this.firstChild);
    }

    this.classList.add('u2-card');
    this.textContent = '';

    const titleText = this.getAttribute('title');
    if (titleText) {
      if (!this._titleEl) {
        this._titleEl = document.createElement('div');
        this._titleEl.className = 'u2-card__title';
      }
      this._titleEl.textContent = titleText;
      this.appendChild(this._titleEl);
    }

    this.appendChild(this._body);
  }
}

customElements.define('u2-card', U2Card);
