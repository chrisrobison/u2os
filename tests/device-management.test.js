// Phase 6 (docs/devices.md): device management primitives -- rename/set
// location/set owner, trust transitions, removal, "test capability" (a
// direct, resolver-bypassing invoke of one specific device), and
// subject-filtered recent activity. Unit-level (DeviceRegistry/
// capabilities.js) plus one full-server route pass.
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
import { invokeDeviceCapability } from '../server/devices/capabilities.js';
import { listEvents } from '../server/events/log.js';
import { startServer } from '../server/index.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-device-mgmt-test-'));
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

// --- DeviceRegistry.updateDevice ---------------------------------------------

test('updateDevice renames/relocates/reassigns owner, leaving everything else untouched', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = await buildRegistry();
    const before = deviceRegistry.getDevice('mock.camera.kitchen');

    const updated = deviceRegistry.updateDevice('mock.camera.kitchen', { name: 'Back Door Camera', location: 'back-door' });
    assert.equal(updated.name, 'Back Door Camera');
    assert.equal(updated.location, 'back-door');
    assert.equal(updated.owner, before.owner); // untouched
    assert.deepEqual(updated.capabilities, before.capabilities);
    assert.equal(updated.trust, before.trust);
    assert.equal(updated.status, before.status);
  } finally {
    cleanup(dir);
  }
});

test('updateDevice throws for an unknown device', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry } = await buildRegistry();
    assert.throws(() => deviceRegistry.updateDevice('nope', { name: 'x' }), /Unknown device/);
  } finally {
    cleanup(dir);
  }
});

// --- invokeDeviceCapability ("Test capability") -----------------------------

test('invokeDeviceCapability directly invokes the named device, bypassing the resolver', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    const outcome = await invokeDeviceCapability('mock.sensor.temperature.office', 'temperature.read', {}, deps);
    assert.equal(outcome.device, 'mock.sensor.temperature.office');
    assert.equal(typeof outcome.result.celsius, 'number');
  } finally {
    cleanup(dir);
  }
});

test('invokeDeviceCapability refuses a device that does not advertise the capability', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    await assert.rejects(
      () => invokeDeviceCapability('mock.sensor.temperature.office', 'image.capture', {}, deps),
      /does not advertise capability/
    );
  } finally {
    cleanup(dir);
  }
});

test('invokeDeviceCapability refuses a revoked device even when directly targeted', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    deps.deviceRegistry.setTrust('mock.sensor.temperature.office', 'revoked');
    await assert.rejects(() => invokeDeviceCapability('mock.sensor.temperature.office', 'temperature.read', {}, deps), /revoked/);
  } finally {
    cleanup(dir);
  }
});

test('invokeDeviceCapability rejects an unknown device or unknown capability', async () => {
  const dir = tempHome();
  try {
    const deps = await buildRegistry();
    await assert.rejects(() => invokeDeviceCapability('nope', 'temperature.read', {}, deps), /Unknown device/);
    await assert.rejects(() => invokeDeviceCapability('mock.sensor.temperature.office', 'finance.balance', {}, deps), /Unknown capability/);
  } finally {
    cleanup(dir);
  }
});

// --- subject-filtered recent activity ----------------------------------------

test('listEvents can filter by subjectType/subjectId (device recent-activity view)', async () => {
  const dir = tempHome();
  try {
    const { db, deviceRegistry } = await buildRegistry();
    const events = listEvents(db, { subjectType: 'device', subjectId: 'mock.camera.kitchen' });
    assert.ok(events.length >= 1);
    assert.ok(events.every((e) => e.subject?.id === 'mock.camera.kitchen'));

    const other = listEvents(db, { subjectType: 'device', subjectId: 'mock.phone.chris' });
    assert.ok(other.every((e) => e.subject?.id === 'mock.phone.chris'));
    assert.notDeepEqual(events, other);
  } finally {
    cleanup(dir);
  }
});

// --- full-server route pass --------------------------------------------------

function base(handle) {
  return `http://127.0.0.1:${handle.port}`;
}

test('device management routes: rename, trust transition, test capability, delete', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0, mode: 'demo', developmentMode: true });
    const origin = base(handle);
    const setup = await fetch(`${origin}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
    });
    const setupBody = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const writeHeaders = { cookie, origin, 'content-type': 'application/json', 'x-u2os-csrf': setupBody.csrfToken };

    // Rename + relocate.
    const patchRes = await fetch(`${origin}/api/devices/mock.camera.kitchen`, {
      method: 'PATCH',
      headers: writeHeaders,
      body: JSON.stringify({ name: 'Back Door Camera', location: 'back-door' }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).name, 'Back Door Camera');

    // Unknown device -> 404.
    const patchMissing = await fetch(`${origin}/api/devices/nope`, { method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ name: 'x' }) });
    assert.equal(patchMissing.status, 404);

    // Trust transition (Pair/Trust/Revoke are all this one primitive).
    const trustRes = await fetch(`${origin}/api/devices/mock.camera.kitchen/trust`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ trust: 'revoked' }),
    });
    assert.equal(trustRes.status, 200);
    assert.equal((await trustRes.json()).trust, 'revoked');

    const badTrust = await fetch(`${origin}/api/devices/mock.camera.kitchen/trust`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ trust: 'super-trusted' }),
    });
    assert.equal(badTrust.status, 400);

    // Test capability, direct/resolver-bypassing.
    const testRes = await fetch(`${origin}/api/devices/mock.sensor.temperature.office/test`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ capability: 'temperature.read' }),
    });
    assert.equal(testRes.status, 200);
    const testBody = await testRes.json();
    assert.equal(testBody.device, 'mock.sensor.temperature.office');
    assert.equal(typeof testBody.result.celsius, 'number');

    const testUnsupported = await fetch(`${origin}/api/devices/mock.sensor.temperature.office/test`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ capability: 'image.capture' }),
    });
    assert.equal(testUnsupported.status, 400);

    // Recent activity for a device.
    const activityRes = await fetch(`${origin}/api/events?subjectType=device&subjectId=mock.camera.kitchen`, { headers: { cookie } });
    assert.equal(activityRes.status, 200);
    const activity = await activityRes.json();
    assert.ok(activity.events.length >= 1);

    // Delete.
    const deleteRes = await fetch(`${origin}/api/devices/mock.camera.kitchen`, { method: 'DELETE', headers: writeHeaders });
    assert.equal(deleteRes.status, 200);
    const getAfterDelete = await fetch(`${origin}/api/devices/mock.camera.kitchen`, { headers: { cookie } });
    assert.equal(getAfterDelete.status, 404);
  } finally {
    if (handle) await new Promise((r) => handle.server.close(r));
    cleanup(dir);
  }
});
