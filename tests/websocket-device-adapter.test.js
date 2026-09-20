import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { URL } from 'node:url';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { createCapabilityRegistry } from '../server/devices/register-capabilities.js';
import { DeviceRegistry } from '../server/devices/device-registry.js';
import { WebSocketDeviceAdapter } from '../server/devices/adapters/websocket-device-adapter.js';
import { startServer } from '../server/index.js';
import { getOrCreateDeviceConnectToken } from '../server/devices/realtime/device-token.js';

const TOKEN = 'test-connect-token';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-ws-device-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Registers tempHome()/cleanup(dir) via t.after() -- CRITICAL for this
 * file specifically: an assertion that throws partway through a test must
 * never skip closing the harness's real http.Server/WebSocket/adapter
 * timers. t.after() hooks run regardless of pass/fail, in REGISTRATION
 * (FIFO) order -- observed the hard way, twice: (1) manual `ws.terminate();
 * await h.close();` cleanup lines sitting after an assertion get skipped
 * when that assertion throws, leaving a real listening server + open
 * socket dangling; (2) even after moving cleanup into t.after() hooks, this
 * hook (registered first, per call order below) ran BEFORE buildHarness()'s
 * -- since t.after() is FIFO, not LIFO as it's easy to assume -- which
 * doesn't matter for THIS hook (closing the temp dir is order-independent)
 * but does matter for buildHarness()'s own hook: see its comment for how
 * that one avoids depending on running after openSocket()'s. Either way the
 * failure mode is identical: `node --test` hangs indefinitely waiting for
 * the event loop to drain, with every individual test still reporting "ok"
 * -- silent from the test output alone. */
function useTempHome(t) {
  const dir = tempHome();
  t.after(() => cleanup(dir));
  return dir;
}

/** Builds a plain http.Server + DeviceRegistry with a WebSocketDeviceAdapter
 * wired to /ws/devices, the same routing shape server/index.js uses, but
 * without booting the whole U2OS app -- keeps these protocol tests fast and
 * focused, mirroring tests/tool-registry.test.js's "test the component
 * directly" style. Registers its own teardown via t.after() -- see
 * useTempHome()'s comment above for why that matters here specifically. */
async function buildHarness(t, { heartbeatIntervalMs = 60000, commandTimeoutMs = 2000 } = {}) {
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  const adapter = new WebSocketDeviceAdapter({ connectToken: TOKEN, heartbeatIntervalMs, commandTimeoutMs });
  await deviceRegistry.registerAdapter(adapter);

  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ws/devices') adapter.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // CRITICAL (found the hard way -- see the module-level comment above
  // useTempHome()): once a socket is upgraded to WebSocket, Node's
  // http.Server keeps it attached for `server.close()`'s connection-drain
  // bookkeeping even though ownership was handed off to the `ws` library.
  // Awaiting `server.close()`'s callback reliably never resolves in a test
  // context UNLESS every such socket is already fully torn down first --
  // and `t.after()` hook ordering (FIFO, not LIFO) makes that ordering
  // fragile to depend on. `unref()` sidesteps the whole question: an
  // unref'd server never keeps the process alive by itself, so cleanup
  // here can simply fire-and-forget `server.close()` without awaiting its
  // callback at all. Test-only -- server/index.js's real production server
  // must never be unref'd (an idle real server should keep the process
  // alive to keep listening).
  server.unref();

  const close = async () => {
    await deviceRegistry.stopAll();
    server.close();
  };
  t.after(close);

  return {
    db,
    eventBus,
    capabilityRegistry,
    deviceRegistry,
    adapter,
    server,
    wsUrl: (token = TOKEN) => `ws://127.0.0.1:${port}/ws/devices${token ? `?token=${token}` : ''}`,
    close,
  };
}

/** Opens a WebSocket to `url` and registers t.after(() => ws.terminate())
 * -- see useTempHome()'s comment for why every connection in this file
 * must be torn down this way, not via a cleanup line after an assertion. */
function openSocket(t, url) {
  const ws = new WebSocket(url);
  t.after(() => {
    try {
      ws.terminate();
    } catch {
      // already closed
    }
  });
  return ws;
}

function once(ws, event) {
  return new Promise((resolve, reject) => {
    ws.once(event, resolve);
    ws.once('error', reject);
  });
}

async function waitFor(predicate, { timeout = 2000, interval = 15 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor: condition never became true within timeout');
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => {
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// --- connection / auth -------------------------------------------------------

test('connecting with an invalid token is rejected before the WS handshake completes', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl('wrong-token'));
  await assert.rejects(() => once(ws, 'open'));
});

test('connecting with the correct token completes the handshake', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
});

// --- hello / registration ----------------------------------------------------

test('hello registers the device (online) and is acknowledged', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const discovered = [];
  h.eventBus.subscribe('device.discovered', (e) => discovered.push(e));

  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'sat.office', name: 'Office Satellite', type: 'satellite', capabilities: ['audio.listen'] } }));
  const ack = await nextMessage(ws);

  assert.equal(ack.type, 'hello_ack');
  assert.equal(ack.deviceId, 'sat.office');
  const device = h.deviceRegistry.getDevice('sat.office');
  assert.equal(device.status, 'online');
  assert.equal(device.adapter, 'websocket');
  assert.equal(discovered.length, 1);
});

test('hello with a missing required field is rejected with an error message, not registered', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'bad.device' } }));
  const reply = await nextMessage(ws);
  assert.equal(reply.type, 'error');
  assert.equal(h.deviceRegistry.getDevice('bad.device'), null);
});

test('sending a message before hello is rejected', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'event', event: { type: 'motion.detected', data: {} } }));
  const reply = await nextMessage(ws);
  assert.equal(reply.type, 'error');
});

// --- event publication ---------------------------------------------------------

test('an event message from a registered device is published on the shared EventBus', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'cam.hall', name: 'Hall Camera', type: 'camera', capabilities: ['motion.events'] } }));
  await nextMessage(ws);

  const motionEvents = [];
  h.eventBus.subscribe('motion.detected', (e) => motionEvents.push(e));

  ws.send(JSON.stringify({ type: 'event', event: { type: 'motion.detected', data: { confidence: 0.9 } } }));
  await waitFor(() => motionEvents.length === 1);

  assert.equal(motionEvents[0].source, 'device:cam.hall');
  assert.equal(motionEvents[0].data.confidence, 0.9);
});

// --- heartbeats ------------------------------------------------------------

test('heartbeat messages update last_seen_at without publishing extra connect/disconnect/pairing events', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const events = [];
  h.eventBus.subscribe('device.*', (e) => events.push(e.type));

  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'sensor.hall', name: 'Hall Sensor', type: 'sensor', capabilities: ['temperature.read'] } }));
  await nextMessage(ws);

  const before = h.deviceRegistry.getDevice('sensor.hall').last_seen_at;
  await new Promise((r) => setTimeout(r, 20));
  ws.send(JSON.stringify({ type: 'heartbeat' }));
  await waitFor(() => h.deviceRegistry.getDevice('sensor.hall').last_seen_at !== before);

  // The original hello produces device.discovered + device.connected +
  // (Phase 7) device.pairing_requested, since this is a brand-new device --
  // the heartbeat itself must not add anything beyond that.
  assert.deepEqual(events, ['device.discovered', 'device.connected', 'device.pairing_requested']);
});

// --- reconnect / failure conditions --------------------------------------------

test('an abrupt disconnect marks the device offline', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'phone.chris', name: "Chris's Phone", type: 'phone', capabilities: ['ui.notify'] } }));
  await nextMessage(ws);
  assert.equal(h.deviceRegistry.getDevice('phone.chris').status, 'online');

  ws.terminate(); // simulate a dropped connection, not a clean close
  await waitFor(() => h.deviceRegistry.getDevice('phone.chris').status === 'offline');
});

test('reconnecting with the same device id brings it back online and replaces the stale connection', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws1 = openSocket(t, h.wsUrl());
  await once(ws1, 'open');
  ws1.send(JSON.stringify({ type: 'hello', device: { id: 'phone.chris', name: "Chris's Phone", type: 'phone', capabilities: ['ui.notify'] } }));
  await nextMessage(ws1);

  ws1.terminate();
  await waitFor(() => h.deviceRegistry.getDevice('phone.chris').status === 'offline');

  const ws2 = openSocket(t, h.wsUrl());
  await once(ws2, 'open');
  ws2.send(JSON.stringify({ type: 'hello', device: { id: 'phone.chris', name: "Chris's Phone", type: 'phone', capabilities: ['ui.notify'] } }));
  await nextMessage(ws2);

  assert.equal(h.deviceRegistry.getDevice('phone.chris').status, 'online');
  // Trust set on first connection (defaults to 'untrusted') is preserved
  // across reconnects, same invariant as any other adapter's re-discovery.
  assert.equal(h.deviceRegistry.getDevice('phone.chris').trust, 'untrusted');
});

// --- subscribe / forwarded events, and cleanup on disconnect -------------------

test('subscribe forwards only matching EventBus events to the device, and stops after disconnect', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'display.kitchen', name: 'Kitchen Display', type: 'display', capabilities: ['ui.render'] } }));
  await nextMessage(ws);

  const subscriberCountBefore = h.eventBus.subscribers.length;
  ws.send(JSON.stringify({ type: 'subscribe', pattern: 'calendar.*' }));
  await new Promise((r) => setTimeout(r, 20)); // let the subscribe register

  const forwarded = nextMessage(ws);
  h.eventBus.publish({ type: 'email.received', data: {} }); // non-matching, must NOT be forwarded
  h.eventBus.publish({ type: 'calendar.event_added', data: { title: 'Standup' } });
  const msg = await forwarded;
  assert.equal(msg.type, 'event');
  assert.equal(msg.event.type, 'calendar.event_added');

  ws.terminate();
  await waitFor(() => h.eventBus.subscribers.length === subscriberCountBefore);
});

// --- device commands (request/response over the live connection) --------------

test('invoke() sends a command and resolves with the device-reported result', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'sensor.patio', name: 'Patio Sensor', type: 'sensor', capabilities: ['temperature.read'] } }));
  await nextMessage(ws);

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'command') {
      ws.send(JSON.stringify({ type: 'command_result', requestId: msg.requestId, result: { celsius: 19.2 } }));
    }
  });

  const device = h.deviceRegistry.getDevice('sensor.patio');
  const result = await h.adapter.invoke(device, 'temperature.read', {});
  assert.equal(result.celsius, 19.2);
});

test('invoke() rejects when the device reports command_error', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'sensor.patio', name: 'Patio Sensor', type: 'sensor', capabilities: ['temperature.read'] } }));
  await nextMessage(ws);

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'command') {
      ws.send(JSON.stringify({ type: 'command_error', requestId: msg.requestId, error: 'sensor unavailable' }));
    }
  });

  const device = h.deviceRegistry.getDevice('sensor.patio');
  await assert.rejects(() => h.adapter.invoke(device, 'temperature.read', {}), /sensor unavailable/);
});

test('invoke() times out if the device never responds', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t, { commandTimeoutMs: 80 });
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'sensor.silent', name: 'Silent Sensor', type: 'sensor', capabilities: ['temperature.read'] } }));
  await nextMessage(ws);
  // Deliberately never responds to the command.

  const device = h.deviceRegistry.getDevice('sensor.silent');
  await assert.rejects(() => h.adapter.invoke(device, 'temperature.read', {}), /timed out/);
});

test('invoke() rejects immediately for a device with no open connection', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  await assert.rejects(
    () => h.adapter.invoke({ id: 'nope.nope' }, 'temperature.read', {}),
    /not connected/
  );
});

// --- full server wiring (server/index.js's /ws/devices upgrade routing) -------

test('the real U2OS server routes /ws/devices upgrades to the realtime device adapter', async (t) => {
  const dir = useTempHome(t);
  const handle = await startServer({ port: 0 });
  handle.server.unref(); // test-only, see buildHarness()'s comment on why
  t.after(() => handle.server.close());
  const token = getOrCreateDeviceConnectToken(dir);

  const ws = openSocket(t, `ws://127.0.0.1:${handle.port}/ws/devices?token=${token}`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'e2e.satellite', name: 'E2E Satellite', type: 'satellite', capabilities: ['audio.listen'] } }));
  const ack = await nextMessage(ws);
  assert.equal(ack.type, 'hello_ack');
  assert.equal(ack.deviceId, 'e2e.satellite');

  const device = handle.deviceRegistry.getDevice('e2e.satellite');
  assert.equal(device.status, 'online');
});

test('an unrecognized upgrade path is refused rather than left hanging', async (t) => {
  useTempHome(t);
  const handle = await startServer({ port: 0 });
  handle.server.unref(); // test-only, see buildHarness()'s comment on why
  t.after(() => handle.server.close());
  const ws = openSocket(t, `ws://127.0.0.1:${handle.port}/ws/not-a-real-path`);
  await assert.rejects(() => once(ws, 'open'));
});
