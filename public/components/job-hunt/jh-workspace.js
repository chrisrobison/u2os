import { define } from './jh-primitives.js';
const NARROW = '(max-width: 900px)';
function isNarrow() {
  try { return typeof matchMedia === 'function' && matchMedia(NARROW).matches; } catch { return false; }
}

/**
 * <jh-workspace>: a main region plus a collapsible detail region. Mark the
 * children with data-region="main" and data-region="detail". The detail is
 * hidden while the `detail-collapsed` attribute is present. Below ~900px it is
 * a drawer over the main region (CSS), closed with the toggle or Escape.
 * Fires `jh-detail-toggle` ({ collapsed }).
 */
export class JhWorkspace extends HTMLElement {
  connectedCallback() {
    this.classList.add('jh-workspace');
    // Start as a closed drawer on a narrow screen unless the host chose.
    if (!this._init && !this.hasAttribute('detail-collapsed') && isNarrow()) this.setAttribute('detail-collapsed', '');
    this._init = true;
    if (!this._onKey) {
      this._onKey = (event) => {
        if (event.key === 'Escape' && !this.detailCollapsed && isNarrow()) this.collapseDetail();
      };
    }
    this.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback() {
    if (this._onKey) this.removeEventListener('keydown', this._onKey);
  }

  get detailCollapsed() { return this.hasAttribute('detail-collapsed'); }

  toggleDetail(force) {
    const collapsed = force === undefined ? !this.detailCollapsed : Boolean(force);
    if (collapsed === this.detailCollapsed) return collapsed;
    this.toggleAttribute('detail-collapsed', collapsed);
    this.dispatchEvent(new CustomEvent('jh-detail-toggle', { bubbles: true, detail: { collapsed } }));
    return collapsed;
  }

  collapseDetail() { return this.toggleDetail(true); }
  openDetail() { return this.toggleDetail(false); }
}

define('jh-workspace', JhWorkspace);
