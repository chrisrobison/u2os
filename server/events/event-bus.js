import { newId } from '../db/ids.js';

/**
 * EventBus: in-process pub/sub with a durable log behind it. Every publish()
 * assigns an id/timestamp, persists the row to the events table (append-only),
 * and dispatches synchronously to matching subscribers (including the SSE
 * hub, which subscribes to '*' at construction).
 */
export class EventBus {
  constructor(db) {
    this.db = db;
    this.subscribers = [];
    this._insertStmt = db.prepare(`INSERT INTO events (
      id, type, timestamp, source, actor_type, actor_id, subject_type, subject_id,
      data, metadata, correlation_id, causation_id, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  }

  /**
   * pattern: exact type ('calendar.event_changed'), a domain prefix
   * ('calendar.*'), or '*' for everything. Returns an unsubscribe function.
   */
  subscribe(pattern, handler) {
    const entry = { pattern, handler };
    this.subscribers.push(entry);
    return () => {
      const idx = this.subscribers.indexOf(entry);
      if (idx !== -1) this.subscribers.splice(idx, 1);
    };
  }

  publish(partial) {
    if (!partial || !partial.type) {
      throw new Error('EventBus.publish requires at least a "type"');
    }

    const id = newId('evt');
    const timestamp = partial.timestamp || new Date().toISOString();
    const createdAt = new Date().toISOString();
    const source = partial.source || 'system';
    const actor = partial.actor || null;
    const subject = partial.subject || null;
    const data = partial.data || {};
    const metadata = partial.metadata || {};
    const correlationId = partial.correlationId ?? metadata.correlationId ?? null;
    const causationId = partial.causationId ?? metadata.causationId ?? null;

    this._insertStmt.run(
      id,
      partial.type,
      timestamp,
      source,
      actor?.type ?? null,
      actor?.id ?? null,
      subject?.type ?? null,
      subject?.id ?? null,
      JSON.stringify(data),
      JSON.stringify(metadata),
      correlationId,
      causationId,
      createdAt
    );

    const event = {
      id,
      type: partial.type,
      timestamp,
      source,
      actor,
      subject,
      data,
      metadata,
      correlationId,
      causationId,
      createdAt,
    };

    this._dispatch(event);
    return event;
  }

  _dispatch(event) {
    // Snapshot the subscriber list: a handler that subscribes/unsubscribes
    // during dispatch (e.g. a one-shot listener) must not corrupt this pass.
    for (const { pattern, handler } of [...this.subscribers]) {
      if (!matchesPattern(pattern, event.type)) continue;
      try {
        handler(event);
      } catch (err) {
        console.error(`[event-bus] subscriber for pattern "${pattern}" threw`, err);
      }
    }
  }
}

function matchesPattern(pattern, type) {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}
