import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: document preview/reference card.
export class U2Document extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Document', 'Document previews arrive in Phase 2.');
  }
}

customElements.define('u2-document', U2Document);
