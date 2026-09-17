import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: map card (travel dashboards).
export class U2Map extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Map', 'Maps arrive in Phase 2.');
  }
}

customElements.define('u2-map', U2Map);
