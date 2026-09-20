import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { CapabilityRegistry } from '../server/devices/capability-registry.js';
import { createCapabilityRegistry } from '../server/devices/register-capabilities.js';
import { DeviceRegistry } from '../server/devices/device-registry.js';
import { DeviceAdapter } from '../server/devices/device-adapter.js';
import { MockDeviceAdapter } from '../server/devices/adapters/mock-device-adapter.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-device-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildRegistry() {
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  return { db, eventBus, capabilityRegistry, deviceRegistry };
}

// --- capability registry ---------------------------------------------------

test('capability registration and discovery', () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'image.capture', description: 'Capture a still image' });

  assert.equal(registry.has('image.capture'), true);
  assert.equal(registry.get('image.capture').description, 'Capture a still image');
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.get('nope.nope'));
});

test('duplicate capability registration throws', () => {
  const registry = new CapabilityRegistry();
  registry.register({ id: 'ui.render' });
  assert.throws(() => registry.register({ id: 'ui.render' }));
});

test('capability defaults are filled in and unrecognized privacy/authorization values fall back safely', () => {
  const registry = new CapabilityRegistry();
  const capability = registry.register({ id: 'weird.one', privacy: 'nonsense', defaultAuthorization: 'nonsense' });
  assert.equal(capability.privacy, 'personal');
  assert.equal(capability.defaultAuthorization, 'confirm');
});

test('the built-in capability catalog covers the core semantic vocabulary', () => {
  const registry = createCapabilityRegistry();
  for (const id of ['ui.render', 'ui.notify', 'image.capture', 'audio.listen', 'temperature.read', 'notification.send']) {
    assert.equal(registry.has(id), true, `expected built-in capability ${id}`);
  }
});

// --- device adapter interface -----------------------------------------------

test('DeviceAdapter base class defaults are safe no-ops / explicit failures', async () => {
  const adapter = new DeviceAdapter();
  assert.deepEqual(await adapter.discover(), []);
  assert.deepEqual(await adapter.getDevices(), []);
  await assert.rejects(() => adapter.invoke({}, 'x', {}));
  await assert.rejects(() => adapter.getStream({}, 'x'));
  assert.throws(() => adapter.id);
});

// --- device registry: registration ------------------------------------------

test('registering an adapter discovers and persists its devices', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry, capabilityRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());

    const devices = deviceRegistry.listDevices();
    assert.ok(devices.length >= 4);
    const camera = deviceRegistry.getDevice('mock.camera.kitchen');
    assert.ok(camera);
    assert.equal(camera.type, 'camera');
    assert.equal(camera.status, 'online');
    assert.equal(camera.trust, 'trusted');
    assert.ok(camera.capabilities.includes('image.capture'));
    for (const capId of camera.capabilities) assert.equal(capabilityRegistry.has(capId), true);
  } finally {
    cleanup(dir);
  }
});

test('duplicate adapter registration throws', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());
    await assert.rejects(() => deviceRegistry.registerAdapter(new MockDeviceAdapter()), /already registered/);
  } finally {
    cleanup(dir);
  }
});

test('re-discovering an already-known device updates it in place rather than duplicating it', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());
    const before = deviceRegistry.listDevices().length;

    await deviceRegistry.runDiscovery('mock');

    assert.equal(deviceRegistry.listDevices().length, before);
  } finally {
    cleanup(dir);
  }
});

test('upsertDevice requires a registered adapter, and requires id/name/type', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    assert.throws(() => deviceRegistry.upsertDevice('nope', { id: 'x', name: 'X', type: 'sensor' }), /Unknown adapter/);

    await deviceRegistry.registerAdapter(new MockDeviceAdapter());
    assert.throws(() => deviceRegistry.upsertDevice('mock', { name: 'X', type: 'sensor' }), /id is required/);
    assert.throws(() => deviceRegistry.upsertDevice('mock', { id: 'x' }), /requires name and type/);
  } finally {
    cleanup(dir);
  }
});

// --- device registry: discovery / filtering ---------------------------------

test('capability discovery: findProvidersFor returns only devices advertising that capability', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());

    const providers = deviceRegistry.findProvidersFor('temperature.read');
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, 'mock.sensor.temperature.office');

    assert.equal(deviceRegistry.findProvidersFor('finance.balance').length, 0);
  } finally {
    cleanup(dir);
  }
});

test('listDevices supports filtering by type/owner/location/status/trust', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());

    assert.equal(deviceRegistry.listDevices({ type: 'camera' }).length, 1);
    assert.equal(deviceRegistry.listDevices({ owner: 'chris' }).length, 1);
    assert.equal(deviceRegistry.listDevices({ location: 'office' }).length, 2);
    assert.equal(deviceRegistry.listDevices({ trust: 'trusted' }).length, deviceRegistry.listDevices().length);
    assert.equal(deviceRegistry.listDevices({ status: 'offline' }).length, 0);
  } finally {
    cleanup(dir);
  }
});

// --- device registry: offline / trust handling ------------------------------

test('device offline handling: setStatus transitions and is reflected in listDevices', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());

    deviceRegistry.setStatus('mock.camera.kitchen', 'offline');
    const device = deviceRegistry.getDevice('mock.camera.kitchen');
    assert.equal(device.status, 'offline');
    assert.equal(deviceRegistry.listDevices({ status: 'offline' }).length, 1);
    assert.equal(deviceRegistry.findProvidersFor('image.capture', { status: 'online' }).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('setTrust changes trust level; re-discovery never overwrites an existing device\'s trust', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());

    deviceRegistry.setTrust('mock.camera.kitchen', 'revoked');
    assert.equal(deviceRegistry.getDevice('mock.camera.kitchen').trust, 'revoked');

    await deviceRegistry.runDiscovery('mock');
    assert.equal(deviceRegistry.getDevice('mock.camera.kitchen').trust, 'revoked');
  } finally {
    cleanup(dir);
  }
});

test('setStatus/setTrust reject unknown devices and invalid values', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());
    assert.throws(() => deviceRegistry.setStatus('nope', 'online'), /Unknown device/);
    assert.throws(() => deviceRegistry.setStatus('mock.camera.kitchen', 'sleeping'), /Invalid device status/);
    assert.throws(() => deviceRegistry.setTrust('mock.camera.kitchen', 'super-trusted'), /Invalid trust level/);
  } finally {
    cleanup(dir);
  }
});

// --- event publishing / subscription ----------------------------------------

test('discovering devices publishes device.discovered and device.connected events on the shared event bus', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry, eventBus } = buildRegistry();
    const discovered = [];
    const connected = [];
    eventBus.subscribe('device.discovered', (e) => discovered.push(e));
    eventBus.subscribe('device.connected', (e) => connected.push(e));

    await deviceRegistry.registerAdapter(new MockDeviceAdapter());

    assert.ok(discovered.length >= 4);
    assert.ok(connected.length >= 4);
    assert.equal(discovered[0].subject.type, 'device');
    assert.equal(discovered[0].data.device.id, discovered[0].subject.id);
  } finally {
    cleanup(dir);
  }
});

test('going offline then online publishes device.disconnected then device.connected', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry, eventBus } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());

    const events = [];
    eventBus.subscribe('device.*', (e) => events.push(e.type));

    deviceRegistry.setStatus('mock.camera.kitchen', 'offline');
    deviceRegistry.setStatus('mock.camera.kitchen', 'online');

    assert.deepEqual(events, ['device.disconnected', 'device.connected']);
  } finally {
    cleanup(dir);
  }
});

// --- adapter invoke (basic plumbing; the trust/privacy-aware resolver is a later phase) --

test('MockDeviceAdapter.invoke performs supported capabilities and rejects unsupported ones', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());
    const adapter = deviceRegistry.getAdapter('mock');
    const sensor = deviceRegistry.getDevice('mock.sensor.temperature.office');

    const reading = await adapter.invoke(sensor, 'temperature.read', {});
    assert.equal(typeof reading.celsius, 'number');

    await assert.rejects(() => adapter.invoke(sensor, 'video.stream', {}), /cannot perform capability/);
  } finally {
    cleanup(dir);
  }
});

test('adapter registration: stopAll() stops every adapter and forgets them', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = buildRegistry();
    await deviceRegistry.registerAdapter(new MockDeviceAdapter());
    assert.deepEqual(deviceRegistry.listAdapters(), ['mock']);

    await deviceRegistry.stopAll();
    assert.deepEqual(deviceRegistry.listAdapters(), []);
    // Devices already persisted are left alone by stopAll().
    assert.ok(deviceRegistry.getDevice('mock.camera.kitchen'));
  } finally {
    cleanup(dir);
  }
});
