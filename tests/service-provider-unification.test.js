// Phase 9 (docs/devices.md): service-provider unification proof of
// concept. Proves a real EXISTING integration (notifications, via
// server/integrations/provider-registry.js) is discoverable and invocable
// through the exact same DeviceRegistry/CapabilityRegistry/resolver
// machinery as a physical mock device -- no special-casing anywhere for
// "this provider happens to be a service, not hardware."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { createCapabilityRegistry } from '../server/devices/register-capabilities.js';
import { DeviceRegistry } from '../server/devices/device-registry.js';
import { MockDeviceAdapter } from '../server/devices/adapters/mock-device-adapter.js';
import { NotificationServiceAdapter } from '../server/devices/adapters/notification-service-adapter.js';
import { explainResolution, resolveCapability } from '../server/devices/capability-resolver.js';
import { invokeCapability } from '../server/devices/capabilities.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-service-unification-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}
async function buildRegistry() {
  const db = getDb();
  const eventBus = new EventBus(db);
  const capabilityRegistry = createCapabilityRegistry();
  const deviceRegistry = new DeviceRegistry({ db, eventBus, capabilityRegistry });
  await deviceRegistry.registerAdapter(new MockDeviceAdapter());
  await deviceRegistry.registerAdapter(new NotificationServiceAdapter());
  return { db, eventBus, capabilityRegistry, deviceRegistry };
}

// --- discovery -----------------------------------------------------------

test('the notification service registers as an ordinary device, type "service"', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = await buildRegistry();
    const device = deviceRegistry.getDevice('service.notifications');
    assert.ok(device);
    assert.equal(device.type, 'service');
    assert.equal(device.adapter, 'service:notifications');
    assert.deepEqual(device.capabilities, ['notification.send']);
    assert.equal(device.trust, 'trusted');
  } finally {
    cleanup(dir);
  }
});

test('findProvidersFor() lists the service exactly like it lists a physical device', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = await buildRegistry();
    const notifyProviders = deviceRegistry.findProvidersFor('notification.send');
    assert.equal(notifyProviders.length, 1);
    assert.equal(notifyProviders[0].id, 'service.notifications');

    const tempProviders = deviceRegistry.findProvidersFor('temperature.read');
    assert.equal(tempProviders.length, 1);
    assert.equal(tempProviders[0].id, 'mock.sensor.temperature.office');
  } finally {
    cleanup(dir);
  }
});

// --- resolution: identical shape for a physical device and a service --------

test('the resolver produces the identical explanation shape for a service capability and a device capability', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry, capabilityRegistry } = await buildRegistry();
    const deps = { deviceRegistry, capabilityRegistry };

    const serviceExplanation = explainResolution('notification.send', {}, deps);
    const deviceExplanation = explainResolution('temperature.read', {}, deps);

    for (const explanation of [serviceExplanation, deviceExplanation]) {
      assert.equal(typeof explanation.capability, 'string');
      assert.ok(Array.isArray(explanation.candidates));
      const [candidate] = explanation.candidates;
      assert.equal(typeof candidate.device, 'string');
      assert.equal(typeof candidate.eligible, 'boolean');
      assert.equal(typeof candidate.score, 'number');
      assert.ok(Array.isArray(candidate.reasons));
    }

    assert.equal(serviceExplanation.chosen, 'service.notifications');
    assert.equal(deviceExplanation.chosen, 'mock.sensor.temperature.office');
  } finally {
    cleanup(dir);
  }
});

test('resolveCapability() works identically for the service and a physical device', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const service = resolveCapability('notification.send', {}, deps);
    const device = resolveCapability('temperature.read', {}, deps);
    assert.equal(service.id, 'service.notifications');
    assert.equal(service.type, 'service');
    assert.equal(device.id, 'mock.sensor.temperature.office');
    assert.equal(device.type, 'sensor');
  } finally {
    cleanup(dir);
  }
});

// --- invocation: identical pipeline, real underlying effect ------------------

test('invokeCapability() actually sends a notification through the real (mock) notifications provider', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const outcome = await invokeCapability('notification.send', { title: 'Package delivered', body: 'Front porch' }, {}, deps);
    assert.equal(outcome.device, 'service.notifications');
    assert.equal(outcome.result.title, 'Package delivered');
    assert.equal(outcome.result.body, 'Front porch');
    assert.equal(outcome.result.priority, 'normal');
    assert.ok(outcome.result.sentAt);
  } finally {
    cleanup(dir);
  }
});

test('invokeCapability() for a physical device capability goes through the identical function', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const outcome = await invokeCapability('temperature.read', {}, {}, deps);
    assert.equal(outcome.device, 'mock.sensor.temperature.office');
    assert.equal(typeof outcome.result.celsius, 'number');
  } finally {
    cleanup(dir);
  }
});

test('the trust/privacy resolver rules apply to a service exactly as they apply to a device', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry, capabilityRegistry } = await buildRegistry();
    // Revoking the service is exactly as effective as revoking a physical
    // device -- no special-casing for "this one is a service".
    deviceRegistry.setTrust('service.notifications', 'revoked');
    const explanation = explainResolution('notification.send', {}, { deviceRegistry, capabilityRegistry });
    assert.equal(explanation.candidates[0].eligible, false);
    assert.deepEqual(explanation.candidates[0].reasons, ['device is revoked']);
  } finally {
    cleanup(dir);
  }
});

test('both a physical device and a service capability can be invoked through presentation.notify-style flows via the shared capabilities.js module', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    // notification.send (service) and ui.notify (physical mock devices)
    // are two different capabilities on two different kinds of provider,
    // both reachable through the exact same invokeCapability() call shape.
    const notifyOutcome = await invokeCapability('notification.send', { title: 'Hi' }, {}, deps);
    const uiOutcome = await invokeCapability('ui.notify', { title: 'Hi' }, {}, deps);
    assert.equal(notifyOutcome.device, 'service.notifications');
    assert.notEqual(uiOutcome.device, 'service.notifications');
  } finally {
    cleanup(dir);
  }
});
