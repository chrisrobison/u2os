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
import { ensureDefaultConnectorsConfig } from './integrations/connectors-config.js';
import { startAll as startSyncScheduler } from './integrations/sync-scheduler.js';
import * as triggerEngine from './triggers/trigger-engine.js';
import { startMdns } from './discovery/mdns.js';
import { log } from './logging/logger.js';
import { generateOrLoadMasterKey } from './security/vault.js';

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
import { registerConnectorRoutes } from './api/routes/connectors.js';
import { registerExportRoutes } from './api/routes/export.js';
import { registerVoiceRoutes } from './api/routes/voice.js';
import { registerTriggerRoutes } from './api/routes/triggers.js';
import { registerRecommendationRoutes } from './api/routes/recommendations.js';
import { registerFeedbackRoutes } from './api/routes/feedback.js';

export async function startServer({ port } = {}) {
  const resolvedPort = port ?? (Number(process.env.PORT) || 4000);

  const dataDir = ensureDataDirs();
  // SECURITY: create the credentials/ dir + master key now, at 0700, rather
  // than lazily on first credential save -- see the comment on SUBDIRS in
  // server/db/connection.js for why this can't just be another entry in
  // that generic loop.
  generateOrLoadMasterKey(dataDir);
  const db = getDb();
  const dbPath = getDbPath();

  const eventBus = new EventBus(db);
  const sseHub = new SseHub(eventBus);
  initProjector(eventBus);

  const policyEngine = new PolicyEngine();
  const toolRegistry = createToolRegistry();
  const modelProvider = new MockModelProvider();

  const ownerEntityId = runSeed({ eventBus });

  // Phase 3: connectors.yaml is written with all-mock defaults on first run
  // (same idempotent pattern as policies-loader.js), then sync-scheduler
  // starts a poll timer only for domains with an actually-connected real
  // provider -- with zero connectors configured this starts zero timers and
  // changes no other startup behavior.
  ensureDefaultConnectorsConfig(dataDir);
  startSyncScheduler({ db, eventBus, dataDir });

  const agent = new Agent({ modelProvider, policyEngine, toolRegistry, eventBus, ownerEntityId });

  // Phase 6 / PROMPT.md §9: trigger engine. Event-driven half subscribes to
  // the event bus immediately; polled half ticks every `tickMs` (default
  // 60s -- overridable via U2OS_TRIGGER_TICK_MS, mainly for tests/manual
  // verification). Every action it runs goes through
  // agent.evaluateAndMaybeExecute()/agent.evaluateEvent() -- this is a new
  // *source* of proposed actions, never a bypass of the policy engine.
  const triggerTickMs = Number(process.env.U2OS_TRIGGER_TICK_MS) || undefined;
  triggerEngine.startAll({ eventBus, agent, ...(triggerTickMs ? { tickMs: triggerTickMs } : {}) });

  const router = new Router();
  const startTime = Date.now();
  registerHealthRoutes(router, { dataDir, dbPath, startTime });
  registerAgentRoutes(router, { agent });
  registerActionRoutes(router, { agent, eventBus });
  registerEventRoutes(router, { db, sseHub });
  registerCalendarRoutes(router);
  registerTaskRoutes(router, { agent });
  registerEmailRoutes(router);
  registerContactsRoutes(router);
  registerMemoryRoutes(router);
  registerDashboardRoutes(router, { agent });
  registerConnectorRoutes(router, { db, eventBus });
  registerExportRoutes(router);
  registerVoiceRoutes(router);
  registerTriggerRoutes(router);
  registerRecommendationRoutes(router);
  registerFeedbackRoutes(router, { eventBus });

  // Minimal HTTP access log (method, path, status, duration_ms) wrapped
  // around the existing router/static dispatch. This only observes the
  // request/response lifecycle via res's 'finish' event -- it never
  // changes which handler runs or how it responds.
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      log.info('http', `${req.method} ${req.url}`, {
        method: req.method,
        path: req.url,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });

    if (req.url.startsWith('/api/')) {
      await router.handle(req, res);
    } else {
      serveStatic(req, res);
    }
  });

  await new Promise((resolve) => server.listen(resolvedPort, resolve));
  // resolvedPort may be 0 (OS picks an ephemeral port, e.g. in tests) --
  // use the actually-bound port for mDNS/logging, not the requested one.
  const boundPort = server.address().port;

  // Best-effort mDNS advertisement (server/discovery/mdns.js) -- never
  // blocks or fails startup. Stop it automatically whenever the HTTP server
  // is closed (tests included) so no test run is left holding an open
  // multicast socket.
  const mdnsHandle = startMdns({ port: boundPort });
  server.on('close', () => mdnsHandle?.stop());

  log.info('server', 'U2OS server listening', { port: boundPort, dataDir, dbPath });

  return { server, port: boundPort, dataDir, dbPath, agent, eventBus, toolRegistry, policyEngine, mdns: mdnsHandle };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer().catch((err) => {
    log.error('server', 'Failed to start U2OS server', { error: err?.message || String(err) });
    process.exit(1);
  });
}
