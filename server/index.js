import http from 'node:http';
import { getDb, getDataDir, getDbPath, ensureDataDirs } from './db/connection.js';
import { EventBus } from './events/event-bus.js';
import { SseHub } from './events/sse-hub.js';
import { initProjector } from './memory/projector.js';
import { PolicyEngine } from './policy/policy-engine.js';
import { DataProcessingPolicy } from './policy/data-processing-policy.js';
import { createToolRegistry } from './tools/register-all.js';
import { createModelRouter } from './agent/provider-config.js';
import { Agent } from './agent/agent.js';
import { Router } from './api/router.js';
import { serveStatic } from './api/static.js';
import { runSeed } from './seed/seed.js';
import { ensureDefaultConnectorsConfig } from './integrations/connectors-config.js';
import { startAll as startSyncScheduler, stopAll as stopSyncScheduler } from './integrations/sync-scheduler.js';
import * as triggerEngine from './triggers/trigger-engine.js';
import { startMdns } from './discovery/mdns.js';
import { DeviceRegistry } from './devices/device-registry.js';
import { createCapabilityRegistry } from './devices/register-capabilities.js';
import { MockDeviceAdapter } from './devices/adapters/mock-device-adapter.js';
import { WebSocketDeviceAdapter } from './devices/adapters/websocket-device-adapter.js';
import { getOrCreateDeviceConnectToken } from './devices/realtime/device-token.js';
import { log } from './logging/logger.js';
import { generateOrLoadMasterKey } from './security/vault.js';
import { AuthService } from './security/auth.js';
import fs from 'node:fs';
import path from 'node:path';

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
import { registerAuthRoutes } from './api/routes/auth.js';
import { registerModelRoutes } from './api/routes/model.js';
import { registerDeviceRoutes } from './api/routes/devices.js';

export async function startServer({ port, bind, sessionIdleSeconds, sessionAbsoluteSeconds } = {}) {

  const dataDir = ensureDataDirs();
  // SECURITY: create the credentials/ dir + master key now, at 0700, rather
  // than lazily on first credential save -- see the comment on SUBDIRS in
  // server/db/connection.js for why this can't just be another entry in
  // that generic loop.
  generateOrLoadMasterKey(dataDir);
  const db = getDb();
  const dbPath = getDbPath();
  const config = readConfig(dataDir);
  const resolvedPort = port ?? (process.env.PORT !== undefined ? Number(process.env.PORT) : Number(config.port ?? 4000));
  const resolvedBind = bind ?? process.env.U2OS_BIND ?? config.bind ?? '127.0.0.1';
  const publicOrigin = process.env.U2OS_PUBLIC_ORIGIN || config.publicOrigin || null;
  const auth = new AuthService(db, { idleSeconds: sessionIdleSeconds, absoluteSeconds: sessionAbsoluteSeconds });
  if (!isLoopback(resolvedBind) && !auth.hasOwner()) throw new Error('Refusing non-loopback bind before owner authentication is configured. Complete setup on loopback first.');
  if (!isLoopback(resolvedBind)) log.warn('server', 'U2OS is explicitly listening on a non-loopback address; do not expose it to the public internet', { bind: resolvedBind });

  const eventBus = new EventBus(db);
  const sseHub = new SseHub(eventBus);
  initProjector(eventBus);

  const policyEngine = new PolicyEngine();
  // Separate from tool-authorization policy above: governs what DATA may
  // reach which model/destination (server/policy/data-processing-policy.js,
  // docs/policies.md). Loaded from its own <U2OS_HOME>/policies/data-processing.yaml.
  const dataProcessingPolicy = new DataProcessingPolicy();
  const toolRegistry = createToolRegistry();
  // ModelRouter subsumes the old single-provider construction: a plain
  // config.json {provider,baseUrl,model} (still what POST /api/model
  // writes) is normalized into one provider used for every role, so this
  // is a no-op change for every existing installation. See
  // server/agent/model-router.js and docs/models.md.
  const modelRouter = createModelRouter(dataDir);
  // Semantic memory retrieval (PLAN.md Phase 5) is opt-in: most
  // installations have no `embeddings` role configured (no HTTP route
  // writes one yet -- see docs/models.md), so ContextAssembler falls back
  // to its confidence/recency-only ranking. Deliberately does NOT rely on
  // ModelRouter's legacy single-provider "every role uses this one
  // provider" fallback here -- that fallback is correct for the planner/
  // classifier/summarizer/etc. roles (all the same ModelProvider
  // interface), but the single legacy-configured provider is virtually
  // always a planning model, not an embedding model, so resolving it for
  // 'embeddings' would hand ContextAssembler something whose .embed() does
  // not exist. Only resolve when an `embeddings` role was EXPLICITLY
  // configured (the multi-provider config shape).
  let embeddingProvider = null;
  if (modelRouter.listRoles().includes('embeddings')) {
    try {
      embeddingProvider = modelRouter.resolve('embeddings');
    } catch {
      // misconfigured -- semantic ranking simply stays off, never crashes startup.
    }
  }

  const ownerEntityId = runSeed({ eventBus });

  // Phase 3: connectors.yaml is written with all-mock defaults on first run
  // (same idempotent pattern as policies-loader.js), then sync-scheduler
  // starts a poll timer only for domains with an actually-connected real
  // provider -- with zero connectors configured this starts zero timers and
  // changes no other startup behavior.
  ensureDefaultConnectorsConfig(dataDir);
  startSyncScheduler({ db, eventBus, dataDir });

  // Device/capability subsystem, Phase 1 (docs/devices.md): a persisted
  // device registry plus an in-memory capability catalog, the same
  // registry/catalog split as `triggers` (persisted) vs `ToolRegistry`
  // (in-memory, code-defined). MockDeviceAdapter is always registered --
  // same "always available, zero configuration" posture as the mock
  // connector providers -- so the registry is never empty even with no
  // real hardware adapters configured. Capability INVOCATION and the
  // trust/privacy-aware resolver are not implemented yet; this phase is
  // discovery + inspection only.
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  await deviceRegistry.registerAdapter(new MockDeviceAdapter());
  // Realtime device bus (Phase 3): any process speaking the small JSON
  // protocol in websocket-device-adapter.js can register itself as a
  // device over a persistent connection at ws(s)://<host>/ws/devices --
  // wired to the SAME http.Server below via the 'upgrade' event, no new
  // port. deviceConnectToken gates the transport only (see
  // server/devices/realtime/device-token.js); it is not device identity
  // or authorization.
  const deviceConnectToken = getOrCreateDeviceConnectToken(dataDir);
  const wsDeviceAdapter = new WebSocketDeviceAdapter({ connectToken: deviceConnectToken });
  await deviceRegistry.registerAdapter(wsDeviceAdapter);

  const agent = new Agent({ modelRouter, policyEngine, toolRegistry, eventBus, ownerEntityId, embeddingProvider, dataProcessingPolicy });

  // Phase 6 / PROMPT.md §9: trigger engine. Event-driven half subscribes to
  // the event bus immediately; polled half ticks every `tickMs` (default
  // 60s -- overridable via U2OS_TRIGGER_TICK_MS, mainly for tests/manual
  // verification). Every action it runs goes through
  // agent.evaluateAndMaybeExecute()/agent.evaluateEvent() -- this is a new
  // *source* of proposed actions, never a bypass of the policy engine.
  const triggerTickMs = Number(process.env.U2OS_TRIGGER_TICK_MS) || undefined;
  triggerEngine.startAll({ eventBus, agent, ...(triggerTickMs ? { tickMs: triggerTickMs } : {}) });

  const router = new Router({ auth, publicOrigin });
  const startTime = Date.now();
  registerAuthRoutes(router, { auth });
  registerModelRoutes(router);
  registerHealthRoutes(router, { dataDir, dbPath, startTime });
  registerAgentRoutes(router, { agent });
  registerActionRoutes(router, { agent, eventBus });
  registerEventRoutes(router, { db, sseHub });
  registerCalendarRoutes(router);
  registerTaskRoutes(router, { agent });
  registerEmailRoutes(router);
  registerContactsRoutes(router);
  registerMemoryRoutes(router, { eventBus });
  registerDashboardRoutes(router, { agent });
  registerConnectorRoutes(router, { db, eventBus });
  registerExportRoutes(router);
  registerVoiceRoutes(router);
  registerTriggerRoutes(router);
  registerRecommendationRoutes(router);
  registerFeedbackRoutes(router, { eventBus });
  registerDeviceRoutes(router, { deviceRegistry, capabilityRegistry, eventBus });

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

    setSecurityHeaders(res);
    if (req.url.startsWith('/api/')) {
      await router.handle(req, res);
    } else {
      serveStatic(req, res);
    }
  });

  // Realtime device bus upgrade routing: only /ws/devices is ever handed
  // to the WebSocket adapter; anything else requesting an upgrade is
  // refused outright rather than left hanging.
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/ws/devices') {
      wsDeviceAdapter.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(resolvedPort, resolvedBind, resolve); });
  // resolvedPort may be 0 (OS picks an ephemeral port, e.g. in tests) --
  // use the actually-bound port for mDNS/logging, not the requested one.
  const boundPort = server.address().port;

  // Best-effort mDNS advertisement (server/discovery/mdns.js) -- never
  // blocks or fails startup. Stop it automatically whenever the HTTP server
  // is closed (tests included) so no test run is left holding an open
  // multicast socket.
  const mdnsHandle = !isLoopback(resolvedBind) ? startMdns({ port: boundPort }) : null;
  server.on('close', () => {
    mdnsHandle?.stop();
    stopSyncScheduler();
    triggerEngine.stopAll().catch(() => {});
    deviceRegistry.stopAll().catch(() => {});
  });

  log.info('server', 'U2OS server listening', { bind: resolvedBind, port: boundPort, dataDir, dbPath });

  return { server, port: boundPort, bind: resolvedBind, dataDir, dbPath, agent, eventBus, toolRegistry, policyEngine, auth, mdns: mdnsHandle, deviceRegistry, capabilityRegistry };
}

function readConfig(dataDir) { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8')); } catch { return {}; } }
function isLoopback(host) { return host === '127.0.0.1' || host === '::1' || host === 'localhost'; }
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer().catch((err) => {
    log.error('server', 'Failed to start U2OS server', { error: err?.message || String(err) });
    process.exit(1);
  });
}
