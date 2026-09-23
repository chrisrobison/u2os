import { escapeHtml, humanizeKey, formatDateTime } from './util.js';
import * as api from '../services/api.js';
import './u2-card.js';
import './u2-alert.js';

const DOMAIN_LABELS = {
  calendar: 'Calendar',
  email: 'Email',
  contacts: 'Contacts',
  web: 'Web Search',
  notifications: 'Notifications',
};

// calendar/email/contacts support syncChanges(); web/notifications are
// call-and-response only, per docs/connectors.md -- no sync button for
// those two, ever.
const SYNCABLE_DOMAINS = new Set(['calendar', 'email', 'contacts']);

// One Google OAuth client covers all three services (docs/connectors.md's
// OAuth2 flow section); each service has its own domain, provider id, and
// independent connect/disconnect state.
const GOOGLE_SERVICES = [
  { service: 'calendar', domain: 'calendar', providerId: 'google-calendar', label: 'Calendar' },
  { service: 'gmail', domain: 'email', providerId: 'gmail', label: 'Gmail' },
  { service: 'contacts', domain: 'contacts', providerId: 'google-contacts', label: 'Contacts' },
];

function providerLabel(domain, providerId) {
  if (providerId === 'mock') return 'Mock';
  const manifest = (domain.manifests || []).find((m) => m.id === providerId);
  return manifest?.name || providerId;
}

function renderProviderOptions(domain) {
  return (domain.availableProviders || [])
    .map((id) => {
      const isMock = id === 'mock';
      const manifest = isMock ? null : (domain.manifests || []).find((m) => m.id === id);
      const isStub = manifest?.status === 'stub';
      const label = isMock ? 'Mock' : manifest?.name || id;
      const suffix = isStub ? ' (coming soon)' : '';
      const selected = id === domain.active ? ' selected' : '';
      const disabled = isStub ? ' disabled' : '';
      return `<option value="${escapeHtml(id)}"${selected}${disabled}>${escapeHtml(label + suffix)}</option>`;
    })
    .join('');
}

function renderDomainCard(domain, ctx) {
  const label = DOMAIN_LABELS[domain.domain] || humanizeKey(domain.domain);
  const activeLabel = providerLabel(domain, domain.active);
  const dotClass = domain.connected ? 'is-connected' : 'is-disconnected';

  const metaLines = [];
  if (domain.lastSyncAt) {
    metaLines.push(`<div class="connector-meta mono">Last synced ${escapeHtml(formatDateTime(domain.lastSyncAt))}</div>`);
  }
  if (domain.lastError) {
    metaLines.push(`<div class="connector-meta mono is-error">${escapeHtml(domain.lastError)}</div>`);
  }

  const showSync = SYNCABLE_DOMAINS.has(domain.domain) && domain.active !== 'mock';
  const busy = ctx.busySyncDomains.has(domain.domain);
  const message = ctx.domainMessages[domain.domain];

  return `
    <u2-card title="${escapeHtml(label)}">
      <div class="connector-status">
        <span class="status-dot ${dotClass}"></span>
        <span>${escapeHtml(activeLabel)}</span>
      </div>
      ${metaLines.join('')}
      <div class="connector-controls">
        <select class="connector-select" data-provider-domain="${escapeHtml(domain.domain)}">
          ${renderProviderOptions(domain)}
        </select>
        ${
          showSync
            ? `<button type="button" class="btn" data-sync-domain="${escapeHtml(domain.domain)}" ${busy ? 'disabled' : ''}>${busy ? 'Syncing...' : 'Sync now'}</button>`
            : ''
        }
      </div>
      ${message ? `<span class="connector-inline-message${message.isError ? ' is-error' : ''}">${escapeHtml(message.text)}</span>` : ''}
    </u2-card>
  `;
}

function renderGoogleCard(connectors, ctx) {
  const rows = GOOGLE_SERVICES.map(({ service, domain, providerId, label }) => {
    const domainEntry = connectors.find((d) => d.domain === domain);
    const connectedViaGoogle = !!domainEntry && (domainEntry.connectedProviders || []).includes(providerId);
    const busy = ctx.busyKeys.has(`google:${service}`);
    const action = connectedViaGoogle
      ? `<button type="button" class="btn" data-google-disconnect="${service}" ${busy ? 'disabled' : ''}>${busy ? 'Disconnecting...' : 'Disconnect'}</button>`
      : `<button type="button" class="btn btn-primary" data-google-connect="${service}">Connect</button>`;
    return `
      <div class="connector-google-row">
        <span class="connector-google-row__status">
          <span class="status-dot ${connectedViaGoogle ? 'is-connected' : 'is-disconnected'}"></span>
          ${escapeHtml(label)}
        </span>
        ${action}
      </div>
    `;
  }).join('');

  const formMsg = ctx.formMessages.google;

  return `
    <u2-card title="Google">
      <form data-form="google-credentials" class="connector-form" autocomplete="off">
        <label class="connector-field">
          <span>Client ID</span>
          <input type="text" name="clientId" placeholder="Paste your OAuth client ID" autocomplete="off" required>
        </label>
        <label class="connector-field">
          <span>Client secret</span>
          <input type="password" name="clientSecret" placeholder="Paste your client secret" autocomplete="off" required>
        </label>
        <div class="connector-form__actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <span class="connector-form__message${formMsg?.isError ? ' is-error' : ''}" data-message>${formMsg ? escapeHtml(formMsg.text) : ''}</span>
        </div>
      </form>
      <div class="connector-google-services">
        ${rows}
      </div>
    </u2-card>
  `;
}

function renderBraveCard(ctx) {
  const formMsg = ctx.formMessages.webSearch;
  return `
    <u2-card title="Brave Search">
      <form data-form="web-search-credentials" class="connector-form" autocomplete="off">
        <label class="connector-field">
          <span>API key</span>
          <input type="password" name="apiKey" placeholder="Paste your Brave Search API key" autocomplete="off" required>
        </label>
        <div class="connector-form__actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <span class="connector-form__message${formMsg?.isError ? ' is-error' : ''}" data-message>${formMsg ? escapeHtml(formMsg.text) : ''}</span>
        </div>
      </form>
    </u2-card>
  `;
}

function renderImapCard(ctx) {
  const formMsg = ctx.formMessages.imap;
  return `
    <u2-card title="IMAP inbox (read-only)">
      <form data-form="imap-credentials" class="connector-form" autocomplete="off">
        <label class="connector-field"><span>Mail host (TLS port 993)</span><input name="host" placeholder="imap.example.com" autocomplete="off" required></label>
        <label class="connector-field"><span>Username</span><input name="username" autocomplete="off" required></label>
        <label class="connector-field"><span>App password</span><input type="password" name="password" autocomplete="off" required></label>
        <div class="connector-form__actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn" data-imap-disconnect>Disconnect</button>
          <span class="connector-form__message${formMsg?.isError ? ' is-error' : ''}" data-message>${formMsg ? escapeHtml(formMsg.text) : ''}</span>
        </div>
      </form>
    </u2-card>
  `;
}

function renderSmtpCard(ctx) {
  const formMsg = ctx.formMessages.smtp;
  return `
    <u2-card title="SMTP sending">
      <div class="connector-status"><span class="status-dot ${ctx.smtpConfigured ? 'is-connected' : 'is-disconnected'}"></span><span>${ctx.smtpConfigured ? 'Configured for IMAP account' : 'Not configured'}</span></div>
      <form data-form="smtp-credentials" class="connector-form" autocomplete="off">
        <label class="connector-field"><span>Mail host</span><input name="host" placeholder="smtp.example.com" autocomplete="off" required></label>
        <label class="connector-field"><span>Port</span><select name="port"><option value="465">465 (TLS)</option><option value="587">587 (STARTTLS required)</option></select></label>
        <label class="connector-field"><span>Username</span><input name="username" autocomplete="off" required></label>
        <label class="connector-field"><span>App password</span><input type="password" name="password" autocomplete="off" required></label>
        <label class="connector-field"><span>From address</span><input type="email" name="from" autocomplete="off" required></label>
        <div class="connector-form__actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn" data-smtp-disconnect>Disconnect</button>
          <span class="connector-form__message${formMsg?.isError ? ' is-error' : ''}" data-message>${formMsg ? escapeHtml(formMsg.text) : ''}</span>
        </div>
      </form>
    </u2-card>
  `;
}

function renderNotifyCard(ctx) {
  const formMsg = ctx.formMessages.notify;
  return `
    <u2-card title="Notifications webhook">
      <form data-form="notify-webhook-credentials" class="connector-form" autocomplete="off">
        <label class="connector-field">
          <span>Webhook URL</span>
          <input type="url" name="webhookUrl" placeholder="https://ntfy.sh/your-topic" autocomplete="off" required>
        </label>
        <label class="connector-field">
          <span>Format</span>
          <select name="format">
            <option value="json">JSON</option>
            <option value="ntfy">ntfy (ntfy.sh)</option>
          </select>
        </label>
        <div class="connector-form__actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <span class="connector-form__message${formMsg?.isError ? ' is-error' : ''}" data-message>${formMsg ? escapeHtml(formMsg.text) : ''}</span>
        </div>
      </form>
    </u2-card>
  `;
}

// Settings page for Phase 3's real connectors (docs/connectors.md). Fetches
// its own data (GET /api/connectors) and owns all of its state -- the same
// "self-fetching custom element" pattern u2-timeline uses in standalone
// mode -- so u2-app just mounts <u2-connectors> and gets out of the way.
// Any mutating action (switch provider, sync, disconnect) re-fetches and
// re-renders the whole page rather than hand-patching state, the simplest
// correct approach for a settings page that isn't on a hot path.
export class U2Connectors extends HTMLElement {
  constructor() {
    super();
    this._connectors = null;
    this._smtpConfigured = false;
    this._banner = null; // { variant, message } from the OAuth redirect, shown once
    this._busySyncDomains = new Set();
    this._busyKeys = new Set(); // e.g. "google:calendar" while disconnecting
    this._domainMessages = {}; // domain -> { text, isError } (provider switch / sync result)
    this._formMessages = { google: null, imap: null, smtp: null, webSearch: null, notify: null };

    this._onChange = this._onChange.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._consumeQueryBanner();
    this.addEventListener('change', this._onChange);
    this.addEventListener('click', this._onClick);
    this.addEventListener('submit', this._onSubmit);
    this._load();
  }

  // Reads `connected=<service>` / `error=<message>` off the current hash's
  // query string (left there by the Google OAuth callback redirect per
  // docs/connectors.md), stages a one-time banner, then strips the query
  // string so a refresh doesn't re-show it.
  _consumeQueryBanner() {
    const hash = window.location.hash || '';
    const qIndex = hash.indexOf('?');
    if (qIndex === -1) return;

    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const connected = params.get('connected');
    const error = params.get('error');

    if (connected) {
      this._banner = { variant: 'info', message: `Connected ${humanizeKey(connected)} successfully.` };
    } else if (error) {
      this._banner = { variant: 'warning', message: `Connection failed: ${humanizeKey(error)}.` };
    }

    if (connected || error) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/connectors`);
    }
  }

  async _load() {
    this.innerHTML = `<div class="empty-state">Loading connectors...</div>`;
    try {
      const { connectors, smtpConfigured } = await api.getConnectors();
      this._connectors = connectors;
      this._smtpConfigured = !!smtpConfigured;
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load connectors: ${escapeHtml(err.message)}</div>`;
    }
  }

  _render() {
    const connectors = this._connectors || [];
    const ctx = {
      busySyncDomains: this._busySyncDomains,
      domainMessages: this._domainMessages,
      busyKeys: this._busyKeys,
      formMessages: this._formMessages,
      smtpConfigured: this._smtpConfigured,
    };

    const bannerHtml = this._banner
      ? `<u2-alert variant="${escapeHtml(this._banner.variant)}" message="${escapeHtml(this._banner.message)}"></u2-alert>`
      : '';

    const domainCards = connectors.map((d) => renderDomainCard(d, ctx)).join('');

    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Connectors</div>
        <div class="workspace__subtitle">Real accounts instead of built-in mock data</div>
      </div>
      ${bannerHtml}
      <p class="connectors__intro">
        Connect U2OS to your real Google Calendar, Gmail, and Contacts, to Brave web search, and to a webhook for
        notifications. Everything here is optional -- the built-in mock providers keep working forever if you never
        connect anything real. Credentials you paste in below stay on this machine, encrypted at rest, and are sent
        only directly to the provider you're connecting to -- U2OS never runs a cloud relay for your accounts. For
        step-by-step Google Cloud Console setup and the full details of what each connector needs, see
        <span class="mono">docs/connectors.md</span>.
      </p>
      <div class="connectors__grid">${domainCards}</div>
      <div class="connectors__section-title">Google</div>
      <div class="connectors__grid">${renderGoogleCard(connectors, ctx)}</div>
      <div class="connectors__section-title">Mail</div>
      <div class="connectors__grid">${renderImapCard(ctx)}${renderSmtpCard(ctx)}</div>
      <div class="connectors__section-title">Web &amp; notifications</div>
      <div class="connectors__grid">
        ${renderBraveCard(ctx)}
        ${renderNotifyCard(ctx)}
      </div>
    `;
  }

  _onChange(e) {
    const select = e.target.closest('select[data-provider-domain]');
    if (!select) return;
    this._changeProvider(select.dataset.providerDomain, select);
  }

  _onClick(e) {
    if (e.target.closest('button[data-smtp-disconnect]')) {
      this._disconnectSmtp();
      return;
    }
    if (e.target.closest('button[data-imap-disconnect]')) {
      this._disconnectImap();
      return;
    }
    const syncBtn = e.target.closest('button[data-sync-domain]');
    if (syncBtn) {
      this._sync(syncBtn.dataset.syncDomain);
      return;
    }

    const connectBtn = e.target.closest('button[data-google-connect]');
    if (connectBtn) {
      // Full-page navigation, not a fetch -- the user needs to see and
      // interact with Google's real consent screen.
      window.location.href = `/api/connectors/google/oauth/start?service=${encodeURIComponent(connectBtn.dataset.googleConnect)}`;
      return;
    }

    const disconnectBtn = e.target.closest('button[data-google-disconnect]');
    if (disconnectBtn) {
      this._disconnectGoogle(disconnectBtn.dataset.googleDisconnect);
    }
  }

  _onSubmit(e) {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();

    switch (form.dataset.form) {
      case 'google-credentials':
        this._submitGoogleCredentials(form);
        break;
      case 'web-search-credentials':
        this._submitWebSearchCredentials(form);
        break;
      case 'imap-credentials':
        this._submitImapCredentials(form);
        break;
      case 'smtp-credentials':
        this._submitSmtpCredentials(form);
        break;
      case 'notify-webhook-credentials':
        this._submitNotifyWebhookCredentials(form);
        break;
      default:
        break;
    }
  }

  async _changeProvider(domain, selectEl) {
    const entry = (this._connectors || []).find((d) => d.domain === domain);
    const previous = entry ? entry.active : selectEl.value;
    const providerId = selectEl.value;

    selectEl.disabled = true;
    try {
      await api.setActiveProvider(domain, providerId);
      this._domainMessages[domain] = null;
      await this._load();
    } catch (err) {
      this._domainMessages[domain] = { text: err.message, isError: true };
      selectEl.disabled = false;
      selectEl.value = previous;
      this._render();
    }
  }

  async _sync(domain) {
    if (this._busySyncDomains.has(domain)) return;
    this._busySyncDomains.add(domain);
    this._domainMessages[domain] = null;
    this._render();

    try {
      const result = await api.triggerSync(domain);
      const count = typeof result?.synced === 'number' ? result.synced : null;
      this._domainMessages[domain] = {
        text: count !== null ? `Synced ${count} item${count === 1 ? '' : 's'}.` : 'Sync complete.',
        isError: false,
      };
    } catch (err) {
      this._domainMessages[domain] = { text: err.message, isError: true };
    } finally {
      this._busySyncDomains.delete(domain);
    }

    await this._load();
  }

  async _disconnectGoogle(service) {
    const key = `google:${service}`;
    if (this._busyKeys.has(key)) return;
    this._busyKeys.add(key);
    this._render();

    try {
      await api.disconnectGoogleService(service);
    } catch (err) {
      this._formMessages.google = { text: err.message, isError: true };
    } finally {
      this._busyKeys.delete(key);
    }

    await this._load();
  }

  async _submitGoogleCredentials(form) {
    const clientId = form.elements.clientId.value.trim();
    const clientSecret = form.elements.clientSecret.value.trim();
    await this._submitCredentialForm(form, 'google', () => api.saveGoogleCredentials({ clientId, clientSecret }));
  }

  async _submitWebSearchCredentials(form) {
    const apiKey = form.elements.apiKey.value.trim();
    await this._submitCredentialForm(form, 'webSearch', () => api.saveWebSearchCredentials({ apiKey }));
  }

  async _submitImapCredentials(form) {
    const host = form.elements.host.value.trim();
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    await this._submitCredentialForm(form, 'imap', () => api.saveImapCredentials({ host, username, password }));
  }

  async _disconnectImap() {
    try {
      await api.disconnectImap();
      this._formMessages.imap = { text: 'Disconnected.', isError: false };
    } catch (err) {
      this._formMessages.imap = { text: err.message, isError: true };
    }
    await this._load();
  }

  async _submitSmtpCredentials(form) {
    const host = form.elements.host.value.trim();
    const port = Number(form.elements.port.value);
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    const from = form.elements.from.value.trim();
    await this._submitCredentialForm(form, 'smtp', () => api.saveSmtpCredentials({ host, port, username, password, from }));
    await this._load();
  }

  async _disconnectSmtp() {
    try {
      await api.disconnectSmtp();
      this._formMessages.smtp = { text: 'Disconnected.', isError: false };
    } catch (err) {
      this._formMessages.smtp = { text: err.message, isError: true };
    }
    await this._load();
  }

  async _submitNotifyWebhookCredentials(form) {
    const webhookUrl = form.elements.webhookUrl.value.trim();
    const format = form.elements.format.value;
    await this._submitCredentialForm(form, 'notify', () => api.saveNotifyWebhookCredentials({ webhookUrl, format }));
  }

  // Shared submit lifecycle for the three write-only credential forms:
  // disable Save while in flight, show a brief inline message after, and
  // clear the form on success so secrets never linger in the input longer
  // than the user's own typing.
  async _submitCredentialForm(form, key, request) {
    const btn = form.querySelector('button[type="submit"]');
    const msgEl = form.querySelector('[data-message]');
    btn.disabled = true;
    msgEl.textContent = '';
    msgEl.classList.remove('is-error');

    try {
      await request();
      form.reset();
      msgEl.textContent = 'Saved.';
      this._formMessages[key] = { text: 'Saved.', isError: false };
    } catch (err) {
      msgEl.textContent = err.message;
      msgEl.classList.add('is-error');
      this._formMessages[key] = { text: err.message, isError: true };
    } finally {
      btn.disabled = false;
    }
  }
}

customElements.define('u2-connectors', U2Connectors);
