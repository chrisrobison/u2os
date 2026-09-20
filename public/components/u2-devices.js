import { escapeHtml, formatDateTime, humanizeKey } from './util.js';
import * as api from '../services/api.js';
import './u2-card.js';

const TRUST_LABELS = { untrusted: 'Untrusted', paired: 'Paired', trusted: 'Trusted', revoked: 'Revoked' };
const TRUST_ORDER = ['untrusted', 'paired', 'trusted', 'revoked'];

function trustBadge(trust) {
  return `<span class="device-trust device-trust--${escapeHtml(trust)}">${escapeHtml(TRUST_LABELS[trust] || trust)}</span>`;
}

function capabilityChips(capabilities) {
  if (!capabilities?.length) return '<span class="empty-state">No capabilities advertised</span>';
  return `<div class="device-capabilities">${capabilities.map((c) => `<span class="device-capability-chip" data-test-capability="${escapeHtml(c)}" title="Test ${escapeHtml(c)}">${escapeHtml(c)}</span>`).join('')}</div>`;
}

function renderDeviceRow(device, ctx) {
  const isOpen = ctx.selectedId === device.id;
  const dotClass = device.status === 'online' ? 'is-connected' : 'is-disconnected';
  const message = ctx.messages[device.id];

  return `
    <div class="device-row" data-device-row="${escapeHtml(device.id)}">
      <button type="button" class="device-row__summary" data-toggle-device="${escapeHtml(device.id)}">
        <span class="status-dot ${dotClass}"></span>
        <span class="device-row__name">${escapeHtml(device.name)}</span>
        <span class="device-row__meta">${escapeHtml(humanizeKey(device.type))}${device.location ? ` · ${escapeHtml(device.location)}` : ''}</span>
        ${trustBadge(device.trust)}
      </button>
      ${isOpen ? renderDeviceDetail(device, ctx) : ''}
      ${message ? `<div class="device-message${message.isError ? ' is-error' : ''}">${escapeHtml(message.text)}</div>` : ''}
    </div>
  `;
}

function renderDeviceDetail(device, ctx) {
  const events = ctx.events[device.id];
  const busy = ctx.busyIds.has(device.id);

  const activityHtml = !events
    ? '<div class="empty-state">Loading...</div>'
    : events.length === 0
      ? '<div class="empty-state">No recent activity</div>'
      : `<ul class="device-activity">${events
          .map((e) => `<li><span class="mono">${escapeHtml(formatDateTime(e.timestamp))}</span> ${escapeHtml(e.type)}</li>`)
          .join('')}</ul>`;

  const trustOptions = TRUST_ORDER.map((t) => `<option value="${t}"${t === device.trust ? ' selected' : ''}>${TRUST_LABELS[t]}</option>`).join('');

  return `
    <div class="device-detail">
      <dl class="u2-approval__args">
        <dt>Owner</dt><dd>${escapeHtml(device.owner || '—')}</dd>
        <dt>Location</dt><dd>${escapeHtml(device.location || '—')}</dd>
        <dt>Adapter</dt><dd>${escapeHtml(device.adapter)}</dd>
        <dt>Last seen</dt><dd>${escapeHtml(formatDateTime(device.last_seen_at) || '—')}</dd>
      </dl>

      <div class="device-detail__section">
        <div class="u2-card__title">Capabilities (click to test)</div>
        ${capabilityChips(device.capabilities)}
      </div>

      <div class="device-detail__section">
        <div class="u2-card__title">Manage</div>
        <form class="device-form" data-rename-form="${escapeHtml(device.id)}">
          <label>Name <input type="text" name="name" value="${escapeHtml(device.name)}" required></label>
          <label>Location <input type="text" name="location" value="${escapeHtml(device.location || '')}"></label>
          <label>Owner <input type="text" name="owner" value="${escapeHtml(device.owner || '')}"></label>
          <button type="submit" class="btn" ${busy ? 'disabled' : ''}>Save</button>
        </form>
        <div class="device-trust-control">
          <label>Trust <select data-trust-select="${escapeHtml(device.id)}" ${busy ? 'disabled' : ''}>${trustOptions}</select></label>
          <button type="button" class="btn btn-danger" data-remove-device="${escapeHtml(device.id)}" ${busy ? 'disabled' : ''}>Remove device</button>
        </div>
      </div>

      <div class="device-detail__section">
        <div class="u2-card__title">Recent activity</div>
        ${activityHtml}
      </div>
    </div>
  `;
}

// Device management UI -- Phase 6 (docs/devices.md). Self-fetching custom
// element, same pattern as u2-connectors.js: GET /api/devices, expand a
// row for details + GET /api/events?subjectType=device&subjectId=... for
// recent activity, and a small set of management actions (rename,
// relocate, reassign owner, pair/trust/revoke, remove, test a capability
// directly against this one device).
export class U2Devices extends HTMLElement {
  constructor() {
    super();
    this._devices = null;
    this._selectedId = null;
    this._events = {}; // deviceId -> events[] once loaded
    this._busyIds = new Set();
    this._messages = {}; // deviceId -> { text, isError }

    this._onClick = this._onClick.bind(this);
    this._onChange = this._onChange.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.addEventListener('click', this._onClick);
    this.addEventListener('change', this._onChange);
    this.addEventListener('submit', this._onSubmit);
    this._load();
  }

  async _load() {
    this.innerHTML = '<div class="empty-state">Loading devices...</div>';
    try {
      const { devices } = await api.getDevices();
      this._devices = devices;
      this._render();
    } catch (err) {
      this.innerHTML = `<div class="load-error">Couldn't load devices: ${escapeHtml(err.message)}</div>`;
    }
  }

  _render() {
    const devices = this._devices || [];
    const ctx = { selectedId: this._selectedId, events: this._events, busyIds: this._busyIds, messages: this._messages };
    this.innerHTML = `
      <div class="workspace__header">
        <div class="workspace__title">Devices</div>
        <div class="workspace__subtitle">${devices.length} known device${devices.length === 1 ? '' : 's'}</div>
      </div>
      ${devices.length ? `<div class="device-list">${devices.map((d) => renderDeviceRow(d, ctx)).join('')}</div>` : '<div class="empty-state">No devices registered yet.</div>'}
    `;
  }

  async _toggle(id) {
    this._selectedId = this._selectedId === id ? null : id;
    if (this._selectedId && !this._events[id]) {
      this._render();
      try {
        const { events } = await api.getEvents({ subjectType: 'device', subjectId: id, limit: 20 });
        this._events[id] = events;
      } catch {
        this._events[id] = [];
      }
    }
    this._render();
  }

  _onClick(e) {
    const toggleBtn = e.target.closest('button[data-toggle-device]');
    if (toggleBtn) return this._toggle(toggleBtn.dataset.toggleDevice);

    const chip = e.target.closest('[data-test-capability]');
    if (chip) return this._testCapability(chip.closest('[data-device-row]').dataset.deviceRow, chip.dataset.testCapability);

    const removeBtn = e.target.closest('button[data-remove-device]');
    if (removeBtn) return this._remove(removeBtn.dataset.removeDevice);
  }

  _onChange(e) {
    const select = e.target.closest('select[data-trust-select]');
    if (select) return this._setTrust(select.dataset.trustSelect, select.value);
  }

  _onSubmit(e) {
    const form = e.target.closest('form[data-rename-form]');
    if (!form) return;
    e.preventDefault();
    this._rename(form.dataset.renameForm, form);
  }

  async _withBusy(id, fn) {
    if (this._busyIds.has(id)) return;
    this._busyIds.add(id);
    this._messages[id] = null;
    this._render();
    try {
      await fn();
    } catch (err) {
      this._messages[id] = { text: err.message, isError: true };
    } finally {
      this._busyIds.delete(id);
    }
    await this._load();
    this._selectedId = id;
    this._render();
  }

  _rename(id, form) {
    return this._withBusy(id, () => api.updateDevice(id, { name: form.name.value, location: form.location.value, owner: form.owner.value }));
  }

  _setTrust(id, trust) {
    return this._withBusy(id, () => api.setDeviceTrust(id, trust));
  }

  _remove(id) {
    return this._withBusy(id, async () => {
      await api.deleteDevice(id);
      this._selectedId = null;
    });
  }

  _testCapability(id, capability) {
    return this._withBusy(id, async () => {
      const result = await api.testDeviceCapability(id, capability, {});
      this._messages[id] = { text: `${capability}: ${JSON.stringify(result.result)}`, isError: false };
    });
  }
}

customElements.define('u2-devices', U2Devices);
