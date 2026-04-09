const { URL } = require('url');
const { WebSocket, WebSocketServer } = require('ws');
const { verifyJwt } = require('./auth/jwt');
const { createAuthStore } = require('./auth/store');
const { normalizeRole } = require('./auth/roles');
const { uuid } = require('./utils');

function extractBearerToken(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSequence(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeTopicInput(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeTopics(rawTopics, maxSubscriptions = 32) {
  const topics = [];
  const seen = new Set();
  for (const raw of normalizeTopicInput(rawTopics)) {
    const topic = String(raw || '').trim().toLowerCase();
    if (!topic) continue;

    if (topic === '*') {
      if (!seen.has(topic)) {
        topics.push(topic);
        seen.add(topic);
      }
      if (topics.length >= maxSubscriptions) break;
      continue;
    }

    if (topic.startsWith('context:') || topic.startsWith('entity:')) {
      const [kind, value] = topic.split(':');
      if (!value || !/^[a-z0-9._-]+$/.test(value)) {
        continue;
      }
      const normalized = `${kind}:${value}`;
      if (!seen.has(normalized)) {
        topics.push(normalized);
        seen.add(normalized);
      }
      if (topics.length >= maxSubscriptions) break;
      continue;
    }

    if (topic.endsWith('.*')) {
      const prefix = topic.slice(0, -2);
      if (!prefix || !/^[a-z0-9._-]+$/.test(prefix)) {
        continue;
      }
      const normalized = `${prefix}.*`;
      if (!seen.has(normalized)) {
        topics.push(normalized);
        seen.add(normalized);
      }
      if (topics.length >= maxSubscriptions) break;
      continue;
    }

    if (!/^[a-z0-9._-]+$/.test(topic)) {
      continue;
    }
    if (!seen.has(topic)) {
      topics.push(topic);
      seen.add(topic);
    }
    if (topics.length >= maxSubscriptions) break;
  }
  return topics;
}

function topicMatchesEnvelope(topic, envelope) {
  const normalizedTopic = String(topic || '').trim().toLowerCase();
  if (!normalizedTopic) return false;

  const eventType = String(envelope.type || '').trim().toLowerCase();
  const context = String(envelope.context || '').trim().toLowerCase();
  const entity = String(envelope.entity || '').trim().toLowerCase();

  if (normalizedTopic === '*') return true;
  if (normalizedTopic.startsWith('context:')) {
    return context === normalizedTopic.slice('context:'.length);
  }
  if (normalizedTopic.startsWith('entity:')) {
    return entity === normalizedTopic.slice('entity:'.length);
  }
  if (normalizedTopic.endsWith('.*')) {
    const prefix = normalizedTopic.slice(0, -2);
    return eventType === prefix || eventType.startsWith(`${prefix}.`);
  }
  return eventType === normalizedTopic;
}

function socketIsOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function sendJson(socket, payload) {
  if (!socketIsOpen(socket)) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function writeUpgradeError(socket, statusCode, message) {
  const code = Number(statusCode) || 401;
  const reason = String(message || 'Unauthorized');
  socket.write(
    `HTTP/1.1 ${code} ${reason}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: application/json\r\n\r\n'
    + `${JSON.stringify({ error: reason })}`
  );
  socket.destroy();
}

function defaultCanReceive(session, envelope) {
  if (!session || !envelope) return false;
  if (session.tenantId && envelope.tenantId && session.tenantId !== envelope.tenantId) {
    return false;
  }
  return true;
}

function createRealtimeGateway({
  server,
  eventBus,
  authConfig,
  path = '/ws/events',
  replayLimit = 200,
  maxSubscriptions = 32,
  resolveTenantForSocket,
  canReceiveEvent
}) {
  if (!server) throw new Error('createRealtimeGateway requires an HTTP server');
  if (!eventBus) throw new Error('createRealtimeGateway requires an eventBus instance');
  if (!authConfig || !authConfig.jwtSecret) throw new Error('createRealtimeGateway requires authConfig.jwtSecret');
  if (typeof resolveTenantForSocket !== 'function') {
    throw new Error('createRealtimeGateway requires resolveTenantForSocket(req, tokenPayload, urlObj)');
  }

  const wsServer = new WebSocketServer({ noServer: true });
  const sessions = new Set();
  const maxTopics = normalizePositiveInt(maxSubscriptions, 32);
  const replayMax = normalizePositiveInt(replayLimit, 200);

  function canDeliverToSession(session, envelope) {
    if (!defaultCanReceive(session, envelope)) return false;
    if (typeof canReceiveEvent === 'function' && !canReceiveEvent(session, envelope)) {
      return false;
    }
    if (!session.topics || session.topics.size === 0) {
      return false;
    }
    for (const topic of session.topics) {
      if (topicMatchesEnvelope(topic, envelope)) {
        return true;
      }
    }
    return false;
  }

  function replayToSession(session, afterSequence) {
    const after = Number.isFinite(Number(afterSequence)) ? Number(afterSequence) : 0;
    const replay = eventBus.listSince({
      tenantId: session.tenantId,
      afterSequence: after,
      limit: replayMax
    }).filter((envelope) => canDeliverToSession(session, envelope));

    if (replay.length > 0) {
      session.lastSequence = replay[replay.length - 1].sequence;
      sendJson(session.socket, {
        kind: 'replay',
        requestedAfterSequence: after,
        delivered: replay.length,
        events: replay
      });
    } else {
      sendJson(session.socket, {
        kind: 'replay',
        requestedAfterSequence: after,
        delivered: 0,
        events: []
      });
    }
  }

  function handleClientMessage(session, rawData) {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch {
      sendJson(session.socket, { kind: 'error', error: 'Invalid realtime message JSON' });
      return;
    }

    const kind = String(message.kind || '').trim().toLowerCase();
    if (!kind) {
      sendJson(session.socket, { kind: 'error', error: 'Realtime message kind is required' });
      return;
    }

    if (kind === 'ping') {
      sendJson(session.socket, { kind: 'pong', ts: new Date().toISOString() });
      return;
    }

    if (kind === 'subscribe') {
      const topics = normalizeTopics(message.topics, maxTopics);
      if (topics.length === 0) {
        sendJson(session.socket, { kind: 'error', error: 'No valid topics provided' });
        return;
      }

      if (message.replace === true) {
        session.topics.clear();
      }

      for (const topic of topics) {
        if (session.topics.size >= maxTopics && !session.topics.has(topic)) {
          break;
        }
        session.topics.add(topic);
      }

      sendJson(session.socket, {
        kind: 'subscribed',
        topics: Array.from(session.topics),
        sequence: eventBus.getCurrentSequence(session.tenantId)
      });

      const replaySince = parseSequence(message.since);
      if (replaySince != null) {
        replayToSession(session, replaySince);
      }
      return;
    }

    if (kind === 'unsubscribe') {
      const topics = normalizeTopics(message.topics, maxTopics);
      if (topics.length === 0) {
        sendJson(session.socket, { kind: 'error', error: 'No valid topics provided' });
        return;
      }

      for (const topic of topics) {
        session.topics.delete(topic);
      }

      sendJson(session.socket, {
        kind: 'unsubscribed',
        topics: Array.from(session.topics),
        sequence: eventBus.getCurrentSequence(session.tenantId)
      });
      return;
    }

    if (kind === 'sync') {
      const replaySince = parseSequence(message.since);
      if (replaySince == null) {
        sendJson(session.socket, { kind: 'error', error: 'sync requires numeric since' });
        return;
      }
      replayToSession(session, replaySince);
      return;
    }

    sendJson(session.socket, { kind: 'error', error: `Unknown realtime message kind '${kind}'` });
  }

  async function authenticateConnection(req) {
    const urlObj = new URL(req.url || '/', 'http://u2os.local');
    const tokenFromHeader = extractBearerToken(req.headers.authorization);
    const token = String(urlObj.searchParams.get('token') || tokenFromHeader || '').trim();
    if (!token) {
      const error = new Error('Authentication token is required');
      error.statusCode = 401;
      throw error;
    }

    let tokenPayload;
    try {
      tokenPayload = verifyJwt(token, authConfig.jwtSecret);
    } catch {
      const error = new Error('Invalid or expired token');
      error.statusCode = 401;
      throw error;
    }

    if (tokenPayload.scope === 'admin-control') {
      const error = new Error('Admin control-plane tokens are not valid for realtime user streams');
      error.statusCode = 403;
      throw error;
    }

    const userId = String(tokenPayload.sub || '').trim();
    if (!userId) {
      const error = new Error('Token subject is required');
      error.statusCode = 401;
      throw error;
    }

    const tenant = await resolveTenantForSocket(req, tokenPayload, urlObj);
    if (!tenant || !tenant.instance || !tenant.db) {
      const error = new Error('Unable to resolve tenant for realtime connection');
      error.statusCode = 401;
      throw error;
    }

    if (tokenPayload.tid && String(tokenPayload.tid) !== String(tenant.instance.id)) {
      const error = new Error('Token tenant does not match connection tenant');
      error.statusCode = 403;
      throw error;
    }

    const authStore = createAuthStore(tenant.db);
    const identity = await authStore.findByUserId(userId, tenant.instance.id);
    if (!identity || String(identity.status || '').toLowerCase() !== 'active') {
      const error = new Error('Authentication required');
      error.statusCode = 401;
      throw error;
    }

    return {
      userId,
      tenantId: tenant.instance.id,
      role: normalizeRole(identity.role, 'viewer'),
      topics: normalizeTopics(urlObj.searchParams.get('topics') || '', maxTopics),
      replaySince: parseSequence(urlObj.searchParams.get('since'))
    };
  }

  function onConnection(socket, _req, authState) {
    const session = {
      id: uuid(),
      socket,
      userId: authState.userId,
      tenantId: authState.tenantId,
      role: authState.role,
      topics: new Set(authState.topics),
      lastSequence: 0,
      connectedAt: new Date().toISOString()
    };
    sessions.add(session);

    sendJson(session.socket, {
      kind: 'realtime.welcome',
      version: 'v1',
      connectionId: session.id,
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
      subscriptions: Array.from(session.topics),
      sequence: eventBus.getCurrentSequence(session.tenantId),
      ts: new Date().toISOString()
    });

    if (authState.replaySince != null) {
      replayToSession(session, authState.replaySince);
    }

    socket.on('message', (raw) => {
      handleClientMessage(session, raw);
    });

    socket.on('close', () => {
      sessions.delete(session);
    });

    socket.on('error', () => {
      sessions.delete(session);
    });
  }

  const unsubscribeBus = eventBus.subscribe('*', ({ envelope }) => {
    if (!envelope) return;
    for (const session of sessions) {
      if (!canDeliverToSession(session, envelope)) {
        continue;
      }
      const sent = sendJson(session.socket, {
        kind: 'event',
        replay: false,
        event: envelope
      });
      if (sent) {
        session.lastSequence = envelope.sequence;
      }
    }
  });

  wsServer.on('connection', onConnection);

  async function onUpgrade(req, socket, head) {
    const urlObj = new URL(req.url || '/', 'http://u2os.local');
    if (urlObj.pathname !== path) {
      return;
    }

    let authState;
    try {
      authState = await authenticateConnection(req);
    } catch (error) {
      writeUpgradeError(socket, error.statusCode || 401, error.message || 'Unauthorized');
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit('connection', ws, req, authState);
    });
  }

  server.on('upgrade', onUpgrade);

  async function close() {
    server.off('upgrade', onUpgrade);
    unsubscribeBus();
    for (const session of sessions) {
      try {
        session.socket.close(1001, 'Server shutdown');
      } catch {
        // ignore
      }
    }
    sessions.clear();
    await new Promise((resolve) => wsServer.close(resolve));
  }

  function stats() {
    return {
      connected: sessions.size,
      path,
      replayLimit: replayMax,
      maxSubscriptions: maxTopics
    };
  }

  return {
    close,
    stats,
    wsServer
  };
}

module.exports = {
  createRealtimeGateway,
  normalizeTopics,
  topicMatchesEnvelope
};
