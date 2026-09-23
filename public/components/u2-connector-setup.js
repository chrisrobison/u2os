import { escapeHtml } from './util.js';
import * as api from '../services/api.js';

function renderField(field) {
  const required = field.required === false ? '' : ' required';
  if (field.type === 'select') {
    const options = (field.options || []).map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
    return `<label class="connector-field"><span>${escapeHtml(field.label)}</span><select name="${escapeHtml(field.key)}"${required}>${options}</select></label>`;
  }
  return `<label class="connector-field"><span>${escapeHtml(field.label)}</span><input name="${escapeHtml(field.key)}" type="${escapeHtml(field.type || 'text')}" placeholder="${escapeHtml(field.placeholder || '')}" autocomplete="off"${required}></label>`;
}

function statusDotClass(status) {
  if (status === 'connected') return 'is-connected';
  if (status === 'error') return 'is-error';
  return 'is-disconnected';
}

// issue #163 PR 5: multiple named accounts per connector. For a catalog
// entry with accountMode: 'multiple' (google, imap, smtp, webhook, brave-search),
// this dialog fetches and manages its OWN "Accounts" list (GET/POST/PATCH/
// DELETE /api/connectors/:connectorId/instances) -- the parent
// (u2-connectors.js) only ever needs to know that something changed, via the
// bubbling `connector-instances-changed` event, so it can refresh its own
// unrelated top-level state (domain cards, catalog dots). A connector with
// accountMode: 'single' (unavailable/planned entries) keeps the
// original single-credential-form UI, driven by the same
// `connector-config-submit`/`connector-disconnect` events this component has
// always dispatched -- the parent still owns those requests.
//
// SECURITY: never render a decrypted credential/token value anywhere in this
// component -- every field here is either a fresh value the owner is about
// to submit, or non-secret instance metadata (id/label/status) the backend
// already guarantees is secret-free (see connection-instances.js's
// toInstanceApiShape()).
export class U2ConnectorSetup extends HTMLElement {
  constructor() {
    super();
    this._definition = null;
    this._state = {};
    this._resetInstanceState();
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  _resetInstanceState() {
    this._instances = null;
    this._smtpInstances = [];
    this._instancesLoading = false;
    this._instancesError = null;
    this._showAddForm = false;
    this._addBusy = false;
    this._addFormMessage = null;
    this._renamingId = null;
    this._reconnectingId = null;
    this._busyIds = new Set();
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.innerHTML = '<dialog class="connector-dialog"></dialog>';
    this.addEventListener('click', this._onClick);
    this.addEventListener('submit', this._onSubmit);
  }

  open(definition, state = {}) {
    this._definition = definition;
    this._state = state;
    this._resetInstanceState();
    this._render();
    this.querySelector('dialog').showModal();
    if (definition.status === 'available' && definition.accountMode === 'multiple') {
      this._loadInstances();
    }
  }

  close() { this.querySelector('dialog')?.close(); }

  async _loadInstances() {
    this._instancesLoading = true;
    this._instancesError = null;
    this._render();
    try {
      const { instances } = await api.listConnectorInstances(this._definition.id);
      this._instances = instances;
      if (this._definition.id === 'imap') {
        const smtp = await api.listConnectorInstances('smtp');
        this._smtpInstances = smtp.instances.filter((row) => row.status === 'connected');
      }
    } catch (err) {
      this._instancesError = err.message;
      this._instances ||= [];
    } finally {
      this._instancesLoading = false;
      this._render();
    }
  }

  _notifyChanged() {
    this.dispatchEvent(new CustomEvent('connector-instances-changed', { bubbles: true, detail: { connector: this._definition } }));
  }

  _render() {
    const dialog = this.querySelector('dialog');
    const restoreCloseFocus = dialog?.open && document.activeElement?.matches?.('[data-close]');
    const d = this._definition;
    const setup = d.setup || {};
    const unavailable = d.status !== 'available';
    const capabilities = (d.capabilities || []).map((capability) => `<span class="connector-chip">${escapeHtml(capability)}</span>`).join('');

    let mainHtml;
    if (unavailable) {
      mainHtml = '<p class="connector-planned">This connector is in the catalog but its adapter is not available yet.</p>';
    } else if (d.accountMode === 'multiple') {
      const topForm = d.id === 'google' && this._instances && !this._instancesLoading ? this._renderTopForm(setup) : '';
      mainHtml = `${topForm}${this._renderAccountsSection(setup)}`;
    } else {
      mainHtml = this._renderSingleForm(setup);
    }

    dialog.innerHTML = `
      <div class="connector-dialog__header"><div><h2>${escapeHtml(d.name)}</h2><p>${escapeHtml(d.description || '')}</p></div><button class="btn" type="button" data-close aria-label="Close connector setup">Close</button></div>
      <div class="connector-capabilities">${capabilities}</div>
      ${mainHtml}
    `;
    if (restoreCloseFocus) dialog.querySelector('[data-close]')?.focus();
  }

  _renderSingleForm(setup) {
    const fields = (setup.fields || []).map(renderField).join('');
    if (!fields) return '';
    const disconnectBtn = this._state.connected && setup.disconnectEndpoint ? '<button class="btn" type="button" data-disconnect>Disconnect</button>' : '';
    return `<form class="connector-form" data-connector-form>${fields}<div class="connector-form__actions"><button class="btn btn-primary" type="submit">Save configuration</button>${disconnectBtn}<span data-message></span></div></form>`;
  }

  // google's OAuth client id/secret: one shared credential pair for the
  // whole connector, orthogonal to the per-account Accounts list below it.
  _renderTopForm(setup) {
    const fields = (setup.fields || []).map(renderField).join('');
    if (!fields) return '';
    return `
      <div class="connectors__section-title">OAuth client</div>
      <form class="connector-form" data-connector-form>${fields}<div class="connector-form__actions"><button class="btn btn-primary" type="submit">Save client</button><span data-message></span></div></form>
    `;
  }

  _renderAccountsSection(setup) {
    let body;
    if (this._instancesLoading && !this._instances) {
      body = '<div class="connector-account-empty">Loading accounts...</div>';
    } else if (!this._instances || !this._instances.length) {
      body = '<div class="connector-account-empty">No accounts yet.</div>';
    } else {
      body = this._instances.map((instance) => this._renderInstanceRow(instance)).join('');
    }

    const addFormFields = this._definition.id === 'google' ? '' : (setup.fields || []).map(renderField).join('');
    const addAction = this._showAddForm
      ? `<form class="connector-form connector-add-account-form" data-add-instance-form>
          <label class="connector-field"><span>Label</span><input name="label" required maxlength="200" placeholder="e.g. Work" autocomplete="off"></label>
          ${addFormFields}
          <div class="connector-form__actions">
            <button class="btn btn-primary" type="submit" ${this._addBusy ? 'disabled' : ''}>Add account</button>
            <button class="btn" type="button" data-cancel-add>Cancel</button>
            <span data-add-message${this._addFormMessage ? ' class="connector-form__message is-error"' : ''}>${escapeHtml(this._addFormMessage || '')}</span>
          </div>
        </form>`
      : '<button class="btn btn-primary" type="button" data-show-add-account>Add account</button>';

    return `
      <div class="connectors__section-title">Accounts</div>
      ${this._instancesError ? `<div class="connector-account-empty is-error" role="alert">${escapeHtml(this._instancesError)}</div>` : ''}
      <div class="connector-accounts">${body}</div>
      ${addAction}
    `;
  }

  _renderInstanceRow(instance) {
    const busy = this._busyIds.has(instance.id);
    const renaming = this._renamingId === instance.id;
    const labelHtml = renaming
      ? `<form class="connector-account-rename" data-rename-form="${escapeHtml(instance.id)}">
          <input name="label" value="${escapeHtml(instance.label)}" required maxlength="200" autocomplete="off">
          <button class="btn" type="submit" ${busy ? 'disabled' : ''}>Save</button>
          <button class="btn" type="button" data-cancel-rename>Cancel</button>
        </form>`
      : `<span class="connector-account__label">${escapeHtml(instance.label)}</span>`;
    const actions = renaming ? '' : `
      <div class="connector-account__actions">
        <button class="btn" type="button" data-rename-instance="${escapeHtml(instance.id)}" ${busy ? 'disabled' : ''}>Rename</button>
        ${this._definition.id === 'google' ? '' : `<button class="btn" type="button" data-reconnect-instance="${escapeHtml(instance.id)}" ${busy ? 'disabled' : ''}>Update credentials</button>`}
        <button class="btn btn-danger" type="button" data-remove-instance="${escapeHtml(instance.id)}" ${busy ? 'disabled' : ''}>Remove</button>
      </div>`;
    const errorLine = instance.lastError ? `<div class="connector-meta is-error">${escapeHtml(instance.lastError)}</div>` : '';
    const services = this._definition.id === 'google' ? this._renderGoogleServices(instance) : this._renderAccountRouting(instance);
    const sender = this._definition.id === 'imap' ? this._renderSmtpPair(instance) : '';

    return `<div class="connector-account" data-instance-id="${escapeHtml(instance.id)}">
      <div class="connector-account__row">
        <span class="status-dot ${statusDotClass(instance.status)}"></span>
        ${labelHtml}
        ${actions}
      </div>
      ${errorLine}
      ${this._reconnectingId === instance.id ? `<form class="connector-form" data-reconnect-form="${escapeHtml(instance.id)}">${(this._definition.setup.fields || []).map(renderField).join('')}<div class="connector-form__actions"><button class="btn btn-primary" type="submit">Save credentials</button><button class="btn" type="button" data-cancel-reconnect>Cancel</button></div></form>` : ''}
      ${services}
      ${sender}
    </div>`;
  }

  _renderSmtpPair(instance) {
    const options = this._smtpInstances.map((row) => `<option value="${escapeHtml(row.id)}" ${instance.smtpInstanceId === row.id ? 'selected' : ''}>${escapeHtml(row.label)}</option>`).join('');
    const unavailable = instance.smtpInstanceId && !this._smtpInstances.some((row) => row.id === instance.smtpInstanceId);
    return `<form class="connector-account-sender" data-smtp-pair-form="${escapeHtml(instance.id)}">
      <label class="connector-field"><span>SMTP sender for this inbox</span><select name="smtpInstanceId">
        <option value="" ${!instance.smtpInstanceId ? 'selected' : ''}>None — sending unavailable</option>
        ${unavailable ? '<option value="unavailable" selected>Previous sender unavailable</option>' : ''}
        ${options}</select></label>
      <button class="btn" type="submit">Save sender</button>
    </form>`;
  }

  _renderGoogleServices(instance) {
    const services = this._definition.setup.services || [];
    const rows = services.map((service) => {
      const connected = Boolean(instance.services && instance.services[service.id]);
      const busy = this._busyIds.has(`${instance.id}:${service.id}`);
      const action = connected ? 'disconnect' : 'connect';
      const active = this._state.domains?.find((domain) => domain.domain === service.domain)?.activeInstanceId === instance.id;
      return `<div class="connector-google-row">
        <span class="connector-google-row__status"><span class="status-dot ${connected ? 'is-connected' : 'is-disconnected'}"></span>${escapeHtml(service.label)}</span>
        ${connected ? `<button class="btn" type="button" data-use-instance="${escapeHtml(instance.id)}" data-use-domain="${escapeHtml(service.domain)}" data-use-provider="${escapeHtml(service.providerId)}" ${active || busy ? 'disabled' : ''}>${active ? 'Selected' : 'Use account'}</button>` : ''}
        <button class="btn ${connected ? '' : 'btn-primary'}" type="button" data-google-instance="${escapeHtml(instance.id)}" data-google-service="${escapeHtml(service.id)}" data-google-action="${action}" ${busy ? 'disabled' : ''}>${connected ? 'Disconnect' : 'Connect'}</button>
      </div>`;
    }).join('');
    return `<div class="connector-google-services">${rows}</div>`;
  }

  _renderAccountRouting(instance) {
    const target = { imap: ['email', 'imap'], 'brave-search': ['web', 'brave-search'], webhook: ['notifications', 'webhook'] }[this._definition.id];
    if (!target || instance.status !== 'connected') return '';
    const [domain, providerId] = target;
    const active = this._state.domains?.find((entry) => entry.domain === domain)?.activeInstanceId === instance.id;
    return `<div class="connector-google-services"><button class="btn" type="button" data-use-instance="${escapeHtml(instance.id)}" data-use-domain="${domain}" data-use-provider="${providerId}" ${active ? 'disabled' : ''}>${active ? 'Selected for ' + domain : 'Use for ' + domain}</button></div>`;
  }

  _onClick(event) {
    if (event.target.closest('[data-close]')) return this.close();

    if (event.target.closest('[data-disconnect]')) {
      this.dispatchEvent(new CustomEvent('connector-disconnect', { bubbles: true, detail: { connector: this._definition } }));
      return;
    }

    if (event.target.closest('[data-show-add-account]')) {
      this._showAddForm = true;
      this._addFormMessage = null;
      this._render();
      return;
    }
    if (event.target.closest('[data-cancel-add]')) {
      this._showAddForm = false;
      this._addFormMessage = null;
      this._render();
      return;
    }

    const renameBtn = event.target.closest('[data-rename-instance]');
    if (renameBtn) {
      this._renamingId = renameBtn.dataset.renameInstance;
      this._render();
      return;
    }
    if (event.target.closest('[data-cancel-rename]')) {
      this._renamingId = null;
      this._render();
      return;
    }
    const reconnectBtn = event.target.closest('[data-reconnect-instance]');
    if (reconnectBtn) {
      this._reconnectingId = reconnectBtn.dataset.reconnectInstance;
      this._render();
      return;
    }
    if (event.target.closest('[data-cancel-reconnect]')) {
      this._reconnectingId = null;
      this._render();
      return;
    }

    const removeBtn = event.target.closest('[data-remove-instance]');
    if (removeBtn) {
      this._removeInstance(removeBtn.dataset.removeInstance);
      return;
    }

    const googleBtn = event.target.closest('[data-google-service]');
    if (googleBtn) {
      this._onGoogleServiceAction(googleBtn);
      return;
    }
    const useBtn = event.target.closest('[data-use-instance]');
    if (useBtn) this._useInstance(useBtn);
  }

  _onSubmit(event) {
    const connectorForm = event.target.closest('[data-connector-form]');
    if (connectorForm) {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(connectorForm));
      const portField = (this._definition.setup.fields || []).find((item) => item.key === 'port');
      if (portField && values.port) values.port = Number(values.port);
      this.dispatchEvent(new CustomEvent('connector-config-submit', { bubbles: true, detail: { connector: this._definition, values, form: connectorForm } }));
      return;
    }

    const addForm = event.target.closest('[data-add-instance-form]');
    if (addForm) {
      event.preventDefault();
      this._submitAddInstance(addForm);
      return;
    }

    const renameForm = event.target.closest('[data-rename-form]');
    if (renameForm) {
      event.preventDefault();
      this._submitRename(renameForm);
      return;
    }
    const reconnectForm = event.target.closest('[data-reconnect-form]');
    if (reconnectForm) {
      event.preventDefault();
      this._submitReconnect(reconnectForm);
      return;
    }
    const pairForm = event.target.closest('[data-smtp-pair-form]');
    if (pairForm) {
      event.preventDefault();
      this._submitSmtpPair(pairForm);
    }
  }

  async _submitSmtpPair(form) {
    const instanceId = form.dataset.smtpPairForm;
    const value = new FormData(form).get('smtpInstanceId');
    this._busyIds.add(instanceId);
    try {
      await api.associateImapSmtp(instanceId, value || null);
      await this._loadInstances();
      this._notifyChanged();
    } catch (err) {
      this._instancesError = err.message;
    } finally {
      this._busyIds.delete(instanceId);
      this._render();
    }
  }

  async _submitAddInstance(form) {
    const values = Object.fromEntries(new FormData(form));
    const { label, ...fields } = values;
    const portField = (this._definition.setup.fields || []).find((item) => item.key === 'port');
    if (portField && fields.port) fields.port = Number(fields.port);

    this._addBusy = true;
    this._addFormMessage = null;
    this._render();
    try {
      await api.createConnectorInstance(this._definition.id, { label, ...fields });
      this._showAddForm = false;
      await this._loadInstances();
      this._notifyChanged();
    } catch (err) {
      this._addFormMessage = err.message;
    } finally {
      this._addBusy = false;
      this._render();
    }
  }

  async _submitRename(form) {
    const instanceId = form.dataset.renameForm;
    const label = new FormData(form).get('label');
    this._busyIds.add(instanceId);
    this._render();
    try {
      await api.updateConnectorInstance(this._definition.id, instanceId, { label });
      this._renamingId = null;
      await this._loadInstances();
      this._notifyChanged();
    } catch (err) {
      this._instancesError = err.message;
    } finally {
      this._busyIds.delete(instanceId);
      this._render();
    }
  }

  async _submitReconnect(form) {
    const instanceId = form.dataset.reconnectForm;
    const fields = Object.fromEntries(new FormData(form));
    if (fields.port) fields.port = Number(fields.port);
    this._busyIds.add(instanceId);
    this._render();
    try {
      await api.updateConnectorInstance(this._definition.id, instanceId, fields);
      this._reconnectingId = null;
      await this._loadInstances();
      this._notifyChanged();
    } catch (err) {
      this._instancesError = err.message;
    } finally {
      this._busyIds.delete(instanceId);
      this._render();
    }
  }

  async _removeInstance(instanceId) {
    if (!window.confirm('Remove this account? This cannot be undone.')) return;
    this._busyIds.add(instanceId);
    this._render();
    try {
      await api.deleteConnectorInstance(this._definition.id, instanceId);
      await this._loadInstances();
      this._notifyChanged();
    } catch (err) {
      this._instancesError = err.message;
    } finally {
      this._busyIds.delete(instanceId);
      this._render();
    }
  }

  async _onGoogleServiceAction(button) {
    const { googleInstance: instanceId, googleService: service, googleAction: action } = button.dataset;
    if (action === 'connect') {
      window.location.href = `/api/connectors/google/oauth/start?service=${encodeURIComponent(service)}&instanceId=${encodeURIComponent(instanceId)}`;
      return;
    }
    const busyKey = `${instanceId}:${service}`;
    this._busyIds.add(busyKey);
    this._render();
    try {
      await api.disconnectGoogleInstanceService(instanceId, service);
      await this._loadInstances();
      this._notifyChanged();
    } catch (err) {
      this._instancesError = err.message;
    } finally {
      this._busyIds.delete(busyKey);
      this._render();
    }
  }

  async _useInstance(button) {
    const { useInstance: instanceId, useDomain: domain, useProvider: providerId } = button.dataset;
    this._busyIds.add(instanceId);
    this._render();
    try {
      await api.setActiveProvider(domain, providerId, { connectorId: this._definition.id, instanceId });
      this._notifyChanged();
    } catch (err) {
      this._instancesError = err.message;
    } finally {
      this._busyIds.delete(instanceId);
      this._render();
    }
  }

  setDomains(domains) {
    this._state.domains = domains;
    if (this.querySelector('dialog')?.open) this._render();
  }
}

customElements.define('u2-connector-setup', U2ConnectorSetup);
