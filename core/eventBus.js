const { uuid } = require('./utils');

const ACTION_TOKENS = new Set([
  'created',
  'updated',
  'deleted',
  'booked',
  'scheduled',
  'started',
  'completed',
  'failed',
  'requested',
  'cancelled',
  'received',
  'saved',
  'loaded'
]);

function normalizeTenantKey(tenantId) {
  return String(tenantId || '').trim() || '__global__';
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function deriveEventEntity(eventType, payload, options = {}) {
  const explicit = String(options.entity || payload.entity || '').trim();
  if (explicit) return explicit;

  const parts = String(eventType || '')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) {
    return ACTION_TOKENS.has(parts[1]) ? parts[0] : parts[1];
  }
  if (!ACTION_TOKENS.has(parts[1])) {
    return parts[1];
  }
  return parts[0];
}

class EventBus {
  constructor({ persistEvent, resolveContext, schemaVersion = 'v1', replayLimit = 1000 } = {}) {
    this.handlers = new Map();
    this.persistEvent = persistEvent;
    this.resolveContext = typeof resolveContext === 'function' ? resolveContext : (() => null);
    this.schemaVersion = schemaVersion;
    this.replayLimit = normalizePositiveInt(replayLimit, 1000);
    this.sequenceByTenant = new Map();
    this.recentByTenant = new Map();
  }

  subscribe(eventName, handler) {
    const current = this.handlers.get(eventName) || [];
    current.push(handler);
    this.handlers.set(eventName, current);

    return () => {
      const remaining = (this.handlers.get(eventName) || []).filter((h) => h !== handler);
      this.handlers.set(eventName, remaining);
    };
  }

  getCurrentSequence(tenantId = null) {
    const tenantKey = normalizeTenantKey(tenantId);
    return this.sequenceByTenant.get(tenantKey) || 0;
  }

  listSince({ tenantId = null, afterSequence = 0, limit = 100 } = {}) {
    const tenantKey = normalizeTenantKey(tenantId);
    const items = this.recentByTenant.get(tenantKey) || [];
    const after = Number.isFinite(Number(afterSequence)) ? Number(afterSequence) : 0;
    const boundedLimit = normalizePositiveInt(limit, 100);
    return items
      .filter((item) => Number(item.sequence || 0) > after)
      .slice(0, boundedLimit);
  }

  nextSequenceForTenant(tenantId = null) {
    const tenantKey = normalizeTenantKey(tenantId);
    const next = (this.sequenceByTenant.get(tenantKey) || 0) + 1;
    this.sequenceByTenant.set(tenantKey, next);
    return next;
  }

  pushRecentEvent(envelope) {
    const tenantKey = normalizeTenantKey(envelope.tenantId);
    const current = this.recentByTenant.get(tenantKey) || [];
    current.push(envelope);
    if (current.length > this.replayLimit) {
      current.splice(0, current.length - this.replayLimit);
    }
    this.recentByTenant.set(tenantKey, current);
  }

  buildEnvelope(eventName, payload = {}, options = {}) {
    const context = this.resolveContext() || {};
    const type = String(eventName || '').trim();
    const ts = new Date().toISOString();
    const tenantId = String(
      options.tenantId
      || context.tenantId
      || (context.instance && context.instance.id)
      || ''
    ).trim() || null;
    const actorId = String(
      options.actorId
      || context.userId
      || (context.auth && context.auth.userId)
      || ''
    ).trim() || null;
    const correlationId = String(
      options.correlationId
      || context.traceId
      || context.requestId
      || ''
    ).trim() || null;
    const boundedContext = String(options.boundedContext || options.context || type.split('.')[0] || '').trim() || null;
    const entity = deriveEventEntity(type, payload, options);
    const sequence = this.nextSequenceForTenant(tenantId);

    return {
      id: String(options.id || uuid()),
      type,
      version: String(options.version || this.schemaVersion || 'v1'),
      ts,
      sequence,
      tenantId,
      actorId,
      correlationId,
      context: boundedContext,
      entity,
      payload: payload && typeof payload === 'object' ? payload : {}
    };
  }

  async publish(eventName, payload = {}, options = {}) {
    const envelope = this.buildEnvelope(eventName, payload, options);

    if (this.persistEvent) {
      await this.persistEvent(eventName, payload, envelope);
    }

    this.pushRecentEvent(envelope);

    const exact = this.handlers.get(eventName) || [];
    const wildcard = this.handlers.get('*') || [];
    const handlers = [...exact, ...wildcard];

    const message = {
      eventName,
      payload: envelope.payload,
      emittedAt: envelope.ts,
      envelope,
      id: envelope.id,
      type: envelope.type,
      version: envelope.version,
      sequence: envelope.sequence,
      tenantId: envelope.tenantId,
      actorId: envelope.actorId,
      correlationId: envelope.correlationId,
      context: envelope.context,
      entity: envelope.entity
    };

    await Promise.all(
      handlers.map(async (handler) => {
        try {
          await handler(message);
        } catch (error) {
          console.error(`[eventBus] handler failed for ${eventName}:`, error.message);
        }
      })
    );

    return envelope;
  }
}

module.exports = EventBus;
