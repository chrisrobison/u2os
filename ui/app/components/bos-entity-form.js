function humanize(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function inferInputType(columnType = '') {
  const type = String(columnType).toLowerCase();
  if (type.includes('int') || type.includes('real') || type.includes('double') || type.includes('numeric') || type.includes('decimal')) {
    return 'number';
  }
  return 'text';
}

function tryParseJson(value) {
  if (value == null || typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function coerceDataValue(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed))) return Number(trimmed);

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

class BosEntityForm extends HTMLElement {
  constructor() {
    super();
    this.state = {
      entity: null,
      title: null,
      records: [],
      selectedId: null,
      createMode: false,
      columns: []
    };

    this.$search = null;
    this.$records = null;
    this.$form = null;
    this.$title = null;
    this.$save = null;
    this.$delete = null;
    this.$recordSummary = null;
  }

  connectedCallback() {
    this.renderShell();
    if (this.state.entity) {
      this.loadData().catch((error) => this.showError(error));
    }
  }

  set config(value) {
    const next = value || {};
    this.state.entity = next.entity || null;
    this.state.title = next.title || null;
    this.state.selectedId = null;
    this.state.createMode = false;

    if (this.isConnected) {
      this.loadData().catch((error) => this.showError(error));
    }
  }

  get config() {
    return {
      entity: this.state.entity,
      title: this.state.title
    };
  }

  emitRuntimeEvent(event, context = {}) {
    this.dispatchEvent(new CustomEvent('bos:runtime-event', {
      detail: { event, context },
      bubbles: true,
      composed: true
    }));
  }

  async fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  renderShell() {
    this.innerHTML = `
      <section class="entity-workspace">
        <header class="entity-header">
          <div>
            <h3 class="entity-title"></h3>
            <p class="entity-subtle"></p>
          </div>
          <div class="entity-actions">
            <input data-role="search" type="search" placeholder="Search public ID, UUID, or text" />
            <button data-action="search" type="button">Search</button>
            <button data-action="refresh" type="button">Refresh</button>
            <button data-action="new" type="button">New</button>
          </div>
        </header>

        <section class="entity-grid">
          <section class="entity-pane">
            <h4>Records</h4>
            <div data-role="records" class="entity-record-list"></div>
          </section>

          <section class="entity-pane">
            <h4>Details</h4>
            <div data-role="record-summary" class="entity-record-summary"></div>
            <form data-role="form" class="entity-form"></form>
            <div class="entity-actions entity-form-actions">
              <button data-action="save" type="button">Save</button>
              <button data-action="delete" type="button" class="danger">Delete</button>
            </div>
          </section>
        </section>
      </section>
    `;

    this.$title = this.querySelector('.entity-title');
    this.$search = this.querySelector('[data-role="search"]');
    this.$records = this.querySelector('[data-role="records"]');
    this.$form = this.querySelector('[data-role="form"]');
    this.$save = this.querySelector('[data-action="save"]');
    this.$delete = this.querySelector('[data-action="delete"]');
    this.$recordSummary = this.querySelector('[data-role="record-summary"]');

    this.querySelector('[data-action="search"]').addEventListener('click', () => this.loadRecords().catch((error) => this.showError(error)));
    this.querySelector('[data-action="refresh"]').addEventListener('click', () => this.loadRecords().catch((error) => this.showError(error)));
    this.querySelector('[data-action="new"]').addEventListener('click', () => this.startNewRecord());
    this.$save.addEventListener('click', () => this.saveRecord());
    this.$delete.addEventListener('click', () => this.deleteRecord());
    this.$search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.loadRecords().catch((error) => this.showError(error));
      }
    });
  }

  showError(error) {
    this.$records.innerHTML = `<div class="entity-subtle entity-pad">${error.message}</div>`;
  }

  async loadData() {
    if (!this.state.entity) {
      this.$records.innerHTML = '<div class="entity-subtle entity-pad">No entity configured.</div>';
      return;
    }

    this.$title.textContent = this.state.title || humanize(this.state.entity);
    this.querySelector('.entity-subtle').textContent = `Table: ${this.state.entity}`;

    await this.loadSchema();
    await this.loadRecords();
    this.emitRuntimeEvent('onLoad', { entity: this.state.entity });
  }

  async loadSchema() {
    const payload = await this.fetchJson(`/api/schema/${this.state.entity}`);
    this.state.columns = payload.columns || [];
  }

  async loadRecords() {
    const q = this.$search.value.trim();
    const query = q ? `?q=${encodeURIComponent(q)}&limit=200` : '?limit=200';
    this.state.records = await this.fetchJson(`/api/${this.state.entity}${query}`);

    if (this.state.selectedId && !this.state.records.find((row) => String(row.id) === String(this.state.selectedId))) {
      this.state.selectedId = null;
    }

    this.renderRecordList();
    this.renderForm(this.getSelectedRecord());
  }

  getSelectedRecord() {
    return this.state.records.find((row) => String(row.id) === String(this.state.selectedId)) || null;
  }

  getRecordLookupId(record) {
    if (!record) return this.state.selectedId;
    return record.public_id || record.id;
  }

  getRecordDisplayId(record) {
    if (!record) return null;
    return record.public_id || record.id;
  }

  renderRecordSummary(record) {
    if (!record) {
      this.$recordSummary.innerHTML = '<p class=\"entity-subtle\">New record</p>';
      return;
    }

    const displayId = this.getRecordDisplayId(record);
    const label = record[this.state.entity.slice(0, -1)] || record.name || record.title || '(unnamed)';
    this.$recordSummary.innerHTML = `
      <p class=\"entity-id-line\"><strong>${escapeHtml(displayId)}</strong> <span>${escapeHtml(label)}</span></p>
      <details class=\"entity-advanced\">
        <summary>Advanced IDs</summary>
        <p>UUID: <code>${escapeHtml(record.id)}</code></p>
      </details>
    `;
  }

  renderRecordList() {
    if (this.state.records.length === 0) {
      this.$records.innerHTML = '<div class="entity-subtle entity-pad">No records found.</div>';
      return;
    }

    this.$records.innerHTML = '';
    const preferred = [this.state.entity.slice(0, -1), 'name', 'title', 'id'];
    const labelColumn = preferred.find((col) => this.state.columns.some((c) => c.name === col)) || 'id';

    for (const record of this.state.records) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `entity-record-item${String(record.id) === String(this.state.selectedId) ? ' active' : ''}`;
      const heading = this.getRecordDisplayId(record) || '(missing id)';
      const label = record[labelColumn] || '(unnamed)';
      btn.innerHTML = `<strong>${escapeHtml(heading)}</strong><small>${escapeHtml(label)} | UUID: ${escapeHtml(record.id || '')}</small>`;
      btn.addEventListener('click', () => {
        this.state.selectedId = record.id;
        this.state.createMode = false;
        this.renderRecordList();
        this.renderForm(record);
        this.emitRuntimeEvent('onView', {
          entity: this.state.entity,
          id: record.id,
          publicId: record.public_id || null
        });
      });
      this.$records.appendChild(btn);
    }
  }

  createField({ name, label, type, readOnly, value, full = false }) {
    const wrapper = document.createElement('div');
    wrapper.className = `entity-field${full ? ' full' : ''}`;

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);

    if (type === 'textarea') {
      const textarea = document.createElement('textarea');
      textarea.name = name;
      textarea.value = value ?? '';
      textarea.readOnly = Boolean(readOnly);
      wrapper.appendChild(textarea);
      return wrapper;
    }

    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    input.value = value ?? '';
    input.readOnly = Boolean(readOnly);
    wrapper.appendChild(input);

    return wrapper;
  }

  buildFormDefinition(record) {
    const fields = [];

    for (const column of this.state.columns) {
      const value = record ? record[column.name] : '';
      const parsedJson = tryParseJson(value);
      const isJsonObject = parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson);

      fields.push({
        name: `col.${column.name}`,
        label: humanize(column.name),
        type: isJsonObject ? 'textarea' : inferInputType(column.type),
        value: isJsonObject ? JSON.stringify(parsedJson, null, 2) : (value ?? ''),
        readOnly: Boolean(column.readOnly),
        full: isJsonObject
      });

      if (isJsonObject) {
        for (const [key, nestedValue] of Object.entries(parsedJson)) {
          const nestedIsObject = nestedValue && typeof nestedValue === 'object';
          fields.push({
            name: `jsonfield.${column.name}.${key}`,
            label: `${humanize(column.name)}: ${key}`,
            type: nestedIsObject ? 'textarea' : 'text',
            value: nestedIsObject ? JSON.stringify(nestedValue, null, 2) : String(nestedValue ?? ''),
            readOnly: false,
            full: nestedIsObject
          });
        }
      }
    }

    return fields;
  }

  renderForm(record = null) {
    const fields = this.buildFormDefinition(record);
    this.$form.innerHTML = '';
    this.renderRecordSummary(record);
    for (const field of fields) {
      this.$form.appendChild(this.createField(field));
    }
    this.$delete.disabled = this.state.createMode || !this.state.selectedId;
  }

  formToPayload() {
    const values = Object.fromEntries(new FormData(this.$form).entries());
    const payload = {};

    for (const column of this.state.columns) {
      if (column.readOnly || ['id', 'created', 'modified'].includes(column.name)) {
        continue;
      }

      const key = `col.${column.name}`;
      const raw = values[key];
      if (raw == null || raw === '') {
        payload[column.name] = null;
        continue;
      }

      const obj = tryParseJson(raw);
      if (obj && typeof obj === 'object') {
        const merged = { ...obj };
        const nestedPrefix = `jsonfield.${column.name}.`;
        for (const [formKey, formValue] of Object.entries(values)) {
          if (!formKey.startsWith(nestedPrefix)) continue;
          const nestedKey = formKey.slice(nestedPrefix.length);
          merged[nestedKey] = coerceDataValue(formValue);
        }
        payload[column.name] = merged;
        continue;
      }

      const inputType = inferInputType(column.type);
      payload[column.name] = inputType === 'number' ? Number(raw) : raw;
    }

    return payload;
  }

  async saveRecord() {
    try {
      const payload = this.formToPayload();
      this.emitRuntimeEvent('beforeSave', {
        entity: this.state.entity,
        id: this.state.selectedId,
        payload
      });

      if (this.state.createMode || !this.state.selectedId) {
        const created = await this.fetchJson(`/api/${this.state.entity}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        this.state.selectedId = created.id;
        this.state.createMode = false;
      } else {
        const current = this.getSelectedRecord();
        const lookupId = this.getRecordLookupId(current);
        await this.fetchJson(`/api/${this.state.entity}/${encodeURIComponent(lookupId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      await this.loadRecords();
      const selected = this.getSelectedRecord();
      this.emitRuntimeEvent('onSave', {
        entity: this.state.entity,
        id: selected?.id || this.state.selectedId,
        publicId: selected?.public_id || null
      });
      this.emitRuntimeEvent('afterSave', {
        entity: this.state.entity,
        id: selected?.id || this.state.selectedId,
        publicId: selected?.public_id || null
      });
    } catch (error) {
      alert(`Save failed: ${error.message}`);
    }
  }

  async deleteRecord() {
    if (!this.state.selectedId) return;
    const current = this.getSelectedRecord();
    const lookupId = this.getRecordLookupId(current);
    const displayId = this.getRecordDisplayId(current) || this.state.selectedId;
    if (!window.confirm(`Delete ${displayId}?`)) return;

    try {
      await this.fetchJson(`/api/${this.state.entity}/${encodeURIComponent(lookupId)}`, {
        method: 'DELETE'
      });
      this.state.selectedId = null;
      this.state.createMode = false;
      await this.loadRecords();
    } catch (error) {
      alert(`Delete failed: ${error.message}`);
    }
  }

  startNewRecord() {
    this.state.selectedId = null;
    this.state.createMode = true;
    this.renderRecordList();
    this.renderForm(null);
  }

  async reload() {
    await this.loadRecords();
  }
}

customElements.define('bos-entity-form', BosEntityForm);
