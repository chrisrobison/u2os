const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const EventBus = require('./eventBus');
const createEntityRouter = require('./router');
const { createDataSource } = require('./db');
const { loadPlugins } = require('./pluginLoader');
const { loadAppDefinition, listAppIds } = require('./appDefinitions');

const serverHookRegistry = {
  'server.auditView': async ({ req, appId, navItemId, context, options }) => ({
    ok: true,
    hook: 'server.auditView',
    appId,
    navItemId,
    actor: req.headers['x-business-user'] || 'anonymous',
    area: options?.area || navItemId || null,
    event: context?.event || null,
    at: new Date().toISOString()
  }),
  'server.auditSave': async ({ req, appId, navItemId, context, options }) => ({
    ok: true,
    hook: 'server.auditSave',
    appId,
    navItemId,
    actor: req.headers['x-business-user'] || 'anonymous',
    area: options?.area || navItemId || null,
    event: context?.event || null,
    at: new Date().toISOString()
  })
};

async function buildServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const db = await createDataSource(config.db);
  await db.initSchema();

  const eventBus = new EventBus({
    persistEvent: async (eventName, payload) => {
      await db.appendEvent(eventName, payload);
    }
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      dbClient: db.client,
      time: new Date().toISOString()
    });
  });

  app.get('/', (req, res) => {
    res.redirect('/app');
  });

  app.use('/api', createEntityRouter(db, eventBus));

  const { modules, scheduler } = await loadPlugins({
    app,
    db,
    eventBus,
    modulesDir: config.modulesDir
  });

  app.get('/api/system/modules', (req, res) => {
    res.json({ modules, jobs: scheduler.listJobs() });
  });

  app.get('/api/system', (req, res) => {
    res.json({
      app: 'business-os',
      version: '0.1.0',
      dbClient: db.client,
      modulesLoaded: modules.length,
      modules: modules.map((m) => ({
        name: m.name,
        version: m.version,
        slug: m.slug,
        description: m.description
      }))
    });
  });

  app.get('/api/apps', async (req, res, next) => {
    try {
      const appIds = await listAppIds(config.appsDir);
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
      const appDefinition = await loadAppDefinition(config.appsDir, req.params.appId);
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
      await loadAppDefinition(config.appsDir, req.params.appId);
      const hookFn = serverHookRegistry[req.params.hookName];
      if (!hookFn) {
        return res.status(404).json({ error: `Unknown server hook '${req.params.hookName}'` });
      }

      const payload = req.body || {};
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

  app.use('/dashboard', express.static(path.join(process.cwd(), 'ui', 'dashboard')));
  app.use('/app', express.static(path.join(process.cwd(), 'ui', 'app')));
  app.use('/modules', express.static(path.join(process.cwd(), 'modules')));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  const server = app.listen(config.port, () => {
    console.log(`Business OS listening on http://localhost:${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}/dashboard`);
    console.log(`User app runtime: http://localhost:${config.port}/app`);
    console.log(`Database connector: ${db.client}`);
    console.log(`Loaded modules: ${modules.map((m) => m.name).join(', ') || '(none)'}`);
  });

  const shutdown = async () => {
    scheduler.stopAll();
    await db.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server, db, eventBus, modules };
}

if (require.main === module) {
  buildServer().catch((error) => {
    console.error('Failed to start Business OS:', error);
    process.exit(1);
  });
}

module.exports = { buildServer };
