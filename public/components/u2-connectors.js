import { escapeHtml, humanizeKey, formatDateTime } from './util.js';
import * as api from '../services/api.js';
import './u2-card.js';
import './u2-alert.js';
import './u2-connector-setup.js';

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
  const accountLabel = domain.activeInstanceId ? ctx.instanceLabels[domain.activeInstanceId] : null;

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
        <span>${escapeHtml(activeLabel)}${accountLabel ? ` · ${escapeHtml(accountLabel)}` : ''}</span>
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
    this._catalog = [];
    this._instanceLabels = {};
    this._banner = null; // { variant, message } from the OAuth redirect, shown once
    this._busySyncDomains = new Set();
    this._domainMessages = {}; // domain -> { text, isError } (provider switch / sync result)

    this._onChange = this._onChange.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onCatalogAction = this._onCatalogAction.bind(this);
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._consumeQueryBanner();
    this.addEventListener('change', this._onChange);
    this.addEventListener('click', this._onClick);
    this.addEventListener('connector-config-submit', this._onCatalogAction);
    this.addEventListener('connector-service-action', this._onCatalogAction);
    this.addEventListener('connector-disconnect', this._onCatalogAction);
    this.addEventListener('connector-instances-changed', () => {
      this._refreshStatus().catch((err) => {
        this._banner = { variant: 'warning', message: `Couldn't refresh connector status: ${err.message}` };
      });
    });
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
      const { connectors, smtpConfigured, catalog } = await api.getConnectors();
      this._connectors = connectors;
      this._smtpConfigured = !!smtpConfigured;
      this._catalog = catalog?.connectors || [];
      await this._loadInstanceLabels();
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load connectors: ${escapeHtml(err.message)}</div>`;
    }
  }

  async _loadInstanceLabels() {
    const definitions = this._catalog.filter((entry) => entry.status === 'available' && entry.accountMode === 'multiple');
    const lists = await Promise.all(definitions.map(async (entry) => {
      try { return (await api.listConnectorInstances(entry.id)).instances || []; }
      catch { return []; }
    }));
    this._instanceLabels = Object.fromEntries(lists.flat().map((entry) => [entry.id, entry.label]));
  }

  async _refreshStatus() {
    const { connectors, smtpConfigured, catalog } = await api.getConnectors();
    this._connectors = connectors;
    this._smtpConfigured = !!smtpConfigured;
    this._catalog = catalog?.connectors || [];
    await this._loadInstanceLabels();
    for (const domain of connectors) {
      const card = this.querySelector(`u2-card[title="${DOMAIN_LABELS[domain.domain]}"]`);
      if (card) card.outerHTML = renderDomainCard(domain, { busySyncDomains: this._busySyncDomains, domainMessages: this._domainMessages, instanceLabels: this._instanceLabels });
    }
    for (const definition of this._catalog) {
      const row = this.querySelector(`[data-catalog-id="${definition.id}"]`);
      if (row) row.outerHTML = this._renderCatalogRow(definition);
    }
    this.querySelector('u2-connector-setup')?.setDomains(connectors);
  }

  _render() {
    const connectors = this._connectors || [];
    const ctx = {
      busySyncDomains: this._busySyncDomains,
      domainMessages: this._domainMessages,
      smtpConfigured: this._smtpConfigured,
      instanceLabels: this._instanceLabels,
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
      <div class="connectors__section-title">Connector catalog</div>
      <div class="connector-table" role="list">${this._catalog.map((definition) => this._renderCatalogRow(definition)).join('')}</div>
      <u2-connector-setup></u2-connector-setup>
    `;
  }

  _renderCatalogRow(definition) {
    const state = this._catalogState(definition);
    return `<button class="connector-catalog-row" type="button" role="listitem" data-catalog-id="${escapeHtml(definition.id)}"><span class="status-dot ${state.connected ? 'is-connected' : 'is-disconnected'}"></span><span class="connector-catalog-row__main"><strong>${escapeHtml(definition.name)}</strong><small>${escapeHtml(definition.description || '')}</small></span><span class="connector-catalog-row__meta">${definition.status === 'available' ? (state.connected ? 'Connected' : 'Configure') : 'Planned'}</span></button>`;
  }

  _catalogState(definition) {
    const connectedProviders = (this._connectors || []).flatMap((entry) => entry.connectedProviders || []);
    if (definition.id === 'google') return { connected: definition.setup.services.some((service) => connectedProviders.includes(service.providerId)), connectedProviders };
    if (definition.id === 'smtp') return { connected: this._smtpConfigured, connectedProviders };
    return { connected: connectedProviders.includes(definition.id), connectedProviders };
  }

  _onChange(e) {
    const select = e.target.closest('select[data-provider-domain]');
    if (!select) return;
    this._changeProvider(select.dataset.providerDomain, select);
  }

  _onClick(e) {
    const catalogRow = e.target.closest('[data-catalog-id]');
    if (catalogRow) {
      const definition = this._catalog.find((item) => item.id === catalogRow.dataset.catalogId);
      this.querySelector('u2-connector-setup').open(definition, { ...this._catalogState(definition), domains: this._connectors });
      return;
    }
    const syncBtn = e.target.closest('button[data-sync-domain]');
    if (syncBtn) {
      this._sync(syncBtn.dataset.syncDomain);
      return;
    }

  }

  async _onCatalogAction(event) {
    event.stopPropagation();
    const { connector } = event.detail;
    try {
      if (event.type === 'connector-config-submit') {
        await api.saveConnectorConfig(connector.setup.credentialEndpoint, event.detail.values);
        event.detail.form.reset();
      } else if (event.type === 'connector-disconnect') {
        await api.runConnectorAction(connector.setup.disconnectEndpoint);
      } else if (event.detail.action === 'connect') {
        window.location.href = `/api/connectors/google/oauth/start?service=${encodeURIComponent(event.detail.service)}`;
        return;
      } else {
        await api.runConnectorAction(`/api/connectors/google/disconnect?service=${encodeURIComponent(event.detail.service)}`);
      }
      this.querySelector('u2-connector-setup').close();
      await this._load();
    } catch (err) {
      const message = event.detail.form?.querySelector('[data-message]');
      if (message) message.textContent = err.message;
    }
  }

  async _changeProvider(domain, selectEl) {
    const entry = (this._connectors || []).find((d) => d.domain === domain);
    const previous = entry ? entry.active : selectEl.value;
    const providerId = selectEl.value;

    selectEl.disabled = true;
    try {
      if (providerId !== 'mock') {
        const connectorId = this._catalog.find((entry) => entry.id === providerId || entry.setup?.services?.some((service) => service.providerId === providerId))?.id;
        const instances = (await api.listConnectorInstances(connectorId)).instances || [];
        const service = this._catalog.find((entry) => entry.id === connectorId)?.setup?.services?.find((entry) => entry.providerId === providerId);
        const eligible = instances.filter((instance) => service ? instance.services?.[service.id] : instance.status === 'connected');
        if (eligible.length !== 1) throw new Error(eligible.length ? 'Choose a named account in the connector setup dialog.' : 'Connect an account in the connector setup dialog first.');
        await api.setActiveProvider(domain, providerId, { connectorId, instanceId: eligible[0].id });
      } else {
        await api.setActiveProvider(domain, providerId);
      }
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

}

customElements.define('u2-connectors', U2Connectors);
