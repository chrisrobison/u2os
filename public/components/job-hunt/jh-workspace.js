import { define } from './jh-primitives.js';
const NARROW = '(max-width: 900px)';
function narrowQuery() {
  try { return typeof matchMedia === 'function' ? matchMedia(NARROW) : null; } catch { return null; }
}
function isNarrow() {
  return Boolean(narrowQuery()?.matches);
}

/**
 * <jh-workspace>: a main region plus a collapsible detail region. Mark the
 * children with data-region="main" and data-region="detail". The detail is
 * hidden while the `detail-collapsed` attribute is present. Below ~900px it is
 * a drawer over the main region (CSS), closed with the toggle, Escape or a tap
 * on the dimmed page behind it. While that drawer is open the main region is
 * `inert`, so the keyboard cannot wander into rows hidden under it; it is made
 * interactive again the moment the drawer closes or the window grows wide
 * enough to show both side by side.
 * Fires `jh-detail-toggle` ({ collapsed }).
 */
export class JhWorkspace extends HTMLElement {
  static get observedAttributes() { return ['detail-collapsed']; }

  connectedCallback() {
    this.classList.add('jh-workspace');
    // Start as a closed drawer on a narrow screen unless the host chose.
    if (!this._init && !this.hasAttribute('detail-collapsed') && isNarrow()) this.setAttribute('detail-collapsed', '');
    this._init = true;
    if (!this._onKey) {
      this._onKey = (event) => {
        if (event.key === 'Escape' && !this.detailCollapsed && isNarrow()) this.collapseDetail();
      };
      // The page behind an open drawer is the workspace element itself (its ::after scrim), so a click that lands on it closes the drawer.
      this._onScrim = (event) => {
        if (event.target === this && !this.detailCollapsed && isNarrow()) this.collapseDetail();
      };
      this._onMedia = () => this._syncInert();
    }
    this.addEventListener('keydown', this._onKey);
    this.addEventListener('click', this._onScrim);
    this._query = narrowQuery();
    this._query?.addEventListener?.('change', this._onMedia);
    this._syncInert();
  }

  disconnectedCallback() {
    this.removeEventListener('keydown', this._onKey);
    this.removeEventListener('click', this._onScrim);
    this._query?.removeEventListener?.('change', this._onMedia);
    this._query = null;
  }

  attributeChangedCallback() { if (this._init) this._syncInert(); }

  get detailCollapsed() { return this.hasAttribute('detail-collapsed'); }

  toggleDetail(force) {
    const collapsed = force === undefined ? !this.detailCollapsed : Boolean(force);
    if (collapsed === this.detailCollapsed) return collapsed;
    this.toggleAttribute('detail-collapsed', collapsed);
    this._syncInert();
    this.dispatchEvent(new CustomEvent('jh-detail-toggle', { bubbles: true, detail: { collapsed } }));
    return collapsed;
  }

  collapseDetail() { return this.toggleDetail(true); }
  openDetail() { return this.toggleDetail(false); }

  _syncInert() {
    const main = this.querySelector?.(':scope > [data-region="main"]');
    if (main) main.inert = isNarrow() && !this.detailCollapsed;
  }
}

define('jh-workspace', JhWorkspace);
