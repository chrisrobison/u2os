const customerForm = document.getElementById('customerForm');
const instanceForm = document.getElementById('instanceForm');
const domainForm = document.getElementById('domainForm');

const customerList = document.getElementById('customerList');
const instanceList = document.getElementById('instanceList');
const domainList = document.getElementById('domainList');
const statusLine = document.getElementById('statusLine');

function setStatus(message) {
  statusLine.textContent = message;
}

function safeJsonParse(value, fallback = {}) {
  const input = String(value || '').trim();
  if (!input) return fallback;
  try {
    return JSON.parse(input);
  } catch {
    throw new Error('Invalid JSON payload');
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

function renderCustomers(customers = []) {
  if (!customers.length) {
    customerList.innerHTML = '<p class="code">No customers configured.</p>';
    return;
  }

  customerList.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>ID</th>
          <th>Status</th>
          <th>Instances</th>
        </tr>
      </thead>
      <tbody>
        ${customers.map((row) => `
          <tr>
            <td>${row.name}</td>
            <td class="code">${row.id}</td>
            <td>${row.status}</td>
            <td>${row.instance_count || 0}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderInstances(instances = []) {
  if (!instances.length) {
    instanceList.innerHTML = '<p class="code">No tenant instances configured.</p>';
    return;
  }

  instanceList.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>ID</th>
          <th>Customer</th>
          <th>DB</th>
          <th>Status</th>
          <th>Default</th>
        </tr>
      </thead>
      <tbody>
        ${instances.map((row) => `
          <tr>
            <td>${row.name}</td>
            <td class="code">${row.id}</td>
            <td>${row.customer_name || '-'}</td>
            <td class="code">${row.db_client} ${JSON.stringify(row.db_config || {})}</td>
            <td>${row.status}</td>
            <td>${row.is_default ? 'yes' : 'no'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderDomains(domains = []) {
  if (!domains.length) {
    domainList.innerHTML = '<p class="code">No host/domain mappings configured.</p>';
    return;
  }

  domainList.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Host</th>
          <th>Domain</th>
          <th>Instance</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${domains.map((row) => `
          <tr>
            <td class="code">${row.host}</td>
            <td class="code">${row.domain}</td>
            <td class="code">${row.instance_name || row.instance_id}</td>
            <td>${row.status}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function loadSummary() {
  const summary = await fetchJson('/api/admin/tenancy/summary');
  renderCustomers(summary.customers || []);
  renderInstances(summary.instances || []);
  renderDomains(summary.domains || []);
  setStatus(`Loaded ${summary.customers.length} customers, ${summary.instances.length} instances, ${summary.domains.length} mappings`);
}

customerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(customerForm);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      status: String(formData.get('status') || 'active'),
      metadata: safeJsonParse(formData.get('metadata') || '{}', {})
    };

    await fetchJson('/api/admin/tenancy/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    customerForm.reset();
    await loadSummary();
  } catch (error) {
    setStatus(error.message);
  }
});

instanceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(instanceForm);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      customer_id: String(formData.get('customer_id') || '').trim() || null,
      status: String(formData.get('status') || 'active'),
      db_client: String(formData.get('db_client') || '').trim().toLowerCase(),
      db_config: safeJsonParse(formData.get('db_config') || '{}', {}),
      app_config: safeJsonParse(formData.get('app_config') || '{}', {}),
      is_default: Boolean(formData.get('is_default'))
    };

    await fetchJson('/api/admin/tenancy/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    instanceForm.reset();
    await loadSummary();
  } catch (error) {
    setStatus(error.message);
  }
});

domainForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(domainForm);
    const payload = {
      instance_id: String(formData.get('instance_id') || '').trim(),
      host: String(formData.get('host') || '').trim(),
      domain: String(formData.get('domain') || '').trim(),
      status: String(formData.get('status') || 'active')
    };

    await fetchJson('/api/admin/tenancy/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    domainForm.reset();
    await loadSummary();
  } catch (error) {
    setStatus(error.message);
  }
});

loadSummary().catch((error) => setStatus(error.message));
