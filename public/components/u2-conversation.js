import { emptyState, formatDateTime } from './util.js';

export class U2Conversation extends HTMLElement {
  set data(value) { this._data = value || {}; this._render(); }
  get data() { return this._data || {}; }
  connectedCallback() { this._render(); }

  _render() {
    if (!this.isConnected && !this._data) return;
    const d = this.data; this.textContent = ''; this.classList.add('u2-domain-card');
    const header = document.createElement('header'); header.className = 'u2-domain-card__header';
    const title = document.createElement('strong'); title.textContent = d.thread || d.person || 'Conversation'; header.append(title); this.append(header);
    if (d.summary) this.append(field('Summary', d.summary));
    const messages = document.createElement('section'); const heading = document.createElement('h4'); heading.textContent = 'Latest messages'; messages.append(heading);
    if (!d.messages?.length) messages.insertAdjacentHTML('beforeend', emptyState('No messages supplied.'));
    else { const list = document.createElement('ul'); for (const message of d.messages) { const li = document.createElement('li'); li.textContent = `${message.sender || 'Unknown'}: ${message.text || ''}${message.at ? ` — ${formatDateTime(message.at)}` : ''}`; list.append(li); } messages.append(list); }
    this.append(messages);
    if (d.unresolvedQuestion) this.append(field('Unresolved question', d.unresolvedQuestion));
    if (d.nextStep) this.append(field('Possible next step', d.nextStep));
  }
}

function field(label, value) { const section = document.createElement('section'); const title = document.createElement('h4'); title.textContent = label; const body = document.createElement('p'); body.textContent = value; section.append(title, body); return section; }

customElements.define('u2-conversation', U2Conversation);
