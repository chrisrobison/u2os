const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const EventBus = require('./eventBus');
const createEntityRouter = require('./router');
const { createDataSource } = require('./db');
const { loadPlugins } = require('./pluginLoader');

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

  app.use('/dashboard', express.static(path.join(process.cwd(), 'ui', 'dashboard')));
  app.use('/modules', express.static(path.join(process.cwd(), 'modules')));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  const server = app.listen(config.port, () => {
    console.log(`Business OS listening on http://localhost:${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}/dashboard`);
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
