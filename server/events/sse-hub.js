/**
 * SseHub: tracks connected HTTP responses kept open as an SSE stream and
 * writes every bus event to them as `event: <type>\ndata: <json>\n\n`.
 * Subscribes to '*' at construction, per docs/architecture.md.
 */
import { listEventsAfterId } from './log.js';

export class SseHub {
  constructor(eventBus) {
    this.db = eventBus.db;
    this.clients = new Set();
    eventBus.subscribe('*', (event) => this.broadcast(event));
  }

  /** Called by GET /api/events/stream. */
  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n:connected\n\n');
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      for (const event of listEventsAfterId(this.db, lastEventId)) res.write(formatEvent(event));
    }
    this.clients.add(res);

    const heartbeat = setInterval(() => {
      try { res.write(':heartbeat\n\n'); } catch { cleanup(); }
    }, 25000);
    heartbeat.unref?.();

    const cleanup = () => { clearInterval(heartbeat); this.clients.delete(res); };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  broadcast(event) {
    if (this.clients.size === 0) return;
    const payload = formatEvent(event);
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  get clientCount() {
    return this.clients.size;
  }
}

function formatEvent(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
