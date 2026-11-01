// The chip that says which page context is attached to the next chat messages (#640), e.g. a job. It is display and
// consent only: the chat sends { kind, jobId } with each message while the chip is attached, and the SERVER reads the
// job. The label is for the owner's eyes and is never sent. Light DOM; strings are written with textContent.
//
//   chip.attach({ kind: 'job', jobId, label })   shows the chip and announces it
//   chip.clear()                                 removes it (also the chip's own button, Delete and Backspace)
//   chip.value                                   { kind, jobId } to send, or null
// Fires `u2-agent-context-removed` (bubbles) when the owner removes it, so the host can move focus.

const JOB_ID = /^job_[0-9a-f]{16}$/;
const KINDS = { job: 'Job' };

export class U2AgentContext extends HTMLElement {
  constructor() {
    super();
    this._context = null;
    this._label = '';
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.classList.add('agent-context');
    this._live = document.createElement('span');
    this._live.setAttribute('class', 'sr-only');
    this._live.setAttribute('role', 'status');
    this._live.setAttribute('aria-live', 'polite');
    this._chip = document.createElement('div');
    this._chip.setAttribute('class', 'agent-context__chip');
    this._chip.setAttribute('role', 'group');
    this._text = document.createElement('span');
    this._text.setAttribute('class', 'agent-context__text');
    this._remove = document.createElement('button');
    this._remove.setAttribute('type', 'button');
    this._remove.setAttribute('class', 'agent-context__remove');
    this._remove.setAttribute('data-action', 'remove-context');
    this._remove.textContent = '×';
    this._remove.addEventListener('click', () => this._removed());
    this._chip.addEventListener('keydown', (event) => {
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault?.(); this._removed(); }
    });
    this._chip.append(this._text, this._remove);
    this.append(this._live, this._chip);
    this._render();
  }

  get value() { return this._context ? { ...this._context } : null; }
  get label() { return this._label; }

  attach(context) {
    const { kind, jobId, label } = context && typeof context === 'object' ? context : {};
    if (!Object.hasOwn(KINDS, kind) || !JOB_ID.test(String(jobId ?? ''))) return false;
    this._context = { kind, jobId };
    this._label = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    this._render();
    this._live.textContent = `${KINDS[kind]} context attached: ${this._label || jobId}. It is sent with each message until you remove it.`;
    return true;
  }

  clear() {
    if (!this._context) return;
    this._context = null;
    this._label = '';
    this._render();
    this._live.textContent = 'Context removed. Messages are sent without it.';
  }

  _removed() {
    this.clear();
    this.dispatchEvent(new CustomEvent('u2-agent-context-removed', { bubbles: true }));
  }

  _render() {
    if (!this._built) return;
    this.hidden = !this._context;
    this._chip.hidden = !this._context;
    if (!this._context) return;
    const kind = KINDS[this._context.kind];
    const name = this._label || this._context.jobId;
    this._text.textContent = `${kind} context: ${name}`;
    this._chip.setAttribute('aria-label', `${kind} context attached to your messages`);
    this._remove.setAttribute('aria-label', `Remove ${kind.toLowerCase()} context: ${name}`);
    this._remove.title = 'Remove context';
  }
}

if (!customElements.get('u2-agent-context')) customElements.define('u2-agent-context', U2AgentContext);
