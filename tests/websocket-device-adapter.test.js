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

/** Builds a plain http.Server + DeviceRegistry with a WebSocketDeviceAdapter
 * wired to /ws/devices, the same routing shape server/index.js uses, but
 * without booting the whole U2OS app -- keeps these protocol tests fast and
 * focused, mirroring tests/tool-registry.test.js's "test the component
 * directly" style. */
async function buildHarness({ heartbeatIntervalMs = 60000, commandTimeoutMs = 2000 } = {}) {
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

  return {
    db,
    eventBus,
    capabilityRegistry,
    deviceRegistry,
    adapter,
    server,
    wsUrl: (token = TOKEN) => `ws://127.0.0.1:${port}/ws/devices${token ? `?token=${token}` : ''}`,
    async close() {
      await deviceRegistry.stopAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
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

test('connecting with an invalid token is rejected before the WS handshake completes', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl('wrong-token'));
    await assert.rejects(() => once(ws, 'open'));
    await h.close();
  } finally {
    cleanup(dir);
  }
});

test('connecting with the correct token completes the handshake', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

// --- hello / registration ----------------------------------------------------

test('hello registers the device (online) and is acknowledged', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const discovered = [];
    h.eventBus.subscribe('device.discovered', (e) => discovered.push(e));

    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'sat.office', name: 'Office Satellite', type: 'satellite', capabilities: ['audio.listen'] } }));
    const ack = await nextMessage(ws);

    assert.equal(ack.type, 'hello_ack');
    assert.equal(ack.deviceId, 'sat.office');
    const device = h.deviceRegistry.getDevice('sat.office');
    assert.equal(device.status, 'online');
    assert.equal(device.adapter, 'websocket');
    assert.equal(discovered.length, 1);

    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

test('hello with a missing required field is rejected with an error message, not registered', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'bad.device' } }));
    const reply = await nextMessage(ws);
    assert.equal(reply.type, 'error');
    assert.equal(h.deviceRegistry.getDevice('bad.device'), null);
    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

test('sending a message before hello is rejected', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'event', event: { type: 'motion.detected', data: {} } }));
    const reply = await nextMessage(ws);
    assert.equal(reply.type, 'error');
    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

// --- event publication ---------------------------------------------------------

test('an event message from a registered device is published on the shared EventBus', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'cam.hall', name: 'Hall Camera', type: 'camera', capabilities: ['motion.events'] } }));
    await nextMessage(ws);

    const motionEvents = [];
    h.eventBus.subscribe('motion.detected', (e) => motionEvents.push(e));

    ws.send(JSON.stringify({ type: 'event', event: { type: 'motion.detected', data: { confidence: 0.9 } } }));
    await waitFor(() => motionEvents.length === 1);

    assert.equal(motionEvents[0].source, 'device:cam.hall');
    assert.equal(motionEvents[0].data.confidence, 0.9);

    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

// --- heartbeats ------------------------------------------------------------

test('heartbeat messages update last_seen_at without publishing extra connect/disconnect events', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const events = [];
    h.eventBus.subscribe('device.*', (e) => events.push(e.type));

    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'sensor.hall', name: 'Hall Sensor', type: 'sensor', capabilities: ['temperature.read'] } }));
    await nextMessage(ws);

    const before = h.deviceRegistry.getDevice('sensor.hall').last_seen_at;
    await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ type: 'heartbeat' }));
    await waitFor(() => h.deviceRegistry.getDevice('sensor.hall').last_seen_at !== before);

    // Only the original device.discovered + device.connected from hello --
    // the heartbeat itself must not add more.
    assert.deepEqual(events, ['device.discovered', 'device.connected']);

    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

// --- reconnect / failure conditions --------------------------------------------

test('an abrupt disconnect marks the device offline', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'phone.chris', name: "Chris's Phone", type: 'phone', capabilities: ['ui.notify'] } }));
    await nextMessage(ws);
    assert.equal(h.deviceRegistry.getDevice('phone.chris').status, 'online');

    ws.terminate(); // simulate a dropped connection, not a clean close
    await waitFor(() => h.deviceRegistry.getDevice('phone.chris').status === 'offline');

    await h.close();
  } finally {
    cleanup(dir);
  }
});

test('reconnecting with the same device id brings it back online and replaces the stale connection', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws1 = new WebSocket(h.wsUrl());
    await once(ws1, 'open');
    ws1.send(JSON.stringify({ type: 'hello', device: { id: 'phone.chris', name: "Chris's Phone", type: 'phone', capabilities: ['ui.notify'] } }));
    await nextMessage(ws1);

    ws1.terminate();
    await waitFor(() => h.deviceRegistry.getDevice('phone.chris').status === 'offline');

    const ws2 = new WebSocket(h.wsUrl());
    await once(ws2, 'open');
    ws2.send(JSON.stringify({ type: 'hello', device: { id: 'phone.chris', name: "Chris's Phone", type: 'phone', capabilities: ['ui.notify'] } }));
    await nextMessage(ws2);

    assert.equal(h.deviceRegistry.getDevice('phone.chris').status, 'online');
    // Trust set on first connection (defaults to 'untrusted') is preserved
    // across reconnects, same invariant as any other adapter's re-discovery.
    assert.equal(h.deviceRegistry.getDevice('phone.chris').trust, 'untrusted');

    ws2.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

// --- subscribe / forwarded events, and cleanup on disconnect -------------------

test('subscribe forwards only matching EventBus events to the device, and stops after disconnect', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
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

    await h.close();
  } finally {
    cleanup(dir);
  }
});

// --- device commands (request/response over the live connection) --------------

test('invoke() sends a command and resolves with the device-reported result', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
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

    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

test('invoke() rejects when the device reports command_error', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    const ws = new WebSocket(h.wsUrl());
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

    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

test('invoke() times out if the device never responds', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness({ commandTimeoutMs: 80 });
    const ws = new WebSocket(h.wsUrl());
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'sensor.silent', name: 'Silent Sensor', type: 'sensor', capabilities: ['temperature.read'] } }));
    await nextMessage(ws);
    // Deliberately never responds to the command.

    const device = h.deviceRegistry.getDevice('sensor.silent');
    await assert.rejects(() => h.adapter.invoke(device, 'temperature.read', {}), /timed out/);

    ws.terminate();
    await h.close();
  } finally {
    cleanup(dir);
  }
});

test('invoke() rejects immediately for a device with no open connection', async () => {
  const dir = tempHome();
  try {
    const h = await buildHarness();
    await assert.rejects(
      () => h.adapter.invoke({ id: 'nope.nope' }, 'temperature.read', {}),
      /not connected/
    );
    await h.close();
  } finally {
    cleanup(dir);
  }
});

// --- full server wiring (server/index.js's /ws/devices upgrade routing) -------

test('the real U2OS server routes /ws/devices upgrades to the realtime device adapter', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const token = getOrCreateDeviceConnectToken(dir);

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/devices?token=${token}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', device: { id: 'e2e.satellite', name: 'E2E Satellite', type: 'satellite', capabilities: ['audio.listen'] } }));
    const ack = await nextMessage(ws);
    assert.equal(ack.type, 'hello_ack');
    assert.equal(ack.deviceId, 'e2e.satellite');

    const device = handle.deviceRegistry.getDevice('e2e.satellite');
    assert.equal(device.status, 'online');

    ws.terminate();
  } finally {
    if (handle) await new Promise((r) => handle.server.close(r));
    cleanup(dir);
  }
});

test('an unrecognized upgrade path is refused rather than left hanging', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/not-a-real-path`);
    await assert.rejects(() => once(ws, 'open'));
  } finally {
    if (handle) await new Promise((r) => handle.server.close(r));
    cleanup(dir);
  }
});
