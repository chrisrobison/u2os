import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: an embedded conversation thread inside a dashboard
// (distinct from the always-on <u2-agent> panel).
export class U2Conversation extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Conversation', 'Embedded conversation threads arrive in Phase 2.');
  }
}

customElements.define('u2-conversation', U2Conversation);
