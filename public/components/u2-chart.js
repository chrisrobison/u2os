import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: chart card (project/analytics dashboards).
export class U2Chart extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Chart', 'Charts arrive in Phase 2.');
  }
}

customElements.define('u2-chart', U2Chart);
