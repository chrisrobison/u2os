import { escapeHtml, formatDateTime, emptyState } from './util.js';

// property `emails` -> array as returned by GET /api/email.
export class U2EmailSummary extends HTMLElement {
  constructor() {
    super();
    this._emails = [];
  }

  set emails(list) {
    this._emails = Array.isArray(list) ? list : [];
    this._render();
  }

  get emails() {
    return this._emails;
  }

  connectedCallback() {
    this._render();
  }

  _render() {
    this.classList.add('u2-email-list');
    if (!this._emails.length) {
      this.innerHTML = emptyState('No email here.');
      return;
    }

    this.innerHTML = this._emails
      .map((email) => {
        const unread = !email.is_read;
        const from = email.from_addr || 'Unknown sender';
        const when = formatDateTime(email.received_at);
        return `
          <div class="u2-email">
            <div class="u2-email__from-row">
              <span class="u2-email__from ${unread ? 'is-unread' : ''}">${escapeHtml(from)}</span>
              <span class="u2-email__time">${escapeHtml(when)}</span>
            </div>
            <div class="u2-email__subject ${unread ? 'is-unread' : ''}">${escapeHtml(email.subject || '(no subject)')}</div>
          </div>
        `;
      })
      .join('');
  }
}

customElements.define('u2-email-summary', U2EmailSummary);
