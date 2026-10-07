// Top bar of the app shell: drawer toggles (narrow viewports), brand,
// connection state and theme toggle. It only renders markup; <u2-app> wires
// the toggles and updates the connection indicator, as before.
export class U2ShellHeader extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.innerHTML = `
      <button type="button" class="icon-btn shell__drawer-toggle" data-toggle="nav" aria-label="Toggle navigation">&#9776;</button>
      <span class="shell__brand">U2OS</span>
      <span class="connection-state" data-connection-state role="status" aria-live="polite">Connecting</span>
      <span class="shell__header-spacer"></span>
      <button type="button" class="icon-btn" data-toggle="theme" aria-label="Toggle color theme"></button>
      <button type="button" class="icon-btn shell__drawer-toggle" data-toggle="agent" aria-label="Toggle agent panel">&#128172;</button>
    `;
  }
}

if (!customElements.get('u2-shell-header')) customElements.define('u2-shell-header', U2ShellHeader);
