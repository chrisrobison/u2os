// Section header for data views (#434): title, optional subtitle and an
// optional "+" button for creating a record. The component owns no data. The
// view listens for `u2-section-add` and opens the record modal empty.
//
//   const header = document.createElement('u2-section');
//   header.heading = 'Tasks';
//   header.subtitle = 'Open and completed';
//   header.addLabel = 'New task';      // omit for sections with nothing to add
//   header.addEventListener('u2-section-add', () => ...);
export class U2Section extends HTMLElement {
  constructor() {
    super();
    this._heading = '';
    this._subtitle = '';
    this._addLabel = '';
  }

  set heading(value) { this._heading = value || ''; this._render(); }
  get heading() { return this._heading; }
  set subtitle(value) { this._subtitle = value || ''; this._render(); }
  get subtitle() { return this._subtitle; }
  set addLabel(value) { this._addLabel = value || ''; this._render(); }
  get addLabel() { return this._addLabel; }

  connectedCallback() {
    this._render();
  }

  _render() {
    if (!this.isConnected) return;
    this.textContent = '';
    this.classList.add('u2-section');

    const text = document.createElement('div');
    text.className = 'u2-section__text';
    const title = document.createElement('h1');
    title.className = 'workspace__title';
    title.textContent = this._heading;
    text.append(title);
    if (this._subtitle) {
      const sub = document.createElement('div');
      sub.className = 'workspace__subtitle';
      sub.textContent = this._subtitle;
      text.append(sub);
    }
    this.append(text);

    if (this._addLabel) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn btn-primary u2-section__add';
      add.setAttribute('aria-label', this._addLabel);
      add.title = this._addLabel;
      add.textContent = '+';
      add.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('u2-section-add', { bubbles: true, detail: { opener: add } }));
      });
      this.append(add);
    }
  }
}

customElements.define('u2-section', U2Section);
