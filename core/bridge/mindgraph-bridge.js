const { URL } = require('url');
const { WebSocket, WebSocketServer } = require('ws');
const { uuid } = require('../utils');
const { createBridgeConfig } = require('./bridge-config');

const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function extractBearerToken(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function socketIsOpen(socket) {
  const openState = Number.isFinite(WebSocket.OPEN) ? WebSocket.OPEN : 1;
  return socket && socket.readyState === openState;
}

function safeIso(value, fallback = null) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function toErrorMessage(error) {
  if (!error) return 'Unknown bridge error';
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function parseInboundPayload(rawData) {
  if (!rawData) return null;
  try {
    const decoded = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function createMindGraphBridge({
  eventBus,
  config = createBridgeConfig(),
  logger = console,
  createWsServer
} = {}) {
  if (!eventBus) {
    throw new Error('createMindGraphBridge requires an eventBus instance');
  }

  const bridgeConfig = {
    reconnectBaseMs: DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs: DEFAULT_RECONNECT_MAX_MS,
    ...config
  };

  const forwardAllowlist = new Set(bridgeConfig.forwardAllowlist || []);
  const receiveAllowlist = new Set(bridgeConfig.receiveAllowlist || []);
  const wsServerFactory = typeof createWsServer === 'function'
    ? createWsServer
    : ({ port }) => new WebSocketServer({ port });

  const sessions = new Map();
  const status = {
    connected: false,
    connectedAt: null,
    eventsForwarded: 0,
    eventsReceived: 0,
    lastError: null
  };

  let wsServer = null;
  let unsubscribeBus = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let started = false;
  let shuttingDown = false;

  function logError(error) {
    const message = toErrorMessage(error);
    status.lastError = message;
    logger.error(`[mindgraph-bridge] ${message}`);
  }

  function updateConnectionStatus() {
    status.connected = sessions.size > 0;
    if (status.connected) {
      if (!status.connectedAt) {
        status.connectedAt = new Date().toISOString();
      }
    } else {
      status.connectedAt = null;
    }
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function computeBackoffDelay() {
    const exponent = Math.max(0, reconnectAttempt);
    const delay = bridgeConfig.reconnectBaseMs * (2 ** exponent);
    return Math.min(delay, bridgeConfig.reconnectMaxMs);
  }

  function scheduleReconnect(reason) {
    if (shuttingDown || !started || !bridgeConfig.enabled) return;
    if (reconnectTimer) return;
    const delayMs = computeBackoffDelay();
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startServer();
    }, delayMs);
    if (typeof reconnectTimer.unref === 'function') {
      reconnectTimer.unref();
    }
    if (reason) {
      logger.warn(`[mindgraph-bridge] retrying connection in ${delayMs}ms (${reason})`);
    }
  }

  function closeSession(session) {
    try {
      session.socket.close(1001, 'Bridge shutdown');
    } catch {
      // ignore socket close failures
    }
  }

  function closeAllSessions() {
    for (const session of sessions.values()) {
      closeSession(session);
    }
    sessions.clear();
    updateConnectionStatus();
  }

  function sendJson(socket, payload) {
    if (!socketIsOpen(socket)) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      logError(error);
      return false;
    }
  }

  function normalizeOutboundEnvelope(message) {
    const eventName = String(message?.eventName || '').trim();
    if (!eventName || !forwardAllowlist.has(eventName)) {
      return null;
    }
    const tenantId = String(message?.tenantId || message?.envelope?.tenantId || '').trim();
    if (!tenantId) return null;
    const publishedAt = safeIso(message?.emittedAt, new Date().toISOString());
    const traceId = String(
      message?.correlationId
      || message?.envelope?.correlationId
      || message?.traceId
      || message?.id
      || uuid()
    ).trim();
    const payload = message?.payload && typeof message.payload === 'object'
      ? message.payload
      : {};

    return {
      envelope: '1.0',
      tenantId,
      eventName,
      payload,
      publishedAt,
      sourceSystem: 'u2os',
      traceId: traceId || uuid()
    };
  }

  function forwardBusEvent(message) {
    const envelope = normalizeOutboundEnvelope(message);
    if (!envelope) return;
    let delivered = 0;
    for (const session of sessions.values()) {
      if (session.tenantId !== envelope.tenantId) continue;
      if (sendJson(session.socket, envelope)) {
        delivered += 1;
      }
    }
    status.eventsForwarded += delivered;
  }

  function authenticateRequest(req = {}) {
    const urlObj = new URL(req.url || '/', 'ws://u2os.local');
    const tenantId = String(
      urlObj.searchParams.get('tenantId')
      || req.headers?.['x-tenant-id']
      || ''
    ).trim();
    const providedSecret = String(
      extractBearerToken(req.headers?.authorization)
      || urlObj.searchParams.get('secret')
      || ''
    ).trim();

    if (!tenantId) {
      return { ok: false, error: 'tenantId is required for MindGraph bridge sessions' };
    }
    if (!bridgeConfig.authSecret) {
      return { ok: false, error: 'Bridge auth secret is not configured' };
    }
    if (!providedSecret || providedSecret !== bridgeConfig.authSecret) {
      return { ok: false, error: 'Bridge authentication failed' };
    }
    return { ok: true, tenantId };
  }

  function normalizeInboundEnvelope(session, input) {
    const message = input && typeof input === 'object' && input.event && typeof input.event === 'object'
      ? input.event
      : input;

    if (!message || typeof message !== 'object') {
      throw new Error('MindGraph message must be a JSON object');
    }

    const eventName = String(message.eventName || '').trim();
    if (!eventName) {
      throw new Error('MindGraph message is missing eventName');
    }
    if (!receiveAllowlist.has(eventName)) {
      return null;
    }

    const tenantId = String(message.tenantId || '').trim();
    if (!tenantId || tenantId !== session.tenantId) {
      throw new Error('MindGraph tenant does not match authenticated bridge session');
    }

    const payload = message.payload && typeof message.payload === 'object'
      ? message.payload
      : {};
    const traceId = String(message.traceId || uuid()).trim() || uuid();

    return {
      envelope: '1.0',
      tenantId,
      eventName,
      payload,
      publishedAt: safeIso(message.publishedAt, new Date().toISOString()),
      sourceSystem: 'mindgraph',
      traceId
    };
  }

  async function receiveMindGraphEvent(session, rawData) {
    const parsed = parseInboundPayload(rawData);
    if (!parsed) {
      throw new Error('MindGraph message must be valid JSON');
    }

    const kind = String(parsed.kind || '').trim().toLowerCase();
    if (kind === 'ping') {
      sendJson(session.socket, { kind: 'pong', ts: new Date().toISOString() });
      return;
    }

    const envelope = normalizeInboundEnvelope(session, parsed);
    if (!envelope) return;

    await eventBus.publish(envelope.eventName, envelope.payload, {
      tenantId: envelope.tenantId,
      correlationId: envelope.traceId
    });
    status.eventsReceived += 1;
  }

  function handleConnection(socket, req) {
    const auth = authenticateRequest(req);
    if (!auth.ok) {
      logError(auth.error);
      try {
        socket.close(1008, auth.error);
      } catch {
        // ignore socket close failures
      }
      return;
    }

    const session = {
      id: uuid(),
      tenantId: auth.tenantId,
      socket,
      connectedAt: new Date().toISOString()
    };

    sessions.set(session.id, session);
    updateConnectionStatus();

    sendJson(session.socket, {
      kind: 'bridge.welcome',
      tenantId: session.tenantId,
      connectedAt: session.connectedAt
    });

    socket.on('message', async (rawData) => {
      try {
        await receiveMindGraphEvent(session, rawData);
      } catch (error) {
        logError(error);
      }
    });

    socket.on('close', () => {
      sessions.delete(session.id);
      updateConnectionStatus();
    });

    socket.on('error', (error) => {
      sessions.delete(session.id);
      updateConnectionStatus();
      logError(error);
    });
  }

  function startServer() {
    if (shuttingDown || !started || !bridgeConfig.enabled || wsServer) {
      return;
    }
    try {
      wsServer = wsServerFactory({ port: bridgeConfig.wsPort });
    } catch (error) {
      logError(error);
      scheduleReconnect('failed to start websocket server');
      return;
    }

    if (!wsServer || typeof wsServer.on !== 'function') {
      wsServer = null;
      logError('WebSocket server factory returned an invalid server instance');
      scheduleReconnect('invalid websocket server');
      return;
    }

    wsServer.on('listening', () => {
      reconnectAttempt = 0;
      clearReconnectTimer();
    });

    wsServer.on('connection', (socket, req) => {
      handleConnection(socket, req);
    });

    wsServer.on('error', (error) => {
      logError(error);
      scheduleReconnect('websocket error');
    });

    wsServer.on('close', () => {
      wsServer = null;
      closeAllSessions();
      if (!shuttingDown) {
        scheduleReconnect('websocket closed');
      }
    });
  }

  function start() {
    if (started) return bridgeApi;
    started = true;
    shuttingDown = false;

    if (!bridgeConfig.enabled) {
      return bridgeApi;
    }

    if (!bridgeConfig.authSecret) {
      logError('MINDGRAPH_BRIDGE_SECRET is required when bridge is enabled');
      return bridgeApi;
    }

    unsubscribeBus = eventBus.subscribe('*', (message) => {
      try {
        forwardBusEvent(message);
      } catch (error) {
        logError(error);
      }
    });

    startServer();
    return bridgeApi;
  }

  async function close() {
    shuttingDown = true;
    clearReconnectTimer();

    if (unsubscribeBus) {
      try {
        unsubscribeBus();
      } catch (error) {
        logError(error);
      }
      unsubscribeBus = null;
    }

    closeAllSessions();

    if (wsServer && typeof wsServer.close === 'function') {
      const serverRef = wsServer;
      wsServer = null;
      await new Promise((resolve) => {
        try {
          serverRef.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    started = false;
    status.connected = false;
    status.connectedAt = null;
  }

  function getStatus() {
    return { ...status };
  }

  function getConfig() {
    return {
      enabled: Boolean(bridgeConfig.enabled),
      wsPort: bridgeConfig.wsPort,
      authSecretConfigured: Boolean(bridgeConfig.authSecret),
      forwardAllowlist: Array.from(forwardAllowlist),
      receiveAllowlist: Array.from(receiveAllowlist)
    };
  }

  const bridgeApi = {
    start,
    close,
    getStatus,
    getConfig
  };

  return bridgeApi;
}

module.exports = {
  createMindGraphBridge
};
