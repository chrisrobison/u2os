import { escapeHtml } from './util.js';

const NOTIFY_TTL_MS = 6000;

// Renders what this browser's DeviceClientService (services/device-client.js)
// receives over the realtime device bus: ui.notify -> an auto-dismissing
// toast, ui.render -> a persistent, dismissible card, ui.prompt -> an
// interactive card whose answer is sent back as that command's result.
// Deliberately renders only fixed, known fields (never raw HTML) -- the
// same "generated UI, not generated code" rule every other dashboard
// component in this app follows; see docs/devices.md.
export class U2DevicePanel extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.innerHTML = `
      <div class="u2-device-panel__presentations" id="presentations"></div>
      <div class="u2-device-panel__prompts" id="prompts"></div>
      <div class="u2-device-panel__toasts" id="toasts"></div>
    `;
    this._presentations = this.querySelector('#presentations');
    this._prompts = this.querySelector('#prompts');
    this._toasts = this.querySelector('#toasts');
  }

  /** Wires this panel up to a DeviceClientService instance. Call once. */
  set client(service) {
    this._client = service;
    service.addEventListener('notify', (e) => this._addToast(e.detail));
    service.addEventListener('present', (e) => this._addPresentation(e.detail));
    service.addEventListener('prompt', (e) => this._addPrompt(e.detail));
  }

  _addToast({ title, body }) {
    const el = document.createElement('div');
    el.className = 'u2-card u2-device-toast';
    el.innerHTML = `<div class="u2-card__title">${escapeHtml(title)}</div>${body ? `<div>${escapeHtml(body)}</div>` : ''}`;
    this._toasts.appendChild(el);
    setTimeout(() => el.remove(), NOTIFY_TTL_MS);
  }

  _addPresentation({ content }) {
    const el = document.createElement('div');
    el.className = 'u2-card u2-device-presentation';
    const title = content && typeof content === 'object' ? content.title || content.type || 'Presentation' : 'Presentation';
    const body = content && typeof content === 'object' && content.body ? content.body : null;
    el.innerHTML = `
      <button type="button" class="icon-btn u2-device-presentation__dismiss" aria-label="Dismiss">&times;</button>
      <div class="u2-card__title">${escapeHtml(title)}</div>
      ${body ? `<div>${escapeHtml(body)}</div>` : `<pre>${escapeHtml(JSON.stringify(content, null, 2))}</pre>`}
    `;
    el.querySelector('.u2-device-presentation__dismiss').addEventListener('click', () => el.remove());
    this._presentations.appendChild(el);
  }

  _addPrompt({ requestId, question }) {
    const el = document.createElement('form');
    el.className = 'u2-card u2-device-prompt';
    el.innerHTML = `
      <div class="u2-card__title">${escapeHtml(question)}</div>
      <input type="text" name="answer" placeholder="Type a reply, or use a button" autocomplete="off">
      <div class="u2-device-prompt__actions">
        <button type="button" data-answer="yes">Yes</button>
        <button type="button" data-answer="no">No</button>
        <button type="submit">Send</button>
      </div>
    `;
    const respond = (answer) => {
      this._client.respondToPrompt(requestId, answer);
      el.remove();
    };
    el.querySelectorAll('button[data-answer]').forEach((btn) => btn.addEventListener('click', () => respond(btn.dataset.answer)));
    el.addEventListener('submit', (event) => {
      event.preventDefault();
      respond(el.answer.value);
    });
    this._prompts.appendChild(el);
  }
}

customElements.define('u2-device-panel', U2DevicePanel);
