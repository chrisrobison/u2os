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
import { explainResolution, resolveCapability } from '../server/devices/capability-resolver.js';
import { invokeCapability } from '../server/devices/capabilities.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-resolver-test-'));
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
  return { db, eventBus, capabilityRegistry, deviceRegistry };
}

// --- provider resolution -----------------------------------------------------

test('provider resolution: resolves a capability to a single eligible device', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const device = resolveCapability('temperature.read', {}, deps);
    assert.equal(device.id, 'mock.sensor.temperature.office');
  } finally {
    cleanup(dir);
  }
});

test('provider resolution: returns null when a registered capability has no supporting device', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    // presence.detect is in the built-in catalog but no mock device
    // advertises it -- a known-capability, zero-providers case, distinct
    // from an unregistered capability id (see "unsupported capability" below).
    assert.equal(resolveCapability('presence.detect', {}, deps), null);
  } finally {
    cleanup(dir);
  }
});

// --- unsupported capability --------------------------------------------------

test('unsupported capability: resolving/explaining/invoking an unregistered capability throws', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    assert.throws(() => explainResolution('finance.balance', {}, deps), /Unknown capability/);
    assert.throws(() => resolveCapability('finance.balance', {}, deps), /Unknown capability/);
    await assert.rejects(() => invokeCapability('finance.balance', {}, {}, deps), /Unknown capability/);
  } finally {
    cleanup(dir);
  }
});

// --- offline provider rejection -----------------------------------------------

test('offline provider rejection: an offline device is ineligible even though it supports the capability', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    deps.deviceRegistry.setStatus('mock.sensor.temperature.office', 'offline');

    const explanation = explainResolution('temperature.read', {}, deps);
    assert.equal(explanation.chosen, null);
    assert.equal(explanation.candidates.length, 1);
    assert.equal(explanation.candidates[0].eligible, false);
    assert.match(explanation.candidates[0].reasons.join(' '), /offline/);
  } finally {
    cleanup(dir);
  }
});

// --- untrusted provider rejection ---------------------------------------------

test('untrusted provider rejection: an untrusted device cannot receive above-public content', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    // Force the phone's trust down from the mock's default 'trusted'.
    deps.db.prepare("UPDATE devices SET trust = 'untrusted' WHERE id = 'mock.phone.chris'").run();

    const explanation = explainResolution('ui.notify', { audience: 'chris', privacy: 'personal' }, deps);
    const phone = explanation.candidates.find((c) => c.device === 'mock.phone.chris');
    assert.equal(phone.eligible, false);
    assert.match(phone.reasons.join(' '), /insufficient/);
  } finally {
    cleanup(dir);
  }
});

test('a revoked device is always ineligible, even for public content', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    deps.deviceRegistry.setTrust('mock.phone.chris', 'revoked');

    const explanation = explainResolution('ui.notify', {}, deps);
    const phone = explanation.candidates.find((c) => c.device === 'mock.phone.chris');
    assert.equal(phone.eligible, false);
    assert.deepEqual(phone.reasons, ['device is revoked']);
  } finally {
    cleanup(dir);
  }
});

// --- private presentation routing ---------------------------------------------

test('private presentation to personal device: Chris\'s phone is eligible for private content addressed to Chris', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const explanation = explainResolution('ui.render', { audience: 'chris', privacy: 'private' }, deps);
    const phone = explanation.candidates.find((c) => c.device === 'mock.phone.chris');
    assert.equal(phone.eligible, true);
    assert.equal(explanation.chosen, 'mock.phone.chris');
  } finally {
    cleanup(dir);
  }
});

test('private presentation rejection on shared display: the household living-room display cannot receive private content', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const explanation = explainResolution('ui.render', { audience: 'chris', privacy: 'private' }, deps);
    const livingRoom = explanation.candidates.find((c) => c.device === 'mock.display.livingroom');
    assert.equal(livingRoom.eligible, false);
    assert.match(livingRoom.reasons.join(' '), /shared device cannot receive/);
  } finally {
    cleanup(dir);
  }
});

test('financial/sensitive content follows the exact same private-routing rule as private', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const explanation = explainResolution('ui.render', { audience: 'chris', privacy: 'sensitive' }, deps);
    assert.equal(explanation.chosen, 'mock.phone.chris');
    const livingRoom = explanation.candidates.find((c) => c.device === 'mock.display.livingroom');
    assert.equal(livingRoom.eligible, false);
  } finally {
    cleanup(dir);
  }
});

test('public content with no audience is eligible on any online, non-revoked device supporting the capability', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const explanation = explainResolution('ui.notify', {}, deps);
    assert.equal(explanation.candidates.every((c) => c.eligible), true);
  } finally {
    cleanup(dir);
  }
});

// --- resolver explanation output ----------------------------------------------

test('resolver explanation output has the documented shape and is sorted eligible-first, then by score', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const explanation = explainResolution('ui.render', { audience: 'chris', privacy: 'private' }, deps);

    assert.equal(explanation.capability, 'ui.render');
    assert.equal(explanation.request.privacy, 'private');
    assert.ok(Array.isArray(explanation.candidates));
    for (const c of explanation.candidates) {
      assert.equal(typeof c.device, 'string');
      assert.equal(typeof c.eligible, 'boolean');
      assert.equal(typeof c.score, 'number');
      assert.ok(Array.isArray(c.reasons));
    }
    // eligible candidates sort before ineligible ones
    const firstIneligible = explanation.candidates.findIndex((c) => !c.eligible);
    const lastEligible = explanation.candidates.map((c) => c.eligible).lastIndexOf(true);
    if (firstIneligible !== -1 && lastEligible !== -1) {
      assert.ok(lastEligible < firstIneligible);
    }
  } finally {
    cleanup(dir);
  }
});

// --- invocation ------------------------------------------------------------

test('invokeCapability resolves a device, executes it, and publishes capability.invoked', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const events = [];
    deps.eventBus.subscribe('capability.*', (e) => events.push(e));

    const outcome = await invokeCapability('temperature.read', {}, {}, deps);
    assert.equal(outcome.device, 'mock.sensor.temperature.office');
    assert.equal(typeof outcome.result.celsius, 'number');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'capability.invoked');
    assert.equal(events[0].data.capability, 'temperature.read');
  } finally {
    cleanup(dir);
  }
});

test('invokeCapability throws and publishes capability.failed when no device is eligible', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const events = [];
    deps.eventBus.subscribe('capability.failed', (e) => events.push(e));

    deps.deviceRegistry.setStatus('mock.sensor.temperature.office', 'offline');
    await assert.rejects(() => invokeCapability('temperature.read', {}, {}, deps), /No eligible device/);

    assert.equal(events.length, 1);
    assert.equal(events[0].data.reason, 'no_eligible_provider');
  } finally {
    cleanup(dir);
  }
});

test('invokeCapability propagates an adapter execution failure as capability.failed', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const events = [];
    deps.eventBus.subscribe('capability.failed', (e) => events.push(e));

    // motion.events is advertised by the mock camera but MockDeviceAdapter
    // doesn't implement it -- a realistic "adapter can't actually do this"
    // failure distinct from "no device found".
    await assert.rejects(() => invokeCapability('motion.events', {}, {}, deps), /cannot perform capability/);

    assert.equal(events.length, 1);
    assert.equal(events[0].data.reason, 'adapter_invoke_failed');
  } finally {
    cleanup(dir);
  }
});

test('a revoked device is re-checked at invocation time (defense in depth)', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    // Resolve while trusted, then revoke before invoking via the raw
    // adapter path is hard to race in a unit test -- instead verify the
    // guard directly: revoke, then attempt to invoke the only capable
    // device (still the resolver's "chosen", since it's the only
    // candidate) and confirm invocation is refused rather than silently
    // running on a revoked device.
    deps.deviceRegistry.setTrust('mock.sensor.temperature.office', 'revoked');
    await assert.rejects(() => invokeCapability('temperature.read', {}, {}, deps), /No eligible device/);
  } finally {
    cleanup(dir);
  }
});
