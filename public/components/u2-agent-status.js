import { renderPlaceholder } from './placeholder-base.js';

// Phase-2 placeholder: a standalone agent-status card for a dashboard
// (voice/presence state -- see <u2-agent>'s status pill for the Phase 1
// equivalent inside the conversation panel).
export class U2AgentStatus extends HTMLElement {
  connectedCallback() {
    renderPlaceholder(this, 'Agent status', 'A dedicated status card arrives in Phase 2.');
  }
}

customElements.define('u2-agent-status', U2AgentStatus);
