const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOwnerUser } = require('../core/auth/bootstrap');

function tempFile(name) {
  return path.join(os.tmpdir(), `business-os-${process.pid}-${Date.now()}-${name}.sqlite`);
}

function purgeCoreRequireCache() {
  const root = `${path.sep}core${path.sep}`;
  for (const cacheKey of Object.keys(require.cache)) {
    if (cacheKey.includes(root)) {
      delete require.cache[cacheKey];
    }
  }
}

async function jsonRequest(baseUrl, routePath, options = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

test('integration: auth, tenancy, IDs, module migrations', async (t) => {
  const tenantDbFile = tempFile('tenant');
  const tenantDbFileTwo = tempFile('tenant-two');
  const controlDbFile = tempFile('control');
  const host = 'tenant.test.local';
  const secondHost = 'tenant-two.test.local';

  process.env.PORT = '0';
  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_FILE = tenantDbFile;
  process.env.CONTROL_DB_CLIENT = 'sqlite';
  process.env.CONTROL_DB_FILE = controlDbFile;
  process.env.TENANCY_STRICT_HOST_MATCH = 'true';
  process.env.TENANCY_BOOTSTRAP_HOST = host;
  process.env.TENANCY_BOOTSTRAP_DOMAIN = 'test.local';
  process.env.AUTH_JWT_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.CORS_ALLOWLIST = '';
  process.env.TRUST_PROXY = 'false';
  process.env.TENANCY_TRUST_FORWARDED_HOST = 'true';
  process.env.TENANCY_ALLOW_OVERRIDE = 'true';

  purgeCoreRequireCache();
  const { buildServer } = require('../core/server');
  const runtime = await buildServer();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  const defaultInstance = await runtime.controlStore.getDefaultInstance();
  assert.ok(defaultInstance && defaultInstance.id);

  t.after(async () => {
    await runtime.shutdown({ exitProcess: false });
    if (fs.existsSync(tenantDbFile)) fs.unlinkSync(tenantDbFile);
    if (fs.existsSync(tenantDbFileTwo)) fs.unlinkSync(tenantDbFileTwo);
    if (fs.existsSync(controlDbFile)) fs.unlinkSync(controlDbFile);
  });

  await createOwnerUser(runtime.db, {
    tenantKey: 'default',
    email: 'owner@example.com',
    password: 'password123',
    fullName: 'Owner User',
    role: 'owner'
  });
  await createOwnerUser(runtime.db, {
    tenantKey: 'default',
    email: 'viewer@example.com',
    password: 'password123',
    fullName: 'Viewer User',
    role: 'viewer'
  });

  const loginControlAdmin = await jsonRequest(baseUrl, '/api/admin/auth/login', {
    method: 'POST',
    headers: {
      'x-forwarded-host': host,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      email: 'admin@localhost',
      password: 'admin12345678'
    })
  });
  assert.equal(loginControlAdmin.response.status, 200);
  const controlToken = loginControlAdmin.body.token;
  assert.ok(controlToken);

  {
    const adminSummary = await jsonRequest(baseUrl, '/api/admin/tenancy/summary', {
      headers: {
        'x-forwarded-host': host,
        Authorization: `Bearer ${controlToken}`
      }
    });
    assert.equal(adminSummary.response.status, 200);
    assert.ok(adminSummary.body.data);
    assert.ok(Array.isArray(adminSummary.body.data.instances));
  }

  {
    const { response } = await jsonRequest(baseUrl, '/api/system', {
      headers: { 'x-forwarded-host': 'unknown.example.com' }
    });
    assert.equal(response.status, 404);
  }

  const loginOwner = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: {
      'x-forwarded-host': host,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      email: 'owner@example.com',
      password: 'password123'
    })
  });
  assert.equal(loginOwner.response.status, 200);
  const ownerToken = loginOwner.body.token;
  assert.ok(ownerToken);

  const loginViewer = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: {
      'x-forwarded-host': host,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      email: 'viewer@example.com',
      password: 'password123'
    })
  });
  assert.equal(loginViewer.response.status, 200);
  const viewerToken = loginViewer.body.token;
  assert.ok(viewerToken);

  {
    const secondInstance = await runtime.controlStore.createInstance({
      name: 'Second Tenant',
      status: 'active',
      db_client: 'sqlite',
      db_config: { client: 'sqlite', file: tenantDbFileTwo },
      app_config: {},
      is_default: false
    });
    await runtime.controlStore.createDomain({
      instance_id: secondInstance.id,
      host: secondHost,
      domain: 'test.local',
      status: 'active'
    });

    const crossTenant = await jsonRequest(baseUrl, '/api/auth/me', {
      headers: {
        'x-forwarded-host': secondHost,
        Authorization: `Bearer ${ownerToken}`
      }
    });
    assert.equal(crossTenant.response.status, 403);
  }

  {
    const createDenied = await jsonRequest(baseUrl, '/api/customers', {
      method: 'POST',
      headers: {
        'x-forwarded-host': host,
        Authorization: `Bearer ${viewerToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        customer: 'Denied Viewer',
        status: 'active'
      })
    });
    assert.equal(createDenied.response.status, 403);
  }

  const createCustomer = await jsonRequest(baseUrl, '/api/customers', {
    method: 'POST',
    headers: {
      'x-forwarded-host': host,
      Authorization: `Bearer ${ownerToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      customer: 'Acme Client',
      status: 'active'
    })
  });
  assert.equal(createCustomer.response.status, 201);
  assert.ok(createCustomer.body.id);
  assert.ok(createCustomer.body.public_id);

  for (let i = 0; i < 3; i += 1) {
    const extra = await jsonRequest(baseUrl, '/api/customers', {
      method: 'POST',
      headers: {
        'x-forwarded-host': host,
        Authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        customer: `Cursor Client ${i + 1}`,
        status: 'active'
      })
    });
    assert.equal(extra.response.status, 201);
  }

  {
    const byUuid = await jsonRequest(baseUrl, `/api/customers/${createCustomer.body.id}`, {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(byUuid.response.status, 200);
    assert.equal(byUuid.body.id, createCustomer.body.id);
  }

  {
    const byPublicId = await jsonRequest(baseUrl, `/api/customers/${createCustomer.body.public_id}`, {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(byPublicId.response.status, 200);
    assert.equal(byPublicId.body.public_id, createCustomer.body.public_id);
  }

  {
    const page1 = await jsonRequest(baseUrl, '/api/customers?limit=2&cursor=start', {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(page1.response.status, 200);
    assert.ok(Array.isArray(page1.body.items));
    assert.equal(page1.body.items.length, 2);
    assert.ok(page1.body.nextCursor);

    const page2 = await jsonRequest(baseUrl, `/api/customers?limit=2&cursor=${page1.body.nextCursor}`, {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(page2.response.status, 200);
    assert.ok(Array.isArray(page2.body.items));
  }

  {
    const modules = await jsonRequest(baseUrl, '/api/system/modules', {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(modules.response.status, 200);
    const salon = (modules.body.data.modules || []).find((item) => item.name === 'salon-module');
    assert.ok(salon);
    assert.equal(salon.status, 'loaded');
    assert.ok(Array.isArray(salon.migrationsApplied));
  }

  {
    const settings = await jsonRequest(baseUrl, '/api/system/settings', {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(settings.response.status, 200);
    assert.ok(settings.body.data);
    assert.ok(settings.body.data.effectiveSettings);
    assert.ok(settings.body.data.source);
  }

  {
    const adminSettings = await jsonRequest(baseUrl, '/api/admin/settings/effective', {
      headers: { 'x-forwarded-host': host, Authorization: `Bearer ${controlToken}` }
    });
    assert.equal(adminSettings.response.status, 200);
    assert.ok(adminSettings.body.data);
    assert.ok(adminSettings.body.data.effectiveSettings);
  }

  {
    const byTenantOverrideHeader = await jsonRequest(baseUrl, '/api/auth/me', {
      headers: {
        'x-forwarded-host': 'unknown.example.com',
        'x-tenant-id': defaultInstance.id,
        Authorization: `Bearer ${ownerToken}`
      }
    });
    assert.equal(byTenantOverrideHeader.response.status, 200);
    assert.equal(byTenantOverrideHeader.body.user.tenantId, defaultInstance.id);
  }

  {
    const byTenantOverrideQuery = await jsonRequest(baseUrl, `/api/auth/me?tenant_id=${encodeURIComponent(defaultInstance.id)}`, {
      headers: {
        'x-forwarded-host': 'unknown.example.com',
        Authorization: `Bearer ${ownerToken}`
      }
    });
    assert.equal(byTenantOverrideQuery.response.status, 200);
    assert.equal(byTenantOverrideQuery.body.user.tenantId, defaultInstance.id);
  }

  {
    const missingOverrideTenant = await jsonRequest(baseUrl, '/api/auth/me', {
      headers: {
        'x-forwarded-host': host,
        'x-tenant-id': 'does-not-exist',
        Authorization: `Bearer ${ownerToken}`
      }
    });
    assert.equal(missingOverrideTenant.response.status, 404);
  }
});
