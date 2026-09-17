import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: a person profile card (before-a-meeting dashboards).
export class U2Person extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Person', 'Profile cards for people arrive in Phase 2.');
  }
}

customElements.define('u2-person', U2Person);
