// DeviceClientService -- Phase 4 (docs/devices.md): turns this browser tab
// into a registered U2OS device over the realtime bus
// (server/devices/adapters/websocket-device-adapter.js), so an agent can
// present/notify/prompt this specific browser through the same
// capability/device model every other endpoint uses -- never a privileged
// special case.
//
// Advertises ONLY capabilities this page can actually honor without asking
// for any browser permission up front (ui.render/ui.notify/ui.prompt/
// audio.play) -- per docs/devices.md/PROMPT.md's "do not request every
// browser permission at startup" rule. Capabilities that need a permission
// (camera.capture, audio.capture/geolocation.read) are deliberately not
// advertised by this phase; adding them is a later, explicit opt-in, not a
// silent capability-list change.
//
// Reconnects with the same exponential-backoff shape as EventsService
// (services/events.js) for consistency, and reuses this tab's persisted
// device id across reloads (services/api.js/localStorage) so the server
// sees "the same device reconnecting", not a new device every page load.
import * as api from './api.js';

const DEVICE_ID_KEY = 'u2-device-id';
const HEARTBEAT_MS = 20000;

// SECURITY / KNOWN GAP (docs/devices.md): U2OS is currently single-owner
// with no formal mapping from "the authenticated session" to a device
// `owner` string. This sentinel is a deliberate stand-in for "the one
// owner of this instance" so this device is resolvable for
// private/sensitive-tier content (server/devices/capability-resolver.js's
// ownership rule) without yet wiring real per-user identity through.
const OWNER_SENTINEL = 'owner';

function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `browser.${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage disabled -- fall back to a per-load id; this
    // tab will simply look like a new device on every reload.
    return `browser.${crypto.randomUUID()}`;
  }
}

function deviceName() {
  const ua = navigator.userAgent || '';
  const browser = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${browser} (${navigator.platform || 'web'})`;
}

export class DeviceClientService extends EventTarget {
  constructor() {
    super();
    this.deviceId = getOrCreateDeviceId();
    this._closed = false;
    this._ws = null;
    this._heartbeatTimer = null;
    this._retryDelay = 1000;
    this._connect();
  }

  async _connect() {
    if (this._closed) return;
    let token;
    try {
      ({ token } = await api.getDeviceConnectToken());
    } catch (err) {
      console.error('[u2 device] could not fetch connect token, will retry', err);
      return this._scheduleRetry();
    }
    if (this._closed) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/devices?token=${encodeURIComponent(token)}`);
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._retryDelay = 1000;
      ws.send(
        JSON.stringify({
          type: 'hello',
          device: {
            id: this.deviceId,
            name: deviceName(),
            type: 'browser',
            owner: OWNER_SENTINEL,
            capabilities: ['ui.render', 'ui.notify', 'ui.prompt', 'audio.play'],
            metadata: {
              display: { text: true, cards: true, html: false, images: true, video: false },
              input: { text: true, touch: 'ontouchstart' in window },
              userAgent: navigator.userAgent,
            },
          },
        })
      );
      this._heartbeatTimer = setInterval(() => this._send({ type: 'heartbeat' }), HEARTBEAT_MS);
      this.dispatchEvent(new CustomEvent('connected'));
    });

    ws.addEventListener('message', (event) => this._onMessage(event));
    ws.addEventListener('close', () => this._onClose());
    ws.addEventListener('error', () => {
      /* 'close' always follows; cleanup happens there */
    });
  }

  _onClose() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._ws = null;
    this.dispatchEvent(new CustomEvent('disconnected'));
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._closed) return;
    setTimeout(() => this._connect(), this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, 15000);
  }

  async _onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type !== 'command') return; // 'hello_ack'/'error'/'event' -- nothing to act on yet

    const { requestId, capability, args } = msg;
    try {
      const result = await this._handleCommand(capability, args || {});
      this._send({ type: 'command_result', requestId, result });
    } catch (err) {
      this._send({ type: 'command_error', requestId, error: err.message || String(err) });
    }
  }

  // Dispatches a CustomEvent per capability rather than rendering anything
  // itself -- server/public/components/u2-device-panel.js owns the actual
  // DOM, keeping this module a pure protocol/service layer (same split as
  // EventsService dispatching 'u2-event' for components to render).
  async _handleCommand(capability, args) {
    switch (capability) {
      case 'ui.render':
        this.dispatchEvent(new CustomEvent('present', { detail: { content: args.content ?? null } }));
        return { delivered: true };
      case 'ui.notify':
        this.dispatchEvent(new CustomEvent('notify', { detail: { title: args.title ?? '', body: args.body ?? '' } }));
        return { delivered: true };
      case 'ui.prompt':
        return { answer: await this._prompt(args.question ?? '') };
      case 'audio.play':
        if (args.url) {
          try {
            await new Audio(args.url).play();
          } catch (err) {
            throw new Error(`playback failed: ${err.message}`);
          }
        }
        return { played: true };
      default:
        throw new Error(`this browser device does not implement capability "${capability}"`);
    }
  }

  _prompt(question) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const onResponse = (event) => {
        if (event.detail.requestId !== requestId) return;
        this.removeEventListener('prompt-response', onResponse);
        resolve(event.detail.answer);
      };
      this.addEventListener('prompt-response', onResponse);
      this.dispatchEvent(new CustomEvent('prompt', { detail: { requestId, question } }));
    });
  }

  /** Called by the UI (u2-device-panel.js) with the user's answer to a
   * pending 'prompt' event's requestId. */
  respondToPrompt(requestId, answer) {
    this.dispatchEvent(new CustomEvent('prompt-response', { detail: { requestId, answer } }));
  }

  _send(message) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(message));
    }
  }

  close() {
    this._closed = true;
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._ws?.close();
  }
}
