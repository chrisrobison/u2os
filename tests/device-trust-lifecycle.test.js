// Phase 7 (docs/devices.md): the trust lifecycle foundation. Phases 1-6
// already proved a revoked device is excluded by the resolver
// (tests/capability-resolver.test.js) and refused by invokeDeviceCapability
// (tests/device-management.test.js) -- this file covers what's NEW this
// phase: revocation forcibly disconnects a live realtime connection, a
// revoked device can never publish another event even mid-race, and a
// brand-new device connecting over the realtime bus emits
// device.pairing_requested exactly once (not on every reconnect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { createCapabilityRegistry } from '../server/devices/register-capabilities.js';
import { DeviceRegistry } from '../server/devices/device-registry.js';
import { MockDeviceAdapter } from '../server/devices/adapters/mock-device-adapter.js';
import { WebSocketDeviceAdapter } from '../server/devices/adapters/websocket-device-adapter.js';

const TOKEN = 'test-connect-token';

function useTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-trust-lifecycle-'));
  process.env.U2OS_HOME = dir;
  t.after(() => {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Same harness shape/rationale as tests/websocket-device-adapter.test.js --
// see that file's header comments for why server.unref() + fire-and-forget
// server.close() is required for `node --test` to exit cleanly.
async function buildHarness(t) {
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  const adapter = new WebSocketDeviceAdapter({ connectToken: TOKEN, heartbeatIntervalMs: 60000, commandTimeoutMs: 2000 });
  await deviceRegistry.registerAdapter(adapter);

  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ws/devices') adapter.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const port = server.address().port;

  t.after(async () => {
    await deviceRegistry.stopAll();
    server.close();
  });

  return { db, eventBus, capabilityRegistry, deviceRegistry, adapter, wsUrl: () => `ws://127.0.0.1:${port}/ws/devices?token=${TOKEN}` };
}

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

async function waitFor(predicate, { timeout = 2000, interval = 15 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor: condition never became true within timeout');
}

// --- the trust lifecycle enum itself -----------------------------------------

test('a device progresses through the full trust lifecycle: discovered (untrusted) -> paired -> trusted -> revoked', async (t) => {
  useTempHome(t);
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  await deviceRegistry.registerAdapter(new MockDeviceAdapter());

  // "discovered" == freshly upserted, defaults to untrusted (Phase 1).
  // MockDeviceAdapter's own fixtures declare trust:'trusted' up front
  // (they're local dev fixtures, not real hardware needing pairing -- see
  // its file header), so upsert a fresh device with no trust specified to
  // exercise the real default here instead.
  deviceRegistry.upsertDevice('mock', { id: 'mock.lifecycle-test', name: 'Lifecycle Test Device', type: 'sensor', capabilities: [] });
  assert.equal(deviceRegistry.getDevice('mock.lifecycle-test').trust, 'untrusted');

  assert.equal(deviceRegistry.setTrust('mock.lifecycle-test', 'paired').trust, 'paired');
  assert.equal(deviceRegistry.setTrust('mock.lifecycle-test', 'trusted').trust, 'trusted');
  assert.equal(deviceRegistry.setTrust('mock.lifecycle-test', 'revoked').trust, 'revoked');

  // Revoked is not a dead end for the STORED value (an owner could in
  // principle re-pair a device later) -- only enforcement (resolver/
  // invoke) treats it as permanently disqualifying for any given request.
  assert.equal(deviceRegistry.setTrust('mock.lifecycle-test', 'untrusted').trust, 'untrusted');
});

// --- device revocation (required test, section 21) ---------------------------

test('device revocation: a revoked device is refused by every enforcement path at once', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'sensor.patio', name: 'Patio Sensor', type: 'sensor', owner: 'chris', capabilities: ['temperature.read'] } }));
  await nextMessage(ws);
  h.deviceRegistry.setTrust('sensor.patio', 'trusted');

  const { invokeCapability, invokeDeviceCapability } = await import('../server/devices/capabilities.js');
  const { explainResolution } = await import('../server/devices/capability-resolver.js');

  // Eligible while trusted.
  let explanation = explainResolution('temperature.read', {}, { deviceRegistry: h.deviceRegistry, capabilityRegistry: h.capabilityRegistry });
  assert.equal(explanation.chosen, 'sensor.patio');

  // Revoke.
  h.deviceRegistry.setTrust('sensor.patio', 'revoked');

  // 1) Resolver: always ineligible.
  explanation = explainResolution('temperature.read', {}, { deviceRegistry: h.deviceRegistry, capabilityRegistry: h.capabilityRegistry });
  assert.equal(explanation.candidates[0].eligible, false);
  assert.deepEqual(explanation.candidates[0].reasons, ['device is revoked']);

  // 2) invokeCapability: no eligible device.
  await assert.rejects(
    () => invokeCapability('temperature.read', {}, {}, { deviceRegistry: h.deviceRegistry, capabilityRegistry: h.capabilityRegistry, eventBus: h.eventBus }),
    /No eligible device/
  );

  // 3) invokeDeviceCapability: refused even when targeted directly.
  await assert.rejects(
    () => invokeDeviceCapability('sensor.patio', 'temperature.read', {}, { deviceRegistry: h.deviceRegistry, capabilityRegistry: h.capabilityRegistry, eventBus: h.eventBus }),
    /revoked/
  );

  // 4) Realtime connection: forcibly disconnected -- the device goes
  // offline without anything else touching it.
  await waitFor(() => h.deviceRegistry.getDevice('sensor.patio').status === 'offline');
});

test('device revocation: an in-flight event from a just-revoked device is refused, not published', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const ws = openSocket(t, h.wsUrl());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', device: { id: 'cam.hall', name: 'Hall Camera', type: 'camera', capabilities: ['motion.events'] } }));
  await nextMessage(ws);

  const motionEvents = [];
  h.eventBus.subscribe('motion.detected', (e) => motionEvents.push(e));

  h.deviceRegistry.setTrust('cam.hall', 'revoked');
  // The revocation's own force-disconnect races with this send -- either
  // way the event must never reach the bus.
  ws.send(JSON.stringify({ type: 'event', event: { type: 'motion.detected', data: {} } }));
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(motionEvents.length, 0);
});

// --- pairing requests (Phase 7's "discovered -> pairing request" step) ------

test('a brand-new device connecting over the realtime bus emits device.pairing_requested exactly once', async (t) => {
  useTempHome(t);
  const h = await buildHarness(t);
  const pairingRequests = [];
  h.eventBus.subscribe('device.pairing_requested', (e) => pairingRequests.push(e));

  const ws1 = openSocket(t, h.wsUrl());
  await once(ws1, 'open');
  ws1.send(JSON.stringify({ type: 'hello', device: { id: 'sat.new', name: 'New Satellite', type: 'satellite', capabilities: [] } }));
  await nextMessage(ws1);

  assert.equal(pairingRequests.length, 1);
  assert.equal(pairingRequests[0].data.deviceId, 'sat.new');
  assert.equal(pairingRequests[0].subject.id, 'sat.new');

  // Reconnecting the SAME device must not request pairing again.
  ws1.terminate();
  await waitFor(() => h.deviceRegistry.getDevice('sat.new').status === 'offline');

  const ws2 = openSocket(t, h.wsUrl());
  await once(ws2, 'open');
  ws2.send(JSON.stringify({ type: 'hello', device: { id: 'sat.new', name: 'New Satellite', type: 'satellite', capabilities: [] } }));
  await nextMessage(ws2);

  assert.equal(pairingRequests.length, 1);
});

test('mock/local adapters do not emit pairing_requested -- they are pre-trusted fixtures, not remote devices being paired', async (t) => {
  useTempHome(t);
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  const pairingRequests = [];
  eventBus.subscribe('device.pairing_requested', (e) => pairingRequests.push(e));

  await deviceRegistry.registerAdapter(new MockDeviceAdapter());

  assert.equal(pairingRequests.length, 0);
});

// --- cryptographic identity seam (documented, not implemented this phase) ---

test('device metadata can carry adapter-specific credential material with no schema change (the documented crypto-identity seam)', async (t) => {
  useTempHome(t);
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  const adapter = new WebSocketDeviceAdapter({ connectToken: TOKEN });
  await deviceRegistry.registerAdapter(adapter);

  deviceRegistry.upsertDevice('websocket', {
    id: 'satellite.future',
    name: 'Future Satellite',
    type: 'satellite',
    capabilities: [],
    metadata: { publicKey: 'ed25519:AAAA...', pairingProtocolVersion: 1 },
  });

  const device = deviceRegistry.getDevice('satellite.future');
  assert.equal(device.metadata.publicKey, 'ed25519:AAAA...');
  // Storing it changes nothing about trust -- metadata is descriptive, not
  // authoritative; only setTrust() (owner-driven, or a future verified-
  // signature adapter) ever changes enforcement.
  assert.equal(device.trust, 'untrusted');
});
