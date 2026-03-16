const sectionTitle = document.getElementById('sectionTitle');
const sectionEyebrow = document.getElementById('sectionEyebrow');
const tableTitle = document.getElementById('tableTitle');
const detailTitle = document.getElementById('detailTitle');
const tableWrap = document.getElementById('tableWrap');
const detailWrap = document.getElementById('detailWrap');
const statusLine = document.getElementById('statusLine');
const refreshButton = document.getElementById('refreshButton');
const logoutButton = document.getElementById('logoutButton');
const sessionUser = document.getElementById('sessionUser');
const loginOverlay = document.getElementById('loginOverlay');
const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('loginStatus');
const verticalResizeHandle = document.getElementById('verticalResizeHandle');
const horizontalResizeHandle = document.getElementById('horizontalResizeHandle');
const shell = document.querySelector('.shell');
const workspace = document.querySelector('.workspace');
const navButtons = Array.from(document.querySelectorAll('.nav-item'));

const TOKEN_STORAGE_KEY = 'bos_admin_token';
const SIDEBAR_WIDTH_STORAGE_KEY = 'bos_admin_sidebar_width';
const TOP_PANE_SIZE_STORAGE_KEY = 'bos_admin_top_pane_size';

const state = {
  activeSection: 'customers',
  selectedKeyBySection: {
    customers: null,
    instances: null,
    mappings: null,
    schemas: 'app-wrapper'
  },
  recordsBySection: {
    customers: [],
    instances: [],
    mappings: [],
    schemas: [
      { id: 'app-wrapper', title: 'App Wrapper' },
      { id: 'module', title: 'Module' },
      { id: 'process', title: 'Process' },
      { id: 'template', title: 'Template' },
      { id: 'datasource', title: 'Data Source' },
      { id: 'client-overlay', title: 'Client Overlay' }
    ]
  },
  authToken: localStorage.getItem(TOKEN_STORAGE_KEY) || '',
  currentUser: null,
  layout: {
    sidebarWidth: Number.parseInt(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || '260', 10) || 260,
    topPaneSize: Number.parseFloat(localStorage.getItem(TOP_PANE_SIZE_STORAGE_KEY) || '360') || 360
  }
};

const sectionConfig = {
  customers: {
    label: 'Customers',
    keyField: 'id',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'id', label: 'ID', code: true },
      { key: 'status', label: 'Status' },
      { key: 'instance_count', label: 'Instances' }
    ]
  },
  instances: {
    label: 'Instances',
    keyField: 'id',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'id', label: 'ID', code: true },
      { key: 'customer_name', label: 'Customer' },
      { key: 'db_client', label: 'DB' },
      { key: 'status', label: 'Status' },
      { key: 'is_default', label: 'Default', format: (value) => value ? 'yes' : 'no' }
    ]
  },
  mappings: {
    label: 'Mappings',
    keyField: 'id',
    columns: [
      { key: 'host', label: 'Host', code: true },
      { key: 'domain', label: 'Domain', code: true },
      { key: 'instance_name', label: 'Instance' },
      { key: 'instance_id', label: 'Instance ID', code: true },
      { key: 'status', label: 'Status' }
    ]
  },
  schemas: {
    label: 'Schemas',
    keyField: 'id',
    columns: [
      { key: 'id', label: 'Kind', code: true },
      { key: 'title', label: 'Title' }
    ]
  }
};

function setStatus(message) {
  statusLine.textContent = message;
}

function setLoginStatus(message) {
  loginStatus.textContent = message;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatValue(value) {
  if (value == null || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function setToken(token) {
  state.authToken = String(token || '');
  if (state.authToken) {
    localStorage.setItem(TOKEN_STORAGE_KEY, state.authToken);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyLayout() {
  state.layout.sidebarWidth = clamp(state.layout.sidebarWidth, 220, 560);
  state.layout.topPaneSize = clamp(state.layout.topPaneSize, 160, 900);
  document.documentElement.style.setProperty('--sidebar-width', `${state.layout.sidebarWidth}px`);
  document.documentElement.style.setProperty('--top-pane-size', `${state.layout.topPaneSize}px`);
}

function setupResizers() {
  function startDrag(handle, options) {
    return (event) => {
      if (window.matchMedia('(max-width: 1040px)').matches) return;
      event.preventDefault();
      handle.classList.add('dragging');
      const dragContext = typeof options.onStart === 'function'
        ? options.onStart(event)
        : {};
      const onMove = (moveEvent) => options.onMove(moveEvent, dragContext);
      const onUp = () => {
        handle.classList.remove('dragging');
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(state.layout.sidebarWidth));
        localStorage.setItem(TOP_PANE_SIZE_STORAGE_KEY, String(state.layout.topPaneSize));
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }

  verticalResizeHandle.addEventListener('pointerdown', startDrag(verticalResizeHandle, {
    onMove(event) {
      const shellRect = shell.getBoundingClientRect();
      const desired = event.clientX - shellRect.left;
      state.layout.sidebarWidth = clamp(desired, 220, 560);
      applyLayout();
    }
  }));

  horizontalResizeHandle.addEventListener('pointerdown', startDrag(horizontalResizeHandle, {
    onStart(event) {
      const tablePane = workspace.querySelector('.pane-table');
      const detailPane = workspace.querySelector('.pane-detail');
      const startTopPx = tablePane ? tablePane.getBoundingClientRect().height : 0;
      const startBottomPx = detailPane ? detailPane.getBoundingClientRect().height : 0;
      return {
        startY: event.clientY,
        startTopPx,
        availablePx: startTopPx + startBottomPx
      };
    },
    onMove(event, context) {
      if (!context.availablePx || context.availablePx <= 0) return;
      const deltaY = event.clientY - context.startY;
      const minTop = 160;
      const minBottom = 140;
      const maxTop = Math.max(minTop, context.availablePx - minBottom);
      state.layout.topPaneSize = clamp(context.startTopPx + deltaY, minTop, maxTop);
      applyLayout();
    }
  }));
}

function showLoginOverlay() {
  loginOverlay.classList.add('open');
}

function hideLoginOverlay() {
  loginOverlay.classList.remove('open');
}

function resetData() {
  state.recordsBySection.customers = [];
  state.recordsBySection.instances = [];
  state.recordsBySection.mappings = [];
  state.selectedKeyBySection.customers = null;
  state.selectedKeyBySection.instances = null;
  state.selectedKeyBySection.mappings = null;
  state.selectedKeyBySection.schemas = 'app-wrapper';
  updateCounts();
  render();
}

async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.authToken) {
    headers.set('Authorization', `Bearer ${state.authToken}`);
  }

  const response = await fetch(url, {
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

function updateCounts() {
  document.getElementById('count-customers').textContent = String(state.recordsBySection.customers.length);
  document.getElementById('count-instances').textContent = String(state.recordsBySection.instances.length);
  document.getElementById('count-mappings').textContent = String(state.recordsBySection.mappings.length);
  document.getElementById('count-schemas').textContent = String(state.recordsBySection.schemas.length);
}

function getActiveRecords() {
  return state.recordsBySection[state.activeSection] || [];
}

function getSelectedRecord() {
  const key = state.selectedKeyBySection[state.activeSection];
  if (!key) return null;
  const config = sectionConfig[state.activeSection];
  const records = getActiveRecords();
  return records.find((item) => String(item[config.keyField]) === String(key)) || null;
}

function renderNav() {
  for (const button of navButtons) {
    const isActive = button.dataset.section === state.activeSection;
    button.classList.toggle('active', isActive);
  }
}

async function lintSchemaWorkbench() {
  const kind = String(document.getElementById('schemaKind').value || '');
  const jsonText = document.getElementById('schemaJson').value;
  const previewEl = document.getElementById('schemaPreview');
  const resultEl = document.getElementById('schemaLintResult');

  resultEl.textContent = 'Validating...';
  previewEl.textContent = '';

  try {
    const payload = await fetchJson('/api/admin/schema-workbench/lint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, jsonText })
    });

    const lines = [];
    lines.push(payload.ok ? '✅ Valid' : '❌ Invalid');
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      lines.push('Errors:');
      payload.errors.forEach((err) => lines.push(`- ${err}`));
    }
    if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
      lines.push('Warnings:');
      payload.warnings.forEach((warn) => lines.push(`- ${warn}`));
    }
    resultEl.textContent = lines.join('\n');
    previewEl.textContent = JSON.stringify(payload.preview || {}, null, 2);
  } catch (error) {
    resultEl.textContent = `Validation failed: ${error.message}`;
  }
}

async function insertScaffoldFromKind(kind) {
  const guided = {
    appId: document.getElementById('guidedAppId')?.value || undefined,
    moduleId: document.getElementById('guidedModuleId')?.value || undefined,
    processId: document.getElementById('guidedProcessId')?.value || undefined,
    templateId: document.getElementById('guidedTemplateId')?.value || undefined,
    clientId: document.getElementById('guidedClientId')?.value || undefined,
    baseAppId: document.getElementById('guidedBaseAppId')?.value || undefined
  };

  const params = new URLSearchParams();
  Object.entries(guided).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const payload = await fetchJson(`/api/admin/schema-workbench/scaffold/${encodeURIComponent(kind)}${suffix}`);
  document.getElementById('schemaJson').value = JSON.stringify(payload, null, 2);
  await lintSchemaWorkbench();
}

function renderSchemaWorkbench() {
  tableWrap.innerHTML = `
    <div class="schema-workbench">
      <div class="schema-toolbar">
        <label>Schema kind
          <select id="schemaKind">
            ${state.recordsBySection.schemas.map((row) => `<option value="${escapeHtml(row.id)}" ${row.id === state.selectedKeyBySection.schemas ? 'selected' : ''}>${escapeHtml(row.title)}</option>`).join('')}
          </select>
        </label>
        <button type="button" id="schemaScaffoldBtn">Insert scaffold</button>
        <button type="button" id="schemaLintBtn">Lint + Preview</button>
      </div>
      <div class="guided-grid">
        <input id="guidedAppId" placeholder="appId (default)" />
        <input id="guidedModuleId" placeholder="moduleId (support)" />
        <input id="guidedProcessId" placeholder="processId (support.inbox)" />
        <input id="guidedTemplateId" placeholder="templateId (workspace.table-detail)" />
        <input id="guidedClientId" placeholder="clientId (demo-client)" />
        <input id="guidedBaseAppId" placeholder="baseAppId (default)" />
      </div>
      <textarea id="schemaJson" class="schema-json" spellcheck="false" placeholder="Paste JSON here"></textarea>
    </div>
  `;

  detailWrap.innerHTML = `
    <div class="schema-result">
      <h4>Lint Result</h4>
      <pre id="schemaLintResult" class="raw-json">Select a schema kind and click "Insert scaffold".</pre>
      <h4>Preview</h4>
      <pre id="schemaPreview" class="raw-json"></pre>
      <p class="empty-state">Policy guardrails: read-only SQL only, tenant scoping (:tenantId), and bounded query limits.</p>
    </div>
  `;

  document.getElementById('schemaKind').addEventListener('change', (event) => {
    state.selectedKeyBySection.schemas = event.target.value;
  });
  document.getElementById('schemaScaffoldBtn').addEventListener('click', async () => {
    const kind = String(document.getElementById('schemaKind').value || 'app-wrapper');
    await insertScaffoldFromKind(kind);
  });
  document.getElementById('schemaLintBtn').addEventListener('click', lintSchemaWorkbench);
}

function renderHeader() {
  const config = sectionConfig[state.activeSection];
  sectionEyebrow.textContent = 'Section';
  sectionTitle.textContent = config.label;
  tableTitle.textContent = state.activeSection === 'schemas' ? 'Schema Workbench' : `${config.label} List`;
}

function renderTable() {
  const config = sectionConfig[state.activeSection];
  const records = getActiveRecords();
  const selectedKey = state.selectedKeyBySection[state.activeSection];

  if (state.activeSection === 'schemas') {
    renderSchemaWorkbench();
    return;
  }

  if (!records.length) {
    tableWrap.innerHTML = `<p class="empty-state">No ${config.label.toLowerCase()} found.</p>`;
    return;
  }

  const head = config.columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join('');
  const body = records.map((record) => {
    const rowKey = String(record[config.keyField] || '');
    const selectedClass = selectedKey && String(selectedKey) === rowKey ? 'selected' : '';
    const cells = config.columns.map((col) => {
      const raw = typeof col.format === 'function' ? col.format(record[col.key], record) : record[col.key];
      const cellValue = escapeHtml(formatValue(raw));
      const className = col.code ? 'code' : '';
      return `<td class="${className}">${cellValue}</td>`;
    }).join('');

    return `<tr class="table-row ${selectedClass}" data-row-key="${escapeHtml(rowKey)}">${cells}</tr>`;
  }).join('');

  tableWrap.innerHTML = `
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderDetail() {
  const config = sectionConfig[state.activeSection];
  const selected = getSelectedRecord();

  if (state.activeSection === 'schemas') {
    detailTitle.textContent = 'Validation + Preview';
    return;
  }

  if (!selected) {
    detailTitle.textContent = `${config.label} Details`;
    detailWrap.innerHTML = '<p class="empty-state">Select a row above to inspect details.</p>';
    return;
  }

  const primary = selected[config.keyField] || '(unknown)';
  detailTitle.textContent = `${config.label.slice(0, -1)}: ${primary}`;

  const detailRows = Object.entries(selected).map(([key, value]) => {
    const formatted = formatValue(value);
    const isCode = key === 'id' || key.endsWith('_id') || key.includes('config') || key.includes('metadata');
    const valueClass = isCode ? 'code' : '';
    return `<dt>${escapeHtml(key)}</dt><dd class="${valueClass}">${escapeHtml(formatted)}</dd>`;
  }).join('');

  detailWrap.innerHTML = `
    <dl class="detail-grid">${detailRows}</dl>
    <pre class="raw-json">${escapeHtml(JSON.stringify(selected, null, 2))}</pre>
  `;
}

function renderSession() {
  if (!state.currentUser) {
    sessionUser.textContent = 'Not signed in';
    return;
  }

  const role = state.currentUser.isSuperuser ? 'superuser' : (state.currentUser.role || 'admin');
  sessionUser.textContent = `${state.currentUser.email} (${role})`;
}

function render() {
  renderNav();
  renderHeader();
  renderTable();
  renderDetail();
  renderSession();
}

function setDefaultSelections() {
  for (const section of Object.keys(sectionConfig)) {
    const config = sectionConfig[section];
    const records = state.recordsBySection[section] || [];
    const current = state.selectedKeyBySection[section];

    if (current) {
      const stillExists = records.some((record) => String(record[config.keyField]) === String(current));
      if (stillExists) continue;
    }

    state.selectedKeyBySection[section] = records[0] ? records[0][config.keyField] : null;
  }
}

async function loadCurrentUser() {
  const data = await fetchJson('/api/admin/auth/me');
  state.currentUser = data.user || null;
  renderSession();
}

async function loadData() {
  const [summary, schemaKinds] = await Promise.all([
    fetchJson('/api/admin/tenancy/summary'),
    fetchJson('/api/admin/schema-workbench/kinds').catch(() => ({ kinds: state.recordsBySection.schemas.map((x) => x.id) }))
  ]);
  state.recordsBySection.customers = summary.customers || [];
  state.recordsBySection.instances = summary.instances || [];
  state.recordsBySection.mappings = summary.domains || [];
  state.recordsBySection.schemas = (schemaKinds.kinds || []).map((kind) => ({
    id: kind,
    title: kind.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  }));

  updateCounts();
  setDefaultSelections();

  setStatus(
    `Loaded ${state.recordsBySection.customers.length} customers, `
    + `${state.recordsBySection.instances.length} instances, `
    + `${state.recordsBySection.mappings.length} mappings`
  );

  render();
}

async function login(email, password) {
  const response = await fetch('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Login failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (!payload.token) {
    throw new Error('Login response did not include a token');
  }
  return payload;
}

function handleUnauthorized() {
  state.currentUser = null;
  setToken('');
  resetData();
  renderSession();
  showLoginOverlay();
  setStatus('Sign in required');
  setLoginStatus('Sign in to continue.');
}

async function bootAuthenticatedApp() {
  await loadCurrentUser();
  await loadData();
  hideLoginOverlay();
  setLoginStatus('');
}

for (const button of navButtons) {
  button.addEventListener('click', () => {
    const nextSection = button.dataset.section;
    if (!sectionConfig[nextSection]) return;
    state.activeSection = nextSection;
    render();
  });
}

refreshButton.addEventListener('click', () => {
  setStatus('Refreshing...');
  loadData().catch((error) => {
    if (error.status === 401 || error.status === 403) {
      handleUnauthorized();
      return;
    }
    setStatus(error.message);
  });
});

logoutButton.addEventListener('click', () => {
  handleUnauthorized();
});

tableWrap.addEventListener('click', (event) => {
  if (state.activeSection === 'schemas') return;
  const row = event.target.closest('tr[data-row-key]');
  if (!row) return;
  const key = row.dataset.rowKey;
  state.selectedKeyBySection[state.activeSection] = key;
  render();
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  const email = String(formData.get('email') || '').trim();
  const password = String(formData.get('password') || '');

  if (!email || !password) {
    setLoginStatus('Email and password are required.');
    return;
  }

  try {
    setLoginStatus('Signing in...');
    const auth = await login(email, password);
    setToken(auth.token);
    await bootAuthenticatedApp();
  } catch (error) {
    setLoginStatus(error.message);
  }
});

(async () => {
  applyLayout();
  setupResizers();
  render();

  if (!state.authToken) {
    showLoginOverlay();
    setStatus('Sign in required');
    return;
  }

  try {
    await bootAuthenticatedApp();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      handleUnauthorized();
      return;
    }
    setStatus(error.message);
    showLoginOverlay();
  }
})();
