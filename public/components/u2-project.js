import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: project-status card (see #/projects for the real,
// data-backed list of Project entities in Phase 1).
export class U2Project extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Project', 'Rich project-status cards arrive in Phase 2.');
  }
}

customElements.define('u2-project', U2Project);
