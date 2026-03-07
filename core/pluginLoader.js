const fs = require('fs');
const path = require('path');
const express = require('express');

function createJobScheduler() {
  const jobs = [];

  return {
    addJob(name, handler, intervalMs) {
      if (!intervalMs || intervalMs < 1000) {
        throw new Error(`Invalid interval for job '${name}'`);
      }
      const id = setInterval(async () => {
        try {
          await handler();
        } catch (error) {
          console.error(`[job:${name}]`, error.message);
        }
      }, intervalMs);

      jobs.push({ name, id, intervalMs });
      return () => clearInterval(id);
    },
    listJobs() {
      return jobs.map(({ id, ...rest }) => rest);
    },
    stopAll() {
      for (const job of jobs) {
        clearInterval(job.id);
      }
    }
  };
}

function resolveIfExists(filePath) {
  return fs.existsSync(filePath) ? filePath : null;
}

async function loadModuleMigrations(db, moduleDir, moduleName) {
  const migrationsDir = path.join(moduleDir, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const applied = [];

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const migrationKey = `${moduleName}:${file}`;
    const didApply = await db.applyMigration(migrationKey, sql);
    if (didApply) {
      applied.push(file);
    }
  }

  return applied;
}

function loadPanelDefinitions(moduleDir) {
  const panelJson = resolveIfExists(path.join(moduleDir, 'ui', 'panel.json'));
  if (!panelJson) {
    return [];
  }

  try {
    const panel = JSON.parse(fs.readFileSync(panelJson, 'utf8'));
    return Array.isArray(panel) ? panel : [panel];
  } catch (error) {
    console.warn(`[pluginLoader] Failed to parse panel.json: ${error.message}`);
    return [];
  }
}

async function loadPlugins({ app, db, eventBus, modulesDir }) {
  const scheduler = createJobScheduler();
  const absoluteModulesDir = path.resolve(process.cwd(), modulesDir);

  if (!fs.existsSync(absoluteModulesDir)) {
    return { modules: [], scheduler };
  }

  const moduleDirs = fs.readdirSync(absoluteModulesDir)
    .map((name) => path.join(absoluteModulesDir, name))
    .filter((dir) => fs.statSync(dir).isDirectory());

  const loadedModules = [];

  for (const moduleDir of moduleDirs) {
    const manifestPath = path.join(moduleDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const moduleName = manifest.name || path.basename(moduleDir);
    const moduleSlug = moduleName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const panelDefs = loadPanelDefinitions(moduleDir);
    const migrations = await loadModuleMigrations(db, moduleDir, moduleName);

    const moduleContext = {
      app,
      db,
      eventBus,
      scheduler,
      module: manifest,
      moduleDir,
      logger: {
        info: (...args) => console.log(`[${moduleName}]`, ...args),
        warn: (...args) => console.warn(`[${moduleName}]`, ...args),
        error: (...args) => console.error(`[${moduleName}]`, ...args)
      }
    };

    const routesPath = resolveIfExists(path.join(moduleDir, 'routes.js'));
    if (routesPath) {
      const router = express.Router();
      const registerRoutes = require(routesPath);
      if (typeof registerRoutes === 'function') {
        await registerRoutes(router, moduleContext);
      }
      app.use(`/api/modules/${moduleSlug}`, router);
    }

    const eventsPath = resolveIfExists(path.join(moduleDir, 'events.js'));
    if (eventsPath) {
      const registerEvents = require(eventsPath);
      if (typeof registerEvents === 'function') {
        await registerEvents(moduleContext);
      }
    }

    const jobsPath = resolveIfExists(path.join(moduleDir, 'jobs.js'));
    if (jobsPath) {
      const registerJobs = require(jobsPath);
      if (typeof registerJobs === 'function') {
        await registerJobs(moduleContext);
      }
    }

    loadedModules.push({
      ...manifest,
      slug: moduleSlug,
      migrationsApplied: migrations,
      panels: panelDefs
    });
  }

  return { modules: loadedModules, scheduler };
}

module.exports = { loadPlugins };
