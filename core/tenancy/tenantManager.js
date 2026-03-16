const fs = require('fs');
const path = require('path');
const { createDataSource } = require('../db');
const { createAuthStore } = require('../auth/store');
const { normalizeHost, normalizeDomain } = require('./controlStore');

function isIpAddress(hostname) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)
    || hostname.includes(':');
}

function deriveDomainFromHost(host) {
  const hostname = normalizeHost(host);
  if (!hostname) return '';
  if (hostname === 'localhost' || isIpAddress(hostname)) {
    return hostname;
  }

  const labels = hostname.split('.').filter(Boolean);
  if (labels.length <= 2) return hostname;
  return labels.slice(-2).join('.');
}

function extractRequestHost(req, options = {}) {
  const trustForwardedHost = options && options.trustForwardedHost === true;
  const forwarded = trustForwardedHost
    ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    : '';
  const rawHost = forwarded || String(req.headers.host || '');
  return normalizeHost(rawHost);
}

function extractTenantOverride(req, options = {}) {
  const headerName = String(options.headerName || 'x-tenant-id').trim().toLowerCase();
  const queryParam = String(options.queryParam || 'tenant_id').trim();

  const rawHeaderValue = headerName ? req.headers[headerName] : null;
  const headerValue = Array.isArray(rawHeaderValue) ? rawHeaderValue[0] : rawHeaderValue;
  const fromHeader = String(headerValue || '').trim();
  if (fromHeader) return fromHeader;

  if (!queryParam || !req.query) return '';
  const rawQueryValue = req.query[queryParam];
  const queryValue = Array.isArray(rawQueryValue) ? rawQueryValue[0] : rawQueryValue;
  return String(queryValue || '').trim();
}

function collectModuleMigrations(modulesDir) {
  const absoluteModulesDir = path.resolve(process.cwd(), modulesDir);
  if (!fs.existsSync(absoluteModulesDir)) {
    return [];
  }

  const moduleDirs = fs.readdirSync(absoluteModulesDir)
    .map((name) => path.join(absoluteModulesDir, name))
    .filter((dir) => fs.statSync(dir).isDirectory());
  const expected = [];

  for (const moduleDir of moduleDirs) {
    const manifestPath = path.join(moduleDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const moduleName = manifest.name || path.basename(moduleDir);
    const migrationsDir = path.join(moduleDir, 'migrations');
    if (!fs.existsSync(migrationsDir)) continue;

    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      expected.push({
        migrationKey: `${moduleName}:${file}`,
        filePath: path.join(migrationsDir, file)
      });
    }
  }
  return expected;
}

async function applyModuleMigrations(db, modulesDir, { strict = true } = {}) {
  const expected = collectModuleMigrations(modulesDir);
  const applied = [];

  for (const item of expected) {
    const sql = fs.readFileSync(item.filePath, 'utf8');
    const didApply = await db.applyMigration(item.migrationKey, sql);
    if (didApply) {
      applied.push(item.migrationKey);
    }
  }

  if (strict) {
    if (typeof db.hasMigration !== 'function') {
      throw new Error('Strict migration mode requires db.hasMigration support');
    }
    for (const item of expected) {
      const exists = await db.hasMigration(item.migrationKey);
      if (!exists) {
        throw new Error(`Pending migration detected: ${item.migrationKey}`);
      }
    }
  }

  return {
    expected: expected.map((item) => item.migrationKey),
    applied
  };
}

function createScopedDbProxy(getActiveContext) {
  const tenantBoundMethods = new Set([
    'create',
    'getById',
    'getByPublicId',
    'getByIdentifier',
    'resolveId',
    'list',
    'listByFilters',
    'count',
    'update',
    'remove',
    'describe',
    'refreshSchema',
    'appendEvent',
    'listEvents'
  ]);

  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      const context = getActiveContext();
      if (!context || !context.db) {
        throw new Error('No tenant DB is available for this operation');
      }
      const db = context.db;
      const value = db[prop];
      if (typeof value === 'function') {
        return (...args) => {
          if (tenantBoundMethods.has(String(prop))) {
            const boundTenantId = context.instance && context.instance.id ? context.instance.id : null;
            if (!boundTenantId) {
              throw new Error(`Tenant context is required for db.${String(prop)}()`);
            }
            if (context.tenantId && context.tenantId !== boundTenantId) {
              throw new Error(`Tenant context mismatch for db.${String(prop)}()`);
            }
          }
          return value.apply(db, args);
        };
      }
      return value;
    }
  });
}

function buildTenantDbConfig(instance) {
  const dbConfig = instance.db_config || {};
  const client = String(instance.db_client || dbConfig.client || '').trim().toLowerCase();

  if (!client) {
    throw new Error(`Instance '${instance.id}' is missing db_client`);
  }

  return {
    client,
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    file: dbConfig.file
  };
}

function getInstanceRevision(instance) {
  return [
    instance.updated_at || '',
    instance.db_client || '',
    instance.db_config_json || ''
  ].join('|');
}

function createTenantManager({ controlStore, modulesDir, strictMigrations = true }) {
  const cache = new Map();

  async function buildTenantRuntime(instance) {
    const dbConfig = buildTenantDbConfig(instance);
    const db = await createDataSource(dbConfig);
    await db.initSchema();
    const authStore = createAuthStore(db);
    await authStore.ensureSchema(instance.id);
    const migrationSummary = await applyModuleMigrations(db, modulesDir, { strict: strictMigrations });

    return {
      instance,
      revision: getInstanceRevision(instance),
      db,
      migrationSummary
    };
  }

  async function getOrCreateTenantRuntime(instance) {
    const cacheKey = instance.id;
    const currentRevision = getInstanceRevision(instance);
    const existing = cache.get(cacheKey);

    if (existing && existing.revision === currentRevision) {
      return existing;
    }

    if (existing) {
      await existing.db.close();
      cache.delete(cacheKey);
    }

    const runtime = await buildTenantRuntime(instance);
    cache.set(cacheKey, runtime);
    return runtime;
  }

  async function resolveTenantForHost(host, domainOverride = null) {
    const normalizedHost = normalizeHost(host);
    const normalizedDomain = normalizeDomain(domainOverride || deriveDomainFromHost(normalizedHost));

    if (!normalizedHost || !normalizedDomain) {
      return null;
    }

    const instance = await controlStore.resolveByHostAndDomain(normalizedHost, normalizedDomain);
    if (!instance) {
      return null;
    }

    const runtime = await getOrCreateTenantRuntime(instance);
    return {
      host: normalizedHost,
      domain: normalizedDomain,
      instance: runtime.instance,
      db: runtime.db
    };
  }

  async function resolveTenantByInstanceId(instanceId) {
    const normalizedInstanceId = String(instanceId || '').trim();
    if (!normalizedInstanceId) {
      return null;
    }
    const instance = await controlStore.getInstance(normalizedInstanceId);
    if (!instance || String(instance.status || '').toLowerCase() !== 'active') {
      return null;
    }
    const runtime = await getOrCreateTenantRuntime(instance);
    return {
      host: null,
      domain: null,
      instance: runtime.instance,
      db: runtime.db
    };
  }

  async function getDefaultTenant() {
    const instance = await controlStore.getDefaultInstance();
    if (!instance) return null;
    const runtime = await getOrCreateTenantRuntime(instance);
    return {
      host: null,
      domain: null,
      instance: runtime.instance,
      db: runtime.db
    };
  }

  async function ensureBootstrapTenant({ host, domain, dbClient, dbConfig }) {
    const instance = await controlStore.ensureBootstrapTenant({ host, domain, dbClient, dbConfig });
    if (!instance) return null;
    const runtime = await getOrCreateTenantRuntime(instance);
    return {
      host: normalizeHost(host),
      domain: normalizeDomain(domain),
      instance: runtime.instance,
      db: runtime.db
    };
  }

  async function warmActiveTenants() {
    const instances = await controlStore.listInstances();
    const active = instances.filter((instance) => String(instance.status || '').toLowerCase() === 'active');
    await Promise.all(active.map((instance) => getOrCreateTenantRuntime(instance)));
    return active.length;
  }

  async function closeAll() {
    const runtimes = Array.from(cache.values());
    cache.clear();
    await Promise.all(runtimes.map((runtime) => runtime.db.close().catch(() => null)));
  }

  function invalidateInstance(instanceId) {
    const existing = cache.get(instanceId);
    if (!existing) return;
    cache.delete(instanceId);
    existing.db.close().catch(() => null);
  }

  function invalidateAll() {
    const runtimes = Array.from(cache.values());
    cache.clear();
    for (const runtime of runtimes) {
      runtime.db.close().catch(() => null);
    }
  }

  return {
    extractRequestHost,
    deriveDomainFromHost,
    extractTenantOverride,
    createScopedDbProxy,
    resolveTenantForHost,
    resolveTenantByInstanceId,
    ensureBootstrapTenant,
    getDefaultTenant,
    warmActiveTenants,
    closeAll,
    invalidateInstance,
    invalidateAll
  };
}

module.exports = {
  createTenantManager,
  deriveDomainFromHost,
  extractRequestHost,
  extractTenantOverride,
  createScopedDbProxy
};
