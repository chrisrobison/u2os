// Live event feed for the U2OS shell.
//
// NOTE on implementation: the confirmed live contract for GET
// /api/events/stream sends every frame with an explicit `event: <type>`
// line (see docs/events.md's taxonomy -- calendar.event_changed,
// task.created, agent.action.proposed, ...). A plain `new
// EventSource(url)` with `.onmessage` only ever fires for frames with *no*
// event name (or `event: message`), so it would silently receive nothing
// from this server. Rather than hardcode a listener per known event type
// (fragile as the taxonomy grows in later phases), this reads the stream
// with fetch + a small manual SSE parser, which handles any event name
// generically. The public surface is the same either way: connect on
// construction, dispatch a `u2-event` CustomEvent per message, log (never
// throw) on connection trouble, and expose `.close()`.
export class EventsService {
  constructor(url = '/api/events/stream') {
    this.url = url;
    this._closed = false;
    this._controller = null;
    this._retryDelay = 1000;
    this._run();
  }

  async _run() {
    while (!this._closed) {
      this._controller = new AbortController();
      try {
        const res = await fetch(this.url, {
          signal: this._controller.signal,
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
        }
        this._retryDelay = 1000;
        await this._pump(res.body);
      } catch (err) {
        if (this._closed) return;
        console.error('[u2 events] stream error, will retry', err);
      }
      if (this._closed) return;
      await new Promise((r) => setTimeout(r, this._retryDelay));
      this._retryDelay = Math.min(this._retryDelay * 2, 15000);
    }
  }

  async _pump(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!this._closed) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        this._dispatchFrame(frame);
      }
    }
  }

  _dispatchFrame(frame) {
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // comment, e.g. ":connected"
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    try {
      const parsed = JSON.parse(data);
      window.dispatchEvent(new CustomEvent('u2-event', { detail: parsed }));
    } catch (err) {
      console.error('[u2 events] failed to parse SSE frame', err, frame);
    }
  }

  close() {
    this._closed = true;
    this._controller?.abort();
  }
}
