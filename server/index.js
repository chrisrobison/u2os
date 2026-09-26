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
import { reconcileInterruptedRuns } from './agent/run-store.js';
import { Router } from './api/router.js';
import { serveStatic } from './api/static.js';
import { runSeed } from './seed/seed.js';
import { ensureInstallationMode } from './seed/installation-mode.js';
import { ensureDefaultConnectorsConfig } from './integrations/connectors-config.js';
import { ensureConnectionInstancesMigrated } from './integrations/connection-instances.js';
import { startAll as startSyncScheduler, stopAll as stopSyncScheduler } from './integrations/sync-scheduler.js';
import * as triggerEngine from './triggers/trigger-engine.js';
import { startMdns } from './discovery/mdns.js';
import { DeviceRegistry } from './devices/device-registry.js';
import { createCapabilityRegistry } from './devices/register-capabilities.js';
import { MockDeviceAdapter } from './devices/adapters/mock-device-adapter.js';
import { WebSocketDeviceAdapter } from './devices/adapters/websocket-device-adapter.js';
import { NotificationServiceAdapter } from './devices/adapters/notification-service-adapter.js';
import { getOrCreateDeviceConnectToken } from './devices/realtime/device-token.js';
import { StreamRegistry } from './devices/stream-registry.js';
import { log } from './logging/logger.js';
import { generateOrLoadMasterKey } from './security/vault.js';
import { AuthService } from './security/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalDataHome, acquireHomeGuard, waitForClosingRuntime } from './runtime/home-guard.js';
import { requestLogMetadata } from './logging/request-metadata.js';

import { registerHealthRoutes } from './api/routes/health.js';
import { registerAgentRoutes } from './api/routes/agent.js';
import { registerGoalRoutes } from './api/routes/goals.js';
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
import { registerDiagnosticsRoutes } from './api/routes/diagnostics.js';

export async function startServer(options = {}) {
  const home = canonicalDataHome(getDataDir());
  await waitForClosingRuntime(home);
  const guard = acquireHomeGuard(home);
  let preparedDevices = null;
  try {
    const handle = await initializeServer(options, (registry) => { preparedDevices = registry; });
    const closed = new Promise((resolve, reject) => {
      handle.server.once('close', () => {
        const drain = (async () => {
          await handle.stopBackgroundWorkers();
          await handle.drainRequests();
          guard.release();
        })();
        guard.markClosing(drain);
        drain.then(resolve, reject);
      });
    });
    closed.catch(() => { log.error('server', 'Runtime shutdown incomplete; ownership retained until process exit'); });
    let shuttingDown = false;
    const shutdown = () => {
      if (!shuttingDown) {
        shuttingDown = true;
        handle.server.close();
        handle.server.closeAllConnections();
        handle.stopBackgroundWorkers().catch(() => {});
      }
      return closed;
    };
    return { ...handle, closed, shutdown };
  } catch (error) {
    await preparedDevices?.stopAll();
    if (error.code !== 'STARTUP_CLEANUP_INCOMPLETE') guard.release();
    throw error;
  }
}

async function initializeServer({ port, bind, sessionIdleSeconds, sessionAbsoluteSeconds, mode = null,
  developmentMode = process.env.U2OS_DEVELOPMENT_MODE === '1' } = {}, onPreparedDevices) {

  const installationMode = ensureInstallationMode(mode);
  const deviceDebugEnabled = developmentMode === true && process.env.NODE_ENV !== 'production';
  if (deviceDebugEnabled) log.warn('server', 'Development device debug execution enabled: raw routes bypass normal tool policy/audit. Do not use for personal operation.');
  const dataDir = ensureDataDirs();
  // SECURITY: create the credentials/ dir + master key now, at 0700, rather
  // than lazily on first credential save -- see the comment on SUBDIRS in
  // server/db/connection.js for why this can't just be another entry in
  // that generic loop.
  generateOrLoadMasterKey(dataDir);
  const db = getDb();
  reconcileInterruptedRuns();
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

  // Device/capability subsystem, Phase 1 (docs/devices.md): a persisted
  // device registry plus an in-memory capability catalog, the same
  // registry/catalog split as `triggers` (persisted) vs `ToolRegistry`
  // (in-memory, code-defined). MockDeviceAdapter belongs only to an isolated
  // demo home; personal operation never substitutes fictional devices.
  // Constructed before toolRegistry
  // below so the Phase 5 presentation.* tools can be given a real
  // deviceRegistry/capabilityRegistry at registration time.
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  onPreparedDevices(deviceRegistry);
  if (installationMode === 'demo') await deviceRegistry.registerAdapter(new MockDeviceAdapter());
  // Service-provider unification proof of concept (Phase 9): wraps the
  // EXISTING notifications connector (server/integrations/provider-registry.js)
  // as a device-model provider of the notification.send capability -- see
  // server/devices/adapters/notification-service-adapter.js's header for
  // why this one integration, and why it's a thin wrapper, not a rewrite.
  await deviceRegistry.registerAdapter(new NotificationServiceAdapter());
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
  // Stream abstraction (Phase 8): metadata/reference registry only -- see
  // server/devices/stream-registry.js's header for why this never proxies
  // media itself.
  const streamRegistry = new StreamRegistry({ deviceRegistry, eventBus });

  const toolRegistry = createToolRegistry({ deviceRegistry, capabilityRegistry });
  // ModelRouter subsumes the old single-provider construction: a plain
  // config.json {provider,baseUrl,model} (still what POST /api/model
  // writes) is normalized into one provider used for every role, so this
  // is a no-op change for every existing installation. See
  // server/agent/model-router.js and docs/models.md.
  const modelRouter = createModelRouter(dataDir);
  // Semantic memory retrieval (PLAN.md Phase 5) is opt-in: most
  // installations have no explicit `embeddings` role configured, so
  // ContextAssembler falls back to its confidence/recency-only ranking.
  // Deliberately does NOT rely on
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

  const demoOwnerEntityId = installationMode === 'demo' ? runSeed({ eventBus }) : null;
  const ownerEntityId = auth.ensureOwnerEntityLink()?.id || null;

  // Phase 3: connectors.yaml is written with all-mock defaults on first run
  // (same idempotent pattern as policies-loader.js), then sync-scheduler
  // starts a poll timer only for domains with an actually-connected real
  // provider -- with zero connectors configured this starts zero timers and
  // changes no other startup behavior.
  ensureDefaultConnectorsConfig(dataDir);
  // Issue #163 (PR 1 of 5): one-time, idempotent promotion of any
  // pre-existing legacy single-account credential file into the new
  // connection_instances table -- safe to run on every boot (skips
  // connectors already migrated). See
  // server/integrations/connection-instances.js's header for the full
  // migration contract.
  ensureConnectionInstancesMigrated({ db, dataDir });

  const agent = new Agent({ modelRouter, policyEngine, toolRegistry, eventBus, ownerEntityId, embeddingProvider, dataProcessingPolicy });
  let queueTick = null;
  let runWake = null;
  let queueStopped = false;
  let actionQueueTimer = null;
  const runQueueTick = () => {
    if (queueStopped || queueTick) return;
    queueTick = (async () => {
      await agent.actionQueueWorker.processNext();
      if (!queueStopped && !runWake) {
        // Slow model planning must not stall unrelated durable delivery.
        runWake = agent.wakeWaitingRuns({ shouldStop: () => queueStopped })
          .catch(() => { log.error('agent', 'Run reconciliation failed; inspect durable run state'); })
          .finally(() => { runWake = null; });
      }
    })().catch(() => {
      log.error('action-queue', 'Queue tick failed; inspect durable action/run state');
    }).finally(() => { queueTick = null; });
  };
  const stopActionQueue = async () => {
    queueStopped = true;
    clearInterval(actionQueueTimer);
    await queueTick;
    await runWake;
  };

  const router = new Router({ auth, publicOrigin });
  const startTime = Date.now();
  registerAuthRoutes(router, { auth, agent, demoOwnerEntityId });
  registerModelRoutes(router);
  registerHealthRoutes(router, { dataDir, dbPath, startTime });
  registerAgentRoutes(router, { agent });
  registerGoalRoutes(router, { agent });
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
  registerDeviceRoutes(router, { deviceRegistry, capabilityRegistry, eventBus, deviceConnectToken, streamRegistry,
    developmentMode: deviceDebugEnabled });
  registerDiagnosticsRoutes(router, { db, dbPath, dataDir, startTime, sseHub, modelRouter, embeddingProvider });

  // Minimal HTTP access log (method, path, status, duration_ms) wrapped
  // around the existing router/static dispatch. This only observes the
  // request/response lifecycle via res's 'finish' event -- it never
  // changes which handler runs or how it responds.
  const activeRequests = new Set();
  const drainRequests = async () => {
    while (activeRequests.size) await Promise.allSettled([...activeRequests]);
  };
  const server = http.createServer(async (req, res) => {
    let finishRequest;
    const request = new Promise((resolve) => { finishRequest = resolve; });
    activeRequests.add(request);
    try {
      const startedAt = Date.now();
      res.on('finish', () => {
        const metadata = requestLogMetadata(req);
        log.info('http', `${metadata.method} ${metadata.path}`, {
          ...metadata,
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
    } catch {
      log.error('http', 'Request dispatch failed');
      try { if (!res.headersSent) res.writeHead(500); res.end('Request failed'); } catch { /* disconnected client */ }
    } finally {
      activeRequests.delete(request);
      finishRequest();
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

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(resolvedPort, resolvedBind, resolve); });
  } catch (error) {
    // No workers have started. Prepared adapters still own resources (e.g.
    // the WebSocket heartbeat); a rejected bind has no close hook to drain them.
    await deviceRegistry.stopAll();
    throw error;
  }
  // resolvedPort may be 0 (OS picks an ephemeral port, e.g. in tests) --
  // use the actually-bound port for mDNS/logging, not the requested one.
  const boundPort = server.address().port;

  // Best-effort mDNS advertisement (server/discovery/mdns.js) -- never
  // blocks or fails startup. Stop it automatically whenever the HTTP server
  // is closed (tests included) so no test run is left holding an open
  // multicast socket.
  let mdnsHandle = null;
  let backgroundStop = null;
  const stopBackgroundWorkers = () => {
    if (!backgroundStop) backgroundStop = Promise.allSettled([
      stopActionQueue(), stopSyncScheduler(), triggerEngine.stopAll(), deviceRegistry.stopAll(),
      Promise.resolve().then(() => mdnsHandle?.stop()),
    ]).then((results) => {
      if (results.some((result) => result.status === 'rejected')) throw new Error('Background cleanup failed; inspect durable state before restarting');
    });
    return backgroundStop;
  };
  server.on('close', () => { stopBackgroundWorkers().catch(() => { log.error('server', 'Background shutdown cleanup failed'); }); });
  try {
    // Start execution only after successful bind, with cleanup installed first.
    startSyncScheduler({ db, eventBus, dataDir });
    actionQueueTimer = setInterval(runQueueTick, Number(process.env.U2OS_ACTION_QUEUE_TICK_MS) || 1_000);
    actionQueueTimer.unref?.();
    // Phase 6 / PROMPT.md §9: both trigger halves retain the normal policy gate.
    const triggerTickMs = Number(process.env.U2OS_TRIGGER_TICK_MS) || undefined;
    triggerEngine.startAll({ eventBus, agent, ...(triggerTickMs ? { tickMs: triggerTickMs } : {}) });
    mdnsHandle = !isLoopback(resolvedBind) ? startMdns({ port: boundPort }) : null;
  } catch (error) {
    server.closeAllConnections();
    const closed = new Promise((resolve) => server.close(resolve));
    let cleanupFailed = false;
    await stopBackgroundWorkers().catch(() => { cleanupFailed = true; log.error('server', 'Failed startup cleanup incomplete'); });
    await closed;
    await drainRequests();
    if (cleanupFailed) {
      const incomplete = new Error('Startup cleanup incomplete; ownership retained until process exit');
      incomplete.code = 'STARTUP_CLEANUP_INCOMPLETE';
      throw incomplete;
    }
    throw error;
  }

  log.info('server', 'U2OS server listening', { bind: resolvedBind, port: boundPort, dataDir, dbPath });

  return { server, port: boundPort, bind: resolvedBind, dataDir, dbPath, agent, eventBus, toolRegistry, policyEngine, auth, mdns: mdnsHandle, deviceRegistry, capabilityRegistry, streamRegistry, stopActionQueue, stopBackgroundWorkers, drainRequests };
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
