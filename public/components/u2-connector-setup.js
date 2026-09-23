import { escapeHtml } from './util.js';

function renderField(field) {
  const required = field.required === false ? '' : ' required';
  if (field.type === 'select') {
    const options = (field.options || []).map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
    return `<label class="connector-field"><span>${escapeHtml(field.label)}</span><select name="${escapeHtml(field.key)}"${required}>${options}</select></label>`;
  }
  return `<label class="connector-field"><span>${escapeHtml(field.label)}</span><input name="${escapeHtml(field.key)}" type="${escapeHtml(field.type || 'text')}" placeholder="${escapeHtml(field.placeholder || '')}" autocomplete="off"${required}></label>`;
}

export class U2ConnectorSetup extends HTMLElement {
  constructor() {
    super();
    this._definition = null;
    this._state = {};
    this._onClick = this._onClick.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
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
    this._render();
    this.querySelector('dialog').showModal();
  }

  close() { this.querySelector('dialog')?.close(); }

  _render() {
    const d = this._definition;
    const setup = d.setup || {};
    const unavailable = d.status !== 'available';
    const services = (setup.services || []).map((service) => {
      const connected = (this._state.connectedProviders || []).includes(service.providerId);
      return `<div class="connector-service"><span><span class="status-dot ${connected ? 'is-connected' : 'is-disconnected'}"></span>${escapeHtml(service.label)}</span><button class="btn ${connected ? '' : 'btn-primary'}" type="button" data-service="${escapeHtml(service.id)}" data-action="${connected ? 'disconnect' : 'connect'}">${connected ? 'Disconnect' : 'Connect'}</button></div>`;
    }).join('');
    const fields = (setup.fields || []).map(renderField).join('');
    const capabilities = (d.capabilities || []).map((capability) => `<span class="connector-chip">${escapeHtml(capability)}</span>`).join('');

    this.querySelector('dialog').innerHTML = `
      <div class="connector-dialog__header"><div><h2>${escapeHtml(d.name)}</h2><p>${escapeHtml(d.description || '')}</p></div><button class="btn" type="button" data-close aria-label="Close connector setup">Close</button></div>
      <div class="connector-capabilities">${capabilities}</div>
      ${unavailable ? '<p class="connector-planned">This connector is in the catalog but its adapter is not available yet.</p>' : `
        ${fields ? `<form class="connector-form" data-connector-form>${fields}<div class="connector-form__actions"><button class="btn btn-primary" type="submit">Save configuration</button>${this._state.connected && setup.disconnectEndpoint ? '<button class="btn" type="button" data-disconnect>Disconnect</button>' : ''}<span data-message></span></div></form>` : ''}
        ${services ? `<div class="connector-services">${services}</div>` : ''}
      `}
    `;
  }

  _onClick(event) {
    if (event.target.closest('[data-close]')) return this.close();
    if (event.target.closest('[data-disconnect]')) {
      this.dispatchEvent(new CustomEvent('connector-disconnect', { bubbles: true, detail: { connector: this._definition } }));
      return;
    }
    const button = event.target.closest('[data-service]');
    if (!button) return;
    this.dispatchEvent(new CustomEvent('connector-service-action', { bubbles: true, detail: { connector: this._definition, service: button.dataset.service, action: button.dataset.action } }));
  }

  _onSubmit(event) {
    const form = event.target.closest('[data-connector-form]');
    if (!form) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const portField = (this._definition.setup.fields || []).find((item) => item.key === 'port');
    if (portField && values.port) values.port = Number(values.port);
    this.dispatchEvent(new CustomEvent('connector-config-submit', { bubbles: true, detail: { connector: this._definition, values, form } }));
  }
}

customElements.define('u2-connector-setup', U2ConnectorSetup);
