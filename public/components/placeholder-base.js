import { escapeHtml } from './util.js';

// Shared renderer for the Phase-2 reserved dashboard component types
// (docs/dashboards.md allowlist: person, project, photo-grid, document,
// map, chart, conversation, agent-status). Each still needs to be a real
// custom element so composing a dashboard with these types today doesn't
// break -- it just renders a labeled "coming soon" card instead of data.
export function renderPlaceholder(el, label, note) {
  el.classList.add('u2-placeholder');
  el.innerHTML = `
    <div class="u2-placeholder__label">${escapeHtml(label)}</div>
    <div class="u2-placeholder__note">${escapeHtml(note)}</div>
  `;
}
