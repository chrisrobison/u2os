// WebSocketDeviceAdapter -- Phase 3 (docs/devices.md): the realtime device
// bus. Any process that can speak WebSocket + this small JSON protocol
// (a future satellite, a Pi, eventually the browser client of Phase 4) can
// register itself as a device and stay live-connected, without U2OS
// knowing anything protocol-specific about what it actually is -- exactly
// the same normalization role every other DeviceAdapter plays, just over a
// persistent connection instead of one-shot discover()/invoke() calls.
//
// Transport: attaches to the SAME http.Server U2OS already runs (no new
// port) via the 'upgrade' event -- server/index.js routes upgrades whose
// path is /ws/devices to handleUpgrade() below. Uses the `ws` package
// (server/devices/realtime/device-token.js's header comment and this
// file's own note: there is no zero-dependency way to speak WebSocket
// server-side in Node; same narrowly-scoped, accepted-exception posture as
// bonjour-service for mDNS).
//
// Protocol (JSON text frames), device -> server:
//   {type:'hello', device: {id,name,type,owner?,location?,capabilities,metadata?}}
//   {type:'event', event: {type, data?, subject?}}
//   {type:'heartbeat'}
//   {type:'subscribe', pattern}
//   {type:'command_result', requestId, result}
//   {type:'command_error', requestId, error}
// server -> device:
//   {type:'hello_ack', deviceId}
//   {type:'command', requestId, capability, args}
//   {type:'event', event}
//   {type:'error', message}
//
// Commands/events/streams stay distinct per docs/devices.md: this module
// carries commands (invoke() below) and events (hello/event/subscribe)
// only -- there is no bulk/media payload path here, by design.
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { DeviceAdapter } from '../device-adapter.js';
import { log } from '../../logging/logger.js';

const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

export class WebSocketDeviceAdapter extends DeviceAdapter {
  constructor({ connectToken, heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    super();
    if (!connectToken) throw new Error('WebSocketDeviceAdapter requires a connectToken');
    this.connectToken = connectToken;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this._connections = new Map(); // deviceId -> ws
    this._pending = new Map(); // requestId -> { resolve, reject, timer }
  }

  get id() {
    return 'websocket';
  }

  async start({ emit, registry, eventBus }) {
    this._emit = emit;
    this._registry = registry;
    this._eventBus = eventBus;
    this._wss = new WebSocketServer({ noServer: true });
    this._heartbeatTimer = setInterval(() => this._pingAll(), this.heartbeatIntervalMs);
    this._heartbeatTimer.unref?.();
  }

  async stop() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    for (const { timer, reject } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('WebSocketDeviceAdapter is stopping'));
    }
    this._pending.clear();
    for (const ws of this._connections.values()) {
      try {
        ws.terminate();
      } catch {
        // best-effort
      }
    }
    this._connections.clear();
    this._wss?.close();
  }

  /** Currently-connected devices (no re-discovery step needed -- a device
   * either has an open connection right now or it doesn't). */
  async getDevices() {
    return [...this._connections.keys()].map((id) => this._registry.getDevice(id)).filter(Boolean);
  }

  /** Sends `capability`/`args` as a command over `device`'s live
   * connection and resolves with the device's result, or rejects on
   * command_error / timeout / not-connected. This is the "device
   * commands" half of the realtime bus -- request/response, over the
   * SAME connection the device is already holding open, never a new
   * one. */
  async invoke(device, capability, args) {
    const ws = this._connections.get(device.id);
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error(`Device "${device.id}" is not connected`);
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error(`Command "${capability}" to device "${device.id}" timed out`));
      }, this.commandTimeoutMs);
      this._pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'command', requestId, capability, args }));
    });
  }

  /** Phase 7 (docs/devices.md): force-disconnects `deviceId`'s live
   * connection, if it has one right now. Called by
   * DeviceRegistry.setTrust() immediately after a revocation. `terminate()`
   * (not the graceful `close()`) triggers the normal `_onClose()` cleanup
   * path (subscriptions torn down, status set offline) without waiting on
   * a close handshake a possibly-compromised/unresponsive client might
   * never complete. */
  async disconnect(deviceId) {
    const ws = this._connections.get(deviceId);
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // best-effort
      }
    }
  }

  /** Called by server/index.js's http 'upgrade' handler for requests to
   * /ws/devices. Rejects (closes the raw socket, never completing the WS
   * handshake) unless the connect token matches -- see
   * server/devices/realtime/device-token.js for what this token is and
   * isn't. */
  handleUpgrade(req, socket, head) {
    let token;
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('token');
    } catch {
      token = null;
    }
    if (token !== this.connectToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this._wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws));
  }

  // --- connection handling -------------------------------------------------

  _onConnection(ws) {
    ws.isAlive = true;
    ws.deviceId = null;
    ws.unsubscribes = [];

    ws.on('pong', () => {
      ws.isAlive = true;
      if (ws.deviceId) this._registry.touch(ws.deviceId);
    });
    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('close', () => this._onClose(ws));
    // A stream with no listener that later errors would otherwise crash
    // the process (default EventEmitter behavior) -- 'close' still fires
    // right after, so cleanup happens there either way.
    ws.on('error', (err) => {
      log.warn('websocket-device-adapter', 'connection error', { deviceId: ws.deviceId, error: err?.message || String(err) });
    });
  }

  _onClose(ws) {
    for (const unsubscribe of ws.unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // best-effort
      }
    }
    ws.unsubscribes = [];
    if (!ws.deviceId) return;
    if (this._connections.get(ws.deviceId) === ws) {
      this._connections.delete(ws.deviceId);
      try {
        this._registry.setStatus(ws.deviceId, 'offline');
      } catch {
        // device may already have been removed -- disconnect is still handled
      }
    }
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return this._sendError(ws, 'invalid JSON');
    }
    switch (msg?.type) {
      case 'hello':
        return this._handleHello(ws, msg);
      case 'event':
        return this._handleEvent(ws, msg);
      case 'heartbeat':
        return this._handleHeartbeat(ws);
      case 'subscribe':
        return this._handleSubscribe(ws, msg);
      case 'command_result':
        return this._handleCommandResult(msg.requestId, null, msg.result);
      case 'command_error':
        return this._handleCommandResult(msg.requestId, msg.error || 'command failed', null);
      default:
        return this._sendError(ws, `unknown message type "${msg?.type}"`);
    }
  }

  _handleHello(ws, msg) {
    const device = msg.device;
    if (!device || typeof device.id !== 'string' || !device.id || !device.name || !device.type) {
      return this._sendError(ws, 'hello requires device.{id,name,type}');
    }
    // A new connection claiming an id an existing OPEN connection is still
    // using: the new connection wins (e.g. the device reconnected before
    // the server noticed the old socket was dead) -- terminate the stale
    // one rather than silently ignoring the new hello.
    const stale = this._connections.get(device.id);
    if (stale && stale !== ws) {
      try {
        stale.terminate();
      } catch {
        // best-effort
      }
    }

    const isNewDevice = !this._registry.getDevice(device.id);

    let record;
    try {
      record = this._registry.upsertDevice(this.id, { ...device, status: 'online' });
    } catch (err) {
      return this._sendError(ws, err.message);
    }

    if (isNewDevice) {
      this._emit({
        type: 'device.pairing_requested',
        source: `device:${record.id}`,
        subject: { type: 'device', id: record.id },
        data: { deviceId: record.id, name: record.name, deviceType: record.type },
      });
    }

    ws.deviceId = record.id;
    this._connections.set(record.id, ws);
    ws.send(JSON.stringify({ type: 'hello_ack', deviceId: record.id }));
  }

  _handleEvent(ws, msg) {
    if (!ws.deviceId) return this._sendError(ws, 'must hello before sending events');
    // Phase 7: a device revoked after hello (or racing hello -- e.g. this
    // exact device id was just revoked on a prior connection and this is
    // a stale in-flight message) must never get another event onto the
    // shared bus. setTrust('revoked') also force-disconnects the live
    // connection (see DeviceRegistry.setTrust()), but that happens
    // asynchronously -- this check closes the race regardless of timing.
    const registered = this._registry.getDevice(ws.deviceId);
    if (!registered || registered.trust === 'revoked') {
      return this._sendError(ws, 'device is revoked; events are not accepted');
    }
    const event = msg.event;
    if (!event || typeof event.type !== 'string' || !event.type) {
      return this._sendError(ws, 'event requires event.type');
    }
    this._emit({
      type: event.type,
      source: `device:${ws.deviceId}`,
      subject: event.subject || { type: 'device', id: ws.deviceId },
      data: event.data || {},
    });
  }

  _handleHeartbeat(ws) {
    if (ws.deviceId) this._registry.touch(ws.deviceId);
  }

  _handleSubscribe(ws, msg) {
    if (!ws.deviceId) return this._sendError(ws, 'must hello before subscribing');
    if (typeof msg.pattern !== 'string' || !msg.pattern) {
      return this._sendError(ws, 'subscribe requires a string pattern');
    }
    const unsubscribe = this._eventBus.subscribe(msg.pattern, (event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'event', event: serializeEvent(event) }));
    });
    ws.unsubscribes.push(unsubscribe);
  }

  _handleCommandResult(requestId, error, result) {
    const pending = this._pending.get(requestId);
    if (!pending) return; // unknown/already-timed-out request -- ignore, not an error
    clearTimeout(pending.timer);
    this._pending.delete(requestId);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result);
  }

  _pingAll() {
    for (const ws of this._connections.values()) {
      if (ws.isAlive === false) {
        ws.terminate(); // triggers 'close' -> _onClose() marks the device offline
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // best-effort; a failed ping will simply not be pong'd, caught next tick
      }
    }
  }

  _sendError(ws, message) {
    try {
      ws.send(JSON.stringify({ type: 'error', message }));
    } catch {
      // best-effort -- the socket may already be closing
    }
  }
}

function serializeEvent(event) {
  // Send the same fields a REST caller would see (GET /api/events),
  // nothing internal-only.
  const { id, type, source, timestamp, actor, subject, data, correlationId, causationId } = event;
  return { id, type, source, timestamp, actor, subject, data, correlationId, causationId };
}
