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
    if (this._bound) return;
    this._bound = true;
    // `selectable` rows are buttons that announce the chosen message (#436).
    this.addEventListener('click', (event) => {
      if (!this.hasAttribute('selectable')) return;
      const row = event.target.closest('[data-email-id]');
      const email = row && this._emails.find((e) => e.id === row.dataset.emailId);
      if (email) this.dispatchEvent(new CustomEvent('u2-email-select', { bubbles: true, detail: { email, opener: row } }));
    });
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
        const selectable = this.hasAttribute('selectable');
        const tag = selectable ? 'button type="button"' : 'div';
        return `
          <${tag} class="u2-email${selectable ? ' u2-email--select' : ''}" data-email-id="${escapeHtml(email.id)}">
            <div class="u2-email__from-row">
              <span class="u2-email__from ${unread ? 'is-unread' : ''}">${escapeHtml(from)}</span>
              <span class="u2-email__time">${escapeHtml(when)}</span>
            </div>
            <div class="u2-email__subject ${unread ? 'is-unread' : ''}">${escapeHtml(email.subject || '(no subject)')}</div>
          </${selectable ? 'button' : 'div'}>
        `;
      })
      .join('');
  }
}

customElements.define('u2-email-summary', U2EmailSummary);
