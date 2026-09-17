import http from 'node:http';
import { getDb, getDataDir, getDbPath, ensureDataDirs } from './db/connection.js';
import { EventBus } from './events/event-bus.js';
import { SseHub } from './events/sse-hub.js';
import { initProjector } from './memory/projector.js';
import { PolicyEngine } from './policy/policy-engine.js';
import { createToolRegistry } from './tools/register-all.js';
import { MockModelProvider } from './agent/mock-model-provider.js';
import { Agent } from './agent/agent.js';
import { Router } from './api/router.js';
import { serveStatic } from './api/static.js';
import { runSeed } from './seed/seed.js';

import { registerHealthRoutes } from './api/routes/health.js';
import { registerAgentRoutes } from './api/routes/agent.js';
import { registerActionRoutes } from './api/routes/actions.js';
import { registerEventRoutes } from './api/routes/events.js';
import { registerCalendarRoutes } from './api/routes/calendar.js';
import { registerTaskRoutes } from './api/routes/tasks.js';
import { registerEmailRoutes } from './api/routes/email.js';
import { registerContactsRoutes } from './api/routes/contacts.js';
import { registerMemoryRoutes } from './api/routes/memory.js';
import { registerDashboardRoutes } from './api/routes/dashboard.js';

export async function startServer({ port } = {}) {
  const resolvedPort = port ?? (Number(process.env.PORT) || 4000);

  const dataDir = ensureDataDirs();
  const db = getDb();
  const dbPath = getDbPath();

  const eventBus = new EventBus(db);
  const sseHub = new SseHub(eventBus);
  initProjector(eventBus);

  const policyEngine = new PolicyEngine();
  const toolRegistry = createToolRegistry();
  const modelProvider = new MockModelProvider();

  const ownerEntityId = runSeed({ eventBus });

  const agent = new Agent({ modelProvider, policyEngine, toolRegistry, eventBus, ownerEntityId });

  const router = new Router();
  const startTime = Date.now();
  registerHealthRoutes(router, { dataDir, dbPath, startTime });
  registerAgentRoutes(router, { agent });
  registerActionRoutes(router, { agent });
  registerEventRoutes(router, { db, sseHub });
  registerCalendarRoutes(router);
  registerTaskRoutes(router, { agent });
  registerEmailRoutes(router);
  registerContactsRoutes(router);
  registerMemoryRoutes(router);
  registerDashboardRoutes(router);

  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      await router.handle(req, res);
    } else {
      serveStatic(req, res);
    }
  });

  await new Promise((resolve) => server.listen(resolvedPort, resolve));

  console.log('U2OS server listening');
  console.log(`  port:     ${resolvedPort}`);
  console.log(`  data dir: ${dataDir}`);
  console.log(`  database: ${dbPath}`);

  return { server, port: resolvedPort, dataDir, dbPath, agent, eventBus, toolRegistry, policyEngine };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer().catch((err) => {
    console.error('Failed to start U2OS server', err);
    process.exit(1);
  });
}
