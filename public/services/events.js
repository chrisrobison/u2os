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
    this._lastEventId = null;
    this._seenEventIds = new Set();
    this._seenEventOrder = [];
    this._state = null;
    this._setState('connecting');
    this._run();
  }

  async _run() {
    while (!this._closed) {
      this._controller = new AbortController();
      try {
        const res = await fetch(this.url, {
          signal: this._controller.signal,
          headers: { Accept: 'text/event-stream' },
          ...(this._lastEventId ? { headers: { Accept: 'text/event-stream', 'Last-Event-ID': this._lastEventId } } : {}),
        });
        if (res.status === 401) {
          this._setState('session-expired');
          this._closed = true;
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
        }
        this._retryDelay = 1000;
        this._setState('connected');
        await this._pump(res.body);
      } catch (err) {
        if (this._closed) return;
        console.error('[u2 events] stream error, will retry', err);
      }
      if (this._closed) return;
      this._setState('reconnecting');
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
    let id = null;
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // comment, e.g. ":connected"
      if (line.startsWith('data:')) data += line.slice(5).trim();
      if (line.startsWith('id:')) id = line.slice(3).trim();
    }
    if (!data) return;
    try {
      const parsed = JSON.parse(data);
      if (id) this._lastEventId = id;
      if (id && this._seenEventIds.has(id)) return;
      if (id) this._rememberEventId(id);
      window.dispatchEvent(new CustomEvent('u2-event', { detail: parsed }));
    } catch (err) {
      console.error('[u2 events] failed to parse SSE frame', err, frame);
    }
  }

  _rememberEventId(id) {
    this._seenEventIds.add(id);
    this._seenEventOrder.push(id);
    if (this._seenEventOrder.length > 512) {
      this._seenEventIds.delete(this._seenEventOrder.shift());
    }
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    window.dispatchEvent(new CustomEvent('u2-connection-state', { detail: { state } }));
  }

  close() {
    this._closed = true;
    this._controller?.abort();
  }
}
