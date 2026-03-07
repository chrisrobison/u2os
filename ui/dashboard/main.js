const TABLES = [
  'users',
  'organizations',
  'customers',
  'contacts',
  'products',
  'services',
  'orders',
  'appointments',
  'invoices',
  'payments',
  'documents',
  'tasks',
  'events',
  'clamps'
];

const state = {
  table: TABLES[0],
  records: [],
  selectedId: null,
  createMode: false,
  columns: []
};

const tableNav = document.getElementById('tableNav');
const tableTitle = document.getElementById('tableTitle');
const systemMeta = document.getElementById('systemMeta');
const recordsList = document.getElementById('recordsList');
const recordForm = document.getElementById('recordForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const refreshBtn = document.getElementById('refreshBtn');
const newBtn = document.getElementById('newBtn');
const saveBtn = document.getElementById('saveBtn');
const deleteBtn = document.getElementById('deleteBtn');

function humanize(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferInputType(columnType = '') {
  const type = String(columnType).toLowerCase();
  if (type.includes('int') || type.includes('real') || type.includes('double') || type.includes('numeric') || type.includes('decimal')) {
    return 'number';
  }
  if (type.includes('bool')) {
    return 'text';
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

function createField({ name, label, type, readOnly, value, full = false }) {
  const wrapper = document.createElement('div');
  wrapper.className = `field${full ? ' full' : ''}`;

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

function getSelectedRecord() {
  return state.records.find((row) => row.id === state.selectedId) || null;
}

function buildFormDefinition(record) {
  const fields = [];

  for (const column of state.columns) {
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

function renderForm(record = null) {
  const fields = buildFormDefinition(record);
  recordForm.innerHTML = '';
  for (const field of fields) {
    recordForm.appendChild(createField(field));
  }
  deleteBtn.disabled = state.createMode || !state.selectedId;
}

function renderTableNav() {
  tableNav.innerHTML = '';
  for (const table of TABLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = table;
    btn.className = table === state.table ? 'active' : '';
    btn.addEventListener('click', async () => {
      state.table = table;
      state.selectedId = null;
      state.createMode = false;
      renderTableNav();
      await loadSchema();
      await loadRecords();
    });
    tableNav.appendChild(btn);
  }
}

function renderRecordList() {
  tableTitle.textContent = state.table;

  if (state.records.length === 0) {
    recordsList.innerHTML = '<div class="subtle" style="padding:10px;">No records found.</div>';
    return;
  }

  recordsList.innerHTML = '';
  const labelColumn = state.columns.find((c) => c.name === state.table.slice(0, -1))
    ? state.table.slice(0, -1)
    : (state.columns.find((c) => c.name === 'name') ? 'name' : 'id');

  for (const record of state.records) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `record-item${record.id === state.selectedId ? ' active' : ''}`;
    const label = record[labelColumn] || '(unnamed)';
    btn.innerHTML = `<strong>${label}</strong><small>${record.id || ''}</small>`;
    btn.addEventListener('click', () => {
      state.selectedId = record.id;
      state.createMode = false;
      renderRecordList();
      renderForm(record);
    });
    recordsList.appendChild(btn);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function loadSystemMeta() {
  const system = await fetchJson('/api/system');
  systemMeta.textContent = `DB: ${system.dbClient} | Modules: ${system.modulesLoaded} | Version: ${system.version}`;
}

async function loadSchema() {
  const payload = await fetchJson(`/api/schema/${state.table}`);
  state.columns = payload.columns || [];
}

async function loadRecords() {
  const q = searchInput.value.trim();
  const query = q ? `?q=${encodeURIComponent(q)}&limit=200` : '?limit=200';
  state.records = await fetchJson(`/api/${state.table}${query}`);

  if (state.selectedId && !state.records.find((row) => row.id === state.selectedId)) {
    state.selectedId = null;
  }

  renderRecordList();
  renderForm(getSelectedRecord());
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

function formToPayload() {
  const values = Object.fromEntries(new FormData(recordForm).entries());
  const payload = {};

  for (const column of state.columns) {
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

async function saveRecord() {
  try {
    const payload = formToPayload();

    if (state.createMode || !state.selectedId) {
      const created = await fetchJson(`/api/${state.table}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      state.selectedId = created.id;
      state.createMode = false;
    } else {
      await fetchJson(`/api/${state.table}/${state.selectedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    await loadRecords();
  } catch (error) {
    alert(`Save failed: ${error.message}`);
  }
}

async function deleteRecord() {
  if (!state.selectedId) return;
  if (!window.confirm(`Delete ${state.selectedId}?`)) return;

  try {
    await fetchJson(`/api/${state.table}/${state.selectedId}`, { method: 'DELETE' });
    state.selectedId = null;
    state.createMode = false;
    await loadRecords();
  } catch (error) {
    alert(`Delete failed: ${error.message}`);
  }
}

function startNewRecord() {
  state.selectedId = null;
  state.createMode = true;
  renderRecordList();
  renderForm(null);
}

searchBtn.addEventListener('click', () => loadRecords().catch((error) => alert(error.message)));
refreshBtn.addEventListener('click', () => loadRecords().catch((error) => alert(error.message)));
newBtn.addEventListener('click', startNewRecord);
saveBtn.addEventListener('click', saveRecord);
deleteBtn.addEventListener('click', deleteRecord);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadRecords().catch((error) => alert(error.message));
  }
});

(async function init() {
  try {
    renderTableNav();
    await loadSystemMeta();
    await loadSchema();
    await loadRecords();
  } catch (error) {
    systemMeta.textContent = error.message;
  }
})();
