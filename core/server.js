const path = require('path');
const fs = require('node:fs/promises');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const EventBus = require('./eventBus');
const createEntityRouter = require('./router');
const { loadCapabilityPackages } = require('./pluginLoader');
const { createSolutionRegistry } = require('./registry');
const { createControlStore } = require('./tenancy/controlStore');
const { createTenantManager } = require('./tenancy/tenantManager');
const { runWithRequestContext, getRequestContext } = require('./requestContext');
const { createAuthMiddleware } = require('./auth/middleware');
const { buildAuthConfig, validateAuthConfig } = require('./auth/config');
const { verifyJwt } = require('./auth/jwt');
const { createMetricsRegistry, createRequestTelemetry } = require('./observability');
const { assertAllowedKeys, validateIdentifier } = require('./validation');
const { SCHEMA_KINDS, lintAndPreview, resolveSaveTarget, scaffold } = require('./schemaWorkbench');
const { loadEffectiveSettings, deepMerge } = require('./settings');
const { createSystemRouter } = require('./routes/system');
const { createRealtimeGateway } = require('./realtimeGateway');

const serverHookRegistry = {
  'server.auditView': async ({ req, appId, navItemId, context, options }) => ({
    ok: true,
    hook: 'server.auditView',
    appId,
    navItemId,
    actor: req.auth ? req.auth.userId : (req.headers['x-business-user'] || 'anonymous'),
    area: options?.area || navItemId || null,
    event: context?.event || null,
    at: new Date().toISOString()
  }),
  'server.auditSave': async ({ req, appId, navItemId, context, options }) => ({
    ok: true,
    hook: 'server.auditSave',
    appId,
    navItemId,
    actor: req.auth ? req.auth.userId : (req.headers['x-business-user'] || 'anonymous'),
    area: options?.area || navItemId || null,
    event: context?.event || null,
    at: new Date().toISOString()
  })
};

async function buildServer() {
  const app = express();
  const sendEnvelope = (res, data) => res.json({ version: 'v1', data });
  const trustProxySetting = config.security.trustProxy;
  app.set('trust proxy', trustProxySetting === 'false' ? false : trustProxySetting);

  app.use(helmet({
    contentSecurityPolicy: false
  }));
  app.use(cors({
    origin(origin, callback) {
      const allowlist = config.security.corsAllowlist;
      if (!origin || allowlist.length === 0 || allowlist.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS policy'));
    }
  }));
  app.use('/api/auth/login', express.json({ limit: config.security.authBodyLimit }));
  app.use('/api', express.json({ limit: config.security.apiBodyLimit }));

  const metrics = createMetricsRegistry();
  app.use(createRequestTelemetry({
    getContext: getRequestContext,
    metrics
  }));

  app.use('/api', rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false
  }));
  const authConfig = buildAuthConfig(process.env);
  validateAuthConfig(authConfig);

  const controlStore = await createControlStore(config.controlDb);
  await controlStore.initSchema();
  const bootstrapAdmin = await controlStore.ensureBootstrapAdminLogin({
    email: process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@localhost',
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD || 'admin12345678',
    fullName: process.env.ADMIN_BOOTSTRAP_NAME || 'Install Admin',
    role: process.env.ADMIN_BOOTSTRAP_ROLE || 'owner'
  });

  const tenantManager = createTenantManager({
    controlStore,
    modulesDir: config.modulesDir,
    strictMigrations: config.migrations.strictStartup
  });

  await tenantManager.ensureBootstrapTenant({
    host: config.tenancy.bootstrapHost,
    domain: config.tenancy.bootstrapDomain,
    dbClient: config.db.client,
    dbConfig: config.db
  });

  let defaultTenant = await tenantManager.getDefaultTenant();
  if (!defaultTenant) {
    throw new Error('No active tenant instances found. Add at least one instance and domain mapping.');
  }
  const warmedTenantCount = await tenantManager.warmActiveTenants();

  async function refreshDefaultTenant() {
    const latestDefault = await tenantManager.getDefaultTenant();
    if (latestDefault) {
      defaultTenant = latestDefault;
    }
    return defaultTenant;
  }

  function getActiveContext() {
    return getRequestContext() || defaultTenant;
  }

  const db = tenantManager.createScopedDbProxy(() => getActiveContext());

  const eventBus = new EventBus({
    persistEvent: async (eventName, payload) => {
      const context = getActiveContext();
      await context.db.appendEvent(eventName, payload);
    },
    resolveContext: () => getRequestContext() || getActiveContext(),
    replayLimit: config.realtime.backlogSize
  });

  app.use(async (req, res, next) => {
    const requestPath = req.path || '';
    const isControlPlane = requestPath === '/health'
      || requestPath === '/ready'
      || requestPath.startsWith('/admin');

    if (isControlPlane) {
      return next();
    }

    try {
      let tenant = null;
      const tenantOverrideId = config.tenancy.allowOverride
        ? tenantManager.extractTenantOverride(req, {
          headerName: config.tenancy.overrideHeader,
          queryParam: config.tenancy.overrideQueryParam
        })
        : '';

      if (tenantOverrideId) {
        tenant = await tenantManager.resolveTenantByInstanceId(tenantOverrideId);
        if (!tenant) {
          if (requestPath.startsWith('/api/')) {
            return res.status(404).json({ error: `No active tenant instance '${tenantOverrideId}'` });
          }
          return res.status(404).send(`No active tenant instance '${tenantOverrideId}'`);
        }
      } else if (config.tenancy.mode === 'local' && !config.tenancy.strictHostMatch) {
        tenant = null;
      } else {
        const host = tenantManager.extractRequestHost(req, {
          trustForwardedHost: config.tenancy.trustForwardedHost
        });
        if (!host) {
          console.warn(JSON.stringify({
            level: 'warn',
            at: new Date().toISOString(),
            type: 'tenancy_resolution_missing_host',
            requestId: req.requestId || null,
            path: req.path
          }));
        }
        tenant = await tenantManager.resolveTenantForHost(host);

        if (!tenant && config.tenancy.strictHostMatch) {
          console.warn(JSON.stringify({
            level: 'warn',
            at: new Date().toISOString(),
            type: 'tenancy_resolution_miss',
            requestId: req.requestId || null,
            host,
            path: req.path
          }));
          if (requestPath.startsWith('/api/')) {
            return res.status(404).json({ error: `No tenant mapping for host '${host}'` });
          }
          return res.status(404).send(`No tenant mapping for host '${host}'`);
        }

        if (!tenant && !config.tenancy.strictHostMatch && requestPath.startsWith('/api/')) {
          console.warn(JSON.stringify({
            level: 'warn',
            at: new Date().toISOString(),
            type: 'tenancy_resolution_fallback_default',
            requestId: req.requestId || null,
            host,
            path: req.path,
            defaultTenantId: defaultTenant.instance.id
          }));
        }
      }

      const context = tenant || defaultTenant;
      const requestContext = {
        ...context,
        requestId: req.requestId || null,
        traceId: req.traceId || null
      };
      return runWithRequestContext(requestContext, () => next());
    } catch (error) {
      return next(error);
    }
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      tenancyMode: config.tenancy.mode,
      controlDbClient: controlStore.client,
      defaultTenantId: defaultTenant.instance.id,
      time: new Date().toISOString()
    });
  });

  app.get('/ready', async (req, res) => {
    try {
      await controlStore.listInstances();
      await defaultTenant.db.query('SELECT 1 AS ok');
      res.json({
        ok: true,
        controlDb: true,
        tenantDb: true,
        defaultTenantId: defaultTenant.instance.id,
        time: new Date().toISOString()
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error.message || 'readiness check failed',
        time: new Date().toISOString()
      });
    }
  });

  app.get('/', (req, res) => {
    res.redirect('/app');
  });

  function extractBearerToken(headerValue) {
    const value = String(headerValue || '').trim();
    if (!value) return null;
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  }

  function requireControlAdminAuth() {
    return async (req, res, next) => {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      let payload;
      try {
        payload = verifyJwt(token, authConfig.jwtSecret);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      if (payload.scope !== 'admin-control') {
        return res.status(403).json({ error: 'Invalid token scope for admin control plane' });
      }

      const adminLogin = await controlStore.getAdminLoginById(payload.sub);
      if (!adminLogin || String(adminLogin.status || '').toLowerCase() !== 'active') {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const scopedInstanceIds = adminLogin.is_superuser
        ? []
        : await controlStore.listAdminLoginInstanceIds(adminLogin.id);

      req.controlAuth = {
        id: adminLogin.id,
        email: adminLogin.email,
        fullName: adminLogin.full_name || null,
        role: adminLogin.role,
        status: adminLogin.status,
        isSuperuser: Boolean(adminLogin.is_superuser),
        scopedInstanceIds
      };

      return next();
    };
  }

  function requireControlSuperuser(req, res, next) {
    if (!req.controlAuth || !req.controlAuth.isSuperuser) {
      return res.status(403).json({ error: 'Superuser permission required' });
    }
    return next();
  }

  function scopedByInstance(rows, allowedInstanceIds) {
    const allowed = new Set(allowedInstanceIds || []);
    return rows.filter((row) => row && allowed.has(row.id || row.instance_id));
  }

  function summarizeScopedCustomers(customers, instances) {
    const counts = new Map();
    for (const instance of instances) {
      const customerId = instance.customer_id;
      if (!customerId) continue;
      counts.set(customerId, (counts.get(customerId) || 0) + 1);
    }
    return (customers || [])
      .filter((customer) => counts.has(customer.id))
      .map((customer) => ({
        ...customer,
        instance_count: counts.get(customer.id) || 0
      }));
  }

  async function getScopedTenancySummary(req) {
    const [customers, instances, domains] = await Promise.all([
      controlStore.listCustomers(),
      controlStore.listInstances(),
      controlStore.listDomains()
    ]);

    if (req.controlAuth.isSuperuser) {
      return { customers, instances, domains };
    }

    const allowedInstanceIds = req.controlAuth.scopedInstanceIds || [];
    const filteredInstances = scopedByInstance(instances, allowedInstanceIds);
    const filteredDomains = domains.filter((domain) => allowedInstanceIds.includes(domain.instance_id));
    const filteredCustomers = summarizeScopedCustomers(customers, filteredInstances);

    return {
      customers: filteredCustomers,
      instances: filteredInstances,
      domains: filteredDomains
    };
  }

  function canAccessInstance(req, instanceId) {
    if (req.controlAuth.isSuperuser) return true;
    return (req.controlAuth.scopedInstanceIds || []).includes(instanceId);
  }

  async function resolveClientNameFromInstance(instance) {
    if (!instance) return null;
    if (instance.customer_id) {
      const customer = await controlStore.getCustomer(instance.customer_id);
      if (customer && customer.name) {
        return customer.name;
      }
    }
    return instance.name || null;
  }

  async function loadSettingsForInstance(instance) {
    const clientName = await resolveClientNameFromInstance(instance);
    return loadEffectiveSettings({
      globalSettingsPath: config.settings.globalFile,
      clientsDir: config.settings.clientsDir,
      clientName
    });
  }

  const solutionRegistry = createSolutionRegistry({
    appsDir: config.appsDir,
    solutionsDir: config.solutionsDir,
    clientsDir: config.settings.clientsDir
  });

  async function resolveClientNameForActiveRequest() {
    const context = getActiveContext();
    return resolveClientNameFromInstance(context.instance);
  }

  app.post('/api/admin/auth/login', async (req, res, next) => {
    try {
      assertAllowedKeys(req.body || {}, new Set(['email', 'password']), 'admin login payload');
      const email = String((req.body && req.body.email) || '').trim();
      const password = String((req.body && req.body.password) || '');
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
      }

      const admin = await controlStore.authenticateAdminLogin(email, password);
      if (!admin) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = authConfig.signToken({
        sub: admin.id,
        scope: 'admin-control',
        role: admin.role,
        is_superuser: Boolean(admin.is_superuser)
      });

      return res.json({
        token,
        tokenType: 'Bearer',
        expiresInSeconds: authConfig.tokenTtlSeconds,
        user: {
          id: admin.id,
          email: admin.email,
          fullName: admin.full_name || null,
          role: admin.role,
          isSuperuser: Boolean(admin.is_superuser)
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/auth/me', requireControlAdminAuth(), async (req, res) => {
    res.json({
      user: {
        id: req.controlAuth.id,
        email: req.controlAuth.email,
        fullName: req.controlAuth.fullName,
        role: req.controlAuth.role,
        isSuperuser: req.controlAuth.isSuperuser,
        instanceScope: req.controlAuth.scopedInstanceIds
      }
    });
  });

  app.get('/api/admin/settings/effective', requireControlAdminAuth(), async (req, res, next) => {
    try {
      const instanceId = String(req.query.instance_id || req.query.instanceId || '').trim();
      let instance = null;

      if (instanceId) {
        if (!canAccessInstance(req, instanceId)) {
          return res.status(403).json({ error: 'Cannot access settings for this instance' });
        }
        instance = await controlStore.getInstance(instanceId);
        if (!instance) {
          return res.status(404).json({ error: 'Instance not found' });
        }
      } else if (req.controlAuth.isSuperuser) {
        instance = await controlStore.getDefaultInstance();
      } else {
        const firstScoped = (req.controlAuth.scopedInstanceIds || [])[0];
        if (firstScoped) {
          instance = await controlStore.getInstance(firstScoped);
        }
      }

      const settings = await loadSettingsForInstance(instance);
      return sendEnvelope(res, {
        instanceId: instance ? instance.id : null,
        instanceName: instance ? instance.name : null,
        clientKey: settings.clientKey,
        effectiveSettings: settings.effectiveSettings,
        source: settings.source
      });
    } catch (error) {
      return next(error);
    }
  });

  const auth = createAuthMiddleware({ db, authConfig });

  app.post('/api/auth/login', auth.loginHandler);
  app.use('/api', auth.authenticateRequest({
    allowAnonymousPaths: ['/auth/login', '/admin/auth/login'],
    allowAnonymousPrefixes: ['/admin/']
  }));
  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.auth || null });
  });

  app.use('/api', createEntityRouter(db, eventBus, {
    requireEntityMutationRole: auth.requireEntityMutationRole
  }));

  const { capabilityPackages, modules, scheduler } = await loadCapabilityPackages({
    app,
    db,
    eventBus,
    modulesDir: config.modulesDir
  });

  app.get('/api/system/capability-packages', (req, res) => {
    sendEnvelope(res, { capabilityPackages, jobs: scheduler.listJobs() });
  });

  app.get('/api/system/modules', (req, res) => {
    // Backward-compatible alias. "modules" now refers to executable capability packages.
    sendEnvelope(res, { modules, jobs: scheduler.listJobs() });
  });

  app.get('/api/system/metrics', (req, res) => {
    sendEnvelope(res, {
      generatedAt: new Date().toISOString(),
      routes: metrics.snapshot()
    });
  });

  app.get('/api/system', (req, res) => {
    const context = getActiveContext();
    sendEnvelope(res, {
      app: 'u2os',
      version: '0.1.0',
      dbClient: db.client,
      tenantId: context.instance.id,
      capabilityPackagesLoaded: capabilityPackages.length,
      capabilityPackages: capabilityPackages.map((m) => ({
        name: m.name,
        version: m.version,
        slug: m.slug,
        description: m.description
      })),
      modulesLoaded: capabilityPackages.length,
      modules: capabilityPackages.map((m) => ({
        name: m.name,
        version: m.version,
        slug: m.slug,
        description: m.description
      }))
    });
  });

  app.get('/api/system/settings', async (req, res, next) => {
    try {
      const context = getActiveContext();
      const settings = await loadSettingsForInstance(context.instance);

      // Merge any per-instance settings_override stored in the control DB
      // on top of the effective settings (global + client-file layer).
      let effectiveSettings = settings.effectiveSettings;
      const instanceRow = await controlStore.getInstance(context.instance.id);
      if (instanceRow && instanceRow.settings_override) {
        let override = {};
        try { override = JSON.parse(instanceRow.settings_override); } catch { /* ignore */ }
        if (override && typeof override === 'object') {
          effectiveSettings = deepMerge(effectiveSettings, override);
        }
      }

      return sendEnvelope(res, {
        clientKey: settings.clientKey,
        effectiveSettings,
        source: settings.source
      });
    } catch (error) {
      return next(error);
    }
  });

  // ── System routes: onboarding wizard + per-tenant settings PUT ────────────
  // Mount after the GET /api/system/settings handler above (which takes
  // precedence for GET) so that POST/PUT and /onboarding/* sub-paths are
  // handled by the dedicated router.
  const globalSettingsRaw = (() => {
    try {
      return require('fs').existsSync(path.resolve(process.cwd(), config.settings.globalFile))
        ? JSON.parse(require('fs').readFileSync(path.resolve(process.cwd(), config.settings.globalFile), 'utf8'))
        : {};
    } catch { return {}; }
  })();

  const systemRouter = createSystemRouter({
    controlStore,
    getActiveContext,
    loadSettingsForInstance,
    globalSettings: globalSettingsRaw,
    updateInstanceOnboardingState: (id, json) => controlStore.updateInstanceOnboardingState(id, json),
    updateInstanceSettingsOverride: (id, json) => controlStore.updateInstanceSettingsOverride(id, json)
  });
  app.use('/api/system', systemRouter);

  app.get('/api/apps', async (req, res, next) => {
    try {
      const appIds = await solutionRegistry.listRuntimeAppIds();
      res.json({
        defaultAppId: config.defaultAppId,
        apps: appIds
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/apps/:appId', async (req, res, next) => {
    try {
      const clientName = await resolveClientNameForActiveRequest();
      const { appDefinition } = await solutionRegistry.loadRuntimeApp(req.params.appId, { clientName });
      res.json(appDefinition);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: `Unknown app '${req.params.appId}'` });
      }
      if (error.message && error.message.startsWith('Invalid app id')) {
        return res.status(400).json({ error: error.message });
      }
      return next(error);
    }
  });

  app.post('/api/apps/:appId/hooks/:hookName', async (req, res, next) => {
    try {
      const clientName = await resolveClientNameForActiveRequest();
      await solutionRegistry.loadRuntimeApp(req.params.appId, { clientName });
      const hookFn = serverHookRegistry[req.params.hookName];
      if (!hookFn) {
        return res.status(404).json({ error: `Unknown server hook '${req.params.hookName}'` });
      }

      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['navItemId', 'context', 'options']), 'apps hook payload');
      const result = await hookFn({
        req,
        appId: req.params.appId,
        navItemId: payload.navItemId || null,
        context: payload.context || {},
        options: payload.options || {}
      });
      return res.json({ ok: true, result });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: `Unknown app '${req.params.appId}'` });
      }
      if (error.message && error.message.startsWith('Invalid app id')) {
        return res.status(400).json({ error: error.message });
      }
      return next(error);
    }
  });

  app.get('/api/solutions', async (req, res, next) => {
    try {
      const solutionIds = await solutionRegistry.listSolutionIds();
      return sendEnvelope(res, { solutions: solutionIds });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/solutions/:solutionId', async (req, res, next) => {
    try {
      const clientName = await resolveClientNameForActiveRequest();
      const effective = await solutionRegistry.loadEffectiveSolution(req.params.solutionId, { clientName });
      return sendEnvelope(res, {
        appId: effective.appId,
        sourceModel: effective.sourceModel,
        source: effective.source,
        overlayApplied: effective.overlayApplied,
        overlaySource: effective.overlaySource,
        clientKey: effective.clientKey,
        solution: effective.solution
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: `Unknown solution '${req.params.solutionId}'` });
      }
      return next(error);
    }
  });

  app.use('/api/admin/tenancy', requireControlAdminAuth());
  app.use('/api/admin/schema-workbench', requireControlAdminAuth());

  app.get('/api/admin/schema-workbench/kinds', (req, res) => {
    sendEnvelope(res, { kinds: SCHEMA_KINDS });
  });

  app.get('/api/admin/schema-workbench/scaffold/:kind', (req, res, next) => {
    try {
      const payload = scaffold(req.params.kind, {
        appId: req.query.appId,
        moduleId: req.query.moduleId,
        processId: req.query.processId,
        templateId: req.query.templateId,
        clientId: req.query.clientId,
        baseAppId: req.query.baseAppId
      });
      return sendEnvelope(res, payload);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/admin/schema-workbench/lint', (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['kind', 'jsonText', 'document']), 'schema workbench lint payload');
      if (typeof payload.kind !== 'string') {
        return res.status(400).json({ error: 'kind is required' });
      }

      let document = payload.document;
      if (payload.jsonText != null) {
        if (typeof payload.jsonText !== 'string') {
          return res.status(400).json({ error: 'jsonText must be a string when provided' });
        }
        try {
          document = JSON.parse(payload.jsonText);
        } catch (error) {
          return sendEnvelope(res, {
            ok: false,
            errors: [`Invalid JSON: ${error.message}`],
            warnings: [],
            preview: {}
          });
        }
      }

      const result = lintAndPreview({ kind: payload.kind, document });
      return sendEnvelope(res, result);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/admin/schema-workbench/save', requireControlSuperuser, async (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['kind', 'jsonText', 'document', 'saveAs']), 'schema workbench save payload');
      if (typeof payload.kind !== 'string') {
        return res.status(400).json({ error: 'kind is required' });
      }

      let document = payload.document;
      if (payload.jsonText != null) {
        if (typeof payload.jsonText !== 'string') {
          return res.status(400).json({ error: 'jsonText must be a string when provided' });
        }
        try {
          document = JSON.parse(payload.jsonText);
        } catch (error) {
          return res.status(400).json({ error: `Invalid JSON: ${error.message}` });
        }
      }

      const lint = lintAndPreview({ kind: payload.kind, document });
      if (!lint.ok) {
        return res.status(400).json({ error: 'Schema is invalid; fix lint errors before saving', details: lint.errors });
      }

      const relativePath = resolveSaveTarget({
        kind: payload.kind,
        document,
        saveAs: payload.saveAs
      });
      const absolutePath = path.resolve(process.cwd(), relativePath);
      const workspaceRoot = path.resolve(process.cwd());
      if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`) && absolutePath !== workspaceRoot) {
        return res.status(400).json({ error: 'Invalid save path target' });
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(`${absolutePath}.tmp`, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await fs.rename(`${absolutePath}.tmp`, absolutePath);

      return sendEnvelope(res, { ok: true, path: relativePath });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/tenancy/summary', async (req, res, next) => {
    try {
      sendEnvelope(res, await getScopedTenancySummary(req));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/tenancy/customers', async (req, res, next) => {
    try {
      const summary = await getScopedTenancySummary(req);
      sendEnvelope(res, summary.customers);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/tenancy/customers', requireControlSuperuser, async (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['id', 'name', 'status', 'metadata']), 'customer payload');
      const customer = await controlStore.createCustomer(payload);
      res.status(201).json({ version: 'v1', data: customer });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/tenancy/customers/:customerId', requireControlSuperuser, async (req, res, next) => {
    try {
      const customerId = validateIdentifier(req.params.customerId, 'customerId');
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['name', 'status', 'metadata']), 'customer payload');
      const customer = await controlStore.updateCustomer(customerId, payload);
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      return sendEnvelope(res, customer);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/tenancy/instances', async (req, res, next) => {
    try {
      const summary = await getScopedTenancySummary(req);
      sendEnvelope(res, summary.instances);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/tenancy/instances', requireControlSuperuser, async (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['id', 'customer_id', 'name', 'status', 'is_default', 'db_client', 'db_config', 'app_config']), 'instance payload');
      const instance = await controlStore.createInstance(payload);
      tenantManager.invalidateAll();
      await refreshDefaultTenant();
      res.status(201).json({ version: 'v1', data: instance });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/tenancy/instances/:instanceId', async (req, res, next) => {
    try {
      const instanceId = validateIdentifier(req.params.instanceId, 'instanceId');
      if (!canAccessInstance(req, instanceId)) {
        return res.status(403).json({ error: 'Cannot manage this instance' });
      }
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['customer_id', 'name', 'status', 'is_default', 'db_client', 'db_config', 'app_config']), 'instance payload');
      if (!req.controlAuth.isSuperuser && Object.prototype.hasOwnProperty.call(payload, 'is_default')) {
        return res.status(403).json({ error: 'Only superusers can change default instance' });
      }
      const instance = await controlStore.updateInstance(instanceId, payload);
      if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
      }
      if (!canAccessInstance(req, instance.id)) {
        return res.status(403).json({ error: 'Cannot manage this instance' });
      }
      tenantManager.invalidateInstance(instance.id);
      await refreshDefaultTenant();
      return sendEnvelope(res, instance);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/admin/tenancy/domains', async (req, res, next) => {
    try {
      const summary = await getScopedTenancySummary(req);
      sendEnvelope(res, summary.domains);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/tenancy/domains', async (req, res, next) => {
    try {
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['id', 'instance_id', 'host', 'domain', 'status']), 'domain payload');
      const targetInstanceId = String(payload.instance_id || '').trim();
      if (!targetInstanceId) {
        return res.status(400).json({ error: 'instance_id is required' });
      }
      if (!canAccessInstance(req, targetInstanceId)) {
        return res.status(403).json({ error: 'Cannot manage mappings for this instance' });
      }
      const domain = await controlStore.createDomain(payload);
      tenantManager.invalidateAll();
      await refreshDefaultTenant();
      res.status(201).json({ version: 'v1', data: domain });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/tenancy/domains/:domainId', async (req, res, next) => {
    try {
      const domainId = validateIdentifier(req.params.domainId, 'domainId');
      const payload = req.body || {};
      assertAllowedKeys(payload, new Set(['instance_id', 'host', 'domain', 'status']), 'domain payload');
      const existingDomain = await controlStore.getDomain(domainId);
      if (!existingDomain) {
        return res.status(404).json({ error: 'Domain mapping not found' });
      }
      if (!canAccessInstance(req, existingDomain.instance_id)) {
        return res.status(403).json({ error: 'Cannot manage mappings for this instance' });
      }
      const targetInstanceId = payload.instance_id == null
        ? existingDomain.instance_id
        : String(payload.instance_id || '').trim();
      if (!canAccessInstance(req, targetInstanceId)) {
        return res.status(403).json({ error: 'Cannot move mapping to this instance' });
      }
      const domain = await controlStore.updateDomain(domainId, payload);
      if (!domain) {
        return res.status(404).json({ error: 'Domain mapping not found' });
      }
      tenantManager.invalidateAll();
      await refreshDefaultTenant();
      return sendEnvelope(res, domain);
    } catch (error) {
      return next(error);
    }
  });

  app.use('/dashboard', express.static(path.join(process.cwd(), 'ui', 'dashboard')));
  app.use('/admin', express.static(path.join(process.cwd(), 'ui', 'admin')));
  app.use('/app', express.static(path.join(process.cwd(), 'ui', 'app')));
  app.use('/onboarding', express.static(path.join(process.cwd(), 'ui', 'onboarding')));
  app.use('/modules', express.static(path.join(process.cwd(), 'modules')));

  app.use((err, req, res, next) => {
    const statusCode = Number(err && err.statusCode) || 500;
    console.error(JSON.stringify({
      level: 'error',
      at: new Date().toISOString(),
      type: 'http_error',
      requestId: req.requestId || null,
      traceId: req.traceId || null,
      method: req.method,
      path: req.path,
      statusCode,
      message: err && err.message ? err.message : 'Internal server error'
    }));
    res.status(statusCode).json({
      error: err.message || 'Internal server error',
      details: err.details || null,
      requestId: req.requestId || null,
      traceId: req.traceId || null
    });
  });

  const server = app.listen(config.port, () => {
    console.log(`U2OS listening on http://localhost:${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}/dashboard`);
    console.log(`Tenancy admin: http://localhost:${config.port}/admin`);
    console.log(`User app runtime: http://localhost:${config.port}/app`);
    console.log(`Control DB connector: ${controlStore.client}`);
    console.log(`Tenancy mode: ${config.tenancy.mode} (strictHostMatch=${config.tenancy.strictHostMatch})`);
    console.log(`Migration strict startup: ${config.migrations.strictStartup}`);
    console.log(`Active tenants warmed: ${warmedTenantCount}`);
    console.log(`Bootstrap admin: ${bootstrapAdmin.email} (superuser)`);
    console.log(`Loaded capability packages: ${capabilityPackages.map((m) => m.name).join(', ') || '(none)'}`);
  });

  async function resolveTenantForRealtimeSocket(req, tokenPayload) {
    const tokenTenantId = String(tokenPayload && tokenPayload.tid ? tokenPayload.tid : '').trim();
    if (tokenTenantId) {
      const tokenTenant = await tenantManager.resolveTenantByInstanceId(tokenTenantId);
      if (tokenTenant) {
        return tokenTenant;
      }
      return null;
    }

    const host = tenantManager.extractRequestHost(req, {
      trustForwardedHost: config.tenancy.trustForwardedHost
    });
    const resolved = await tenantManager.resolveTenantForHost(host);
    if (resolved) {
      return resolved;
    }
    if (config.tenancy.mode === 'local' || !config.tenancy.strictHostMatch) {
      return defaultTenant;
    }
    return null;
  }

  const realtimeGateway = config.realtime.enabled
    ? createRealtimeGateway({
      server,
      eventBus,
      authConfig,
      path: config.realtime.path,
      replayLimit: config.realtime.replayLimit,
      maxSubscriptions: config.realtime.maxSubscriptions,
      resolveTenantForSocket: resolveTenantForRealtimeSocket
    })
    : null;

  if (realtimeGateway) {
    const address = server.address();
    const host = address && address.address ? address.address : '127.0.0.1';
    const port = address && address.port ? address.port : config.port;
    console.log(`Realtime gateway: ws://${host === '::' ? '127.0.0.1' : host}:${port}${config.realtime.path}`);
  }

  const shutdown = async ({ exitProcess = true } = {}) => {
    scheduler.stopAll();
    if (realtimeGateway) {
      await realtimeGateway.close();
    }
    await tenantManager.closeAll();
    await controlStore.close();
    await new Promise((resolve) => server.close(resolve));
    if (exitProcess) {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown({ exitProcess: true }));
  process.on('SIGTERM', () => shutdown({ exitProcess: true }));

  return {
    app,
    server,
    db,
    eventBus,
    capabilityPackages,
    modules: capabilityPackages,
    controlStore,
    shutdown,
    scheduler,
    realtimeGateway
  };
}

if (require.main === module) {
  buildServer().catch((error) => {
    console.error('Failed to start U2OS:', error);
    process.exit(1);
  });
}

module.exports = { buildServer };
