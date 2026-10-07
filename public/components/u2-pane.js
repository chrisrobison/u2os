// A fixed-size region of the app shell. The shell itself never scrolls: each
// pane fills its grid cell and is the only thing that scrolls (#494).
//
//   <u2-pane>                   the pane's own content scrolls (nav, workspace)
//   <u2-pane scroll="inner">    the pane never scrolls; a descendant that
//                               fills it (e.g. the agent transcript) does
//
// The sizing rules live in styles/base.css (`u2-pane`). This element only
// carries the role so the landmark is a component rather than a bare <div>.
export class U2Pane extends HTMLElement {
  connectedCallback() {
    if (!this.hasAttribute('role') && this.dataset.landmark) this.setAttribute('role', this.dataset.landmark);
  }
}

if (!customElements.get('u2-pane')) customElements.define('u2-pane', U2Pane);
