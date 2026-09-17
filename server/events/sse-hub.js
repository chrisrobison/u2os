/**
 * SseHub: tracks connected HTTP responses kept open as an SSE stream and
 * writes every bus event to them as `event: <type>\ndata: <json>\n\n`.
 * Subscribes to '*' at construction, per docs/architecture.md.
 */
export class SseHub {
  constructor(eventBus) {
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
    res.write(':connected\n\n');
    this.clients.add(res);

    const cleanup = () => this.clients.delete(res);
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  broadcast(event) {
    if (this.clients.size === 0) return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}
