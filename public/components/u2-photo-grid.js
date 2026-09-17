import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: photo grids (travel/trip dashboards).
export class U2PhotoGrid extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Photo grid', 'Photo grids arrive in Phase 2.');
  }
}

customElements.define('u2-photo-grid', U2PhotoGrid);
