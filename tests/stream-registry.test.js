// Phase 8 (docs/devices.md): the stream registry -- metadata/reference
// only, never a media transport. Demonstrated against MockDeviceAdapter's
// kitchen camera (video.stream capability), per the phase's own
// "demonstrate with a mock stream" instruction.
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
import { StreamRegistry } from '../server/devices/stream-registry.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-stream-test-'));
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
  const streamRegistry = new StreamRegistry({ deviceRegistry, eventBus });
  return { db, eventBus, deviceRegistry, streamRegistry };
}

// --- id / discovery ----------------------------------------------------------

test('streamId() follows the stream://<device>/<name> convention', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry } = await buildRegistry();
    assert.equal(streamRegistry.streamId('mock.camera.kitchen', 'main'), 'stream://mock.camera.kitchen/main');
  } finally {
    cleanup(dir);
  }
});

test('discover() infers a "main" stream for a device with the video.stream capability', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry } = await buildRegistry();
    const streams = streamRegistry.discover('mock.camera.kitchen');
    assert.deepEqual(streams, [{ id: 'stream://mock.camera.kitchen/main', device: 'mock.camera.kitchen', name: 'main' }]);
  } finally {
    cleanup(dir);
  }
});

test('discover() returns an empty list for a device with no streaming capability', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry } = await buildRegistry();
    assert.deepEqual(streamRegistry.discover('mock.sensor.temperature.office'), []);
  } finally {
    cleanup(dir);
  }
});

test('discover() prefers explicit device.metadata.streams over the capability-based default', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry, streamRegistry } = await buildRegistry();
    deviceRegistry.upsertDevice('mock', {
      id: 'mock.camera.multi',
      name: 'Multi-stream Camera',
      type: 'camera',
      capabilities: ['video.stream'],
      metadata: { streams: ['main', 'thermal'] },
    });
    const streams = streamRegistry.discover('mock.camera.multi');
    assert.deepEqual(
      streams.map((s) => s.name),
      ['main', 'thermal']
    );
  } finally {
    cleanup(dir);
  }
});

test('discover() throws for an unknown device', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry } = await buildRegistry();
    assert.throws(() => streamRegistry.discover('nope'), /Unknown device/);
  } finally {
    cleanup(dir);
  }
});

// --- open / close --------------------------------------------------------------

test('open() resolves a reference via the device adapter, records it, and publishes stream.available', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry, eventBus } = await buildRegistry();
    const events = [];
    eventBus.subscribe('stream.available', (e) => events.push(e));

    const opened = await streamRegistry.open('mock.camera.kitchen', 'main');
    assert.equal(opened.id, 'stream://mock.camera.kitchen/main');
    assert.equal(opened.reference.protocol, 'mock');
    assert.match(opened.reference.url, /^stream:\/\/mock\.camera\.kitchen\/main$/);

    assert.equal(events.length, 1);
    assert.equal(events[0].data.streamId, opened.id);

    assert.deepEqual(streamRegistry.getOpen(opened.id), opened);
    assert.deepEqual(streamRegistry.listOpen(), [opened]);
  } finally {
    cleanup(dir);
  }
});

test('open() throws for an unknown device', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry } = await buildRegistry();
    await assert.rejects(() => streamRegistry.open('nope', 'main'), /Unknown device/);
  } finally {
    cleanup(dir);
  }
});

test('open() refuses a revoked device unconditionally, same as every other enforcement path', async () => {
  const dir = tempHome();
  try {
    const { deviceRegistry, streamRegistry } = await buildRegistry();
    deviceRegistry.setTrust('mock.camera.kitchen', 'revoked');
    await assert.rejects(() => streamRegistry.open('mock.camera.kitchen', 'main'), /revoked/);
  } finally {
    cleanup(dir);
  }
});

test('open() propagates the adapter\'s own failure for a stream the device does not actually have', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry } = await buildRegistry();
    // mock.sensor.temperature.office has no video.stream capability --
    // MockDeviceAdapter.getStream() throws for it.
    await assert.rejects(() => streamRegistry.open('mock.sensor.temperature.office', 'main'), /no stream/);
  } finally {
    cleanup(dir);
  }
});

test('close() removes the open entry and publishes stream.closed; closing twice is not an error', async () => {
  const dir = tempHome();
  try {
    const { streamRegistry, eventBus } = await buildRegistry();
    const events = [];
    eventBus.subscribe('stream.closed', (e) => events.push(e));

    const opened = await streamRegistry.open('mock.camera.kitchen', 'main');
    assert.equal(streamRegistry.close(opened.id), true);
    assert.equal(streamRegistry.getOpen(opened.id), null);
    assert.equal(events.length, 1);

    assert.equal(streamRegistry.close(opened.id), false);
    assert.equal(events.length, 1); // no second stream.closed for a no-op close
  } finally {
    cleanup(dir);
  }
});

// --- full-server route pass --------------------------------------------------

test('stream routes: discover, open, list, close', async () => {
  const dir = tempHome();
  let handle;
  try {
    const { startServer } = await import('../server/index.js');
    handle = await startServer({ port: 0, mode: 'demo', developmentMode: true });
    const origin = `http://127.0.0.1:${handle.port}`;
    const setup = await fetch(`${origin}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
    });
    const setupBody = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const writeHeaders = { cookie, origin, 'content-type': 'application/json', 'x-u2os-csrf': setupBody.csrfToken };

    const discoverRes = await fetch(`${origin}/api/devices/mock.camera.kitchen/streams`, { headers: { cookie } });
    assert.equal(discoverRes.status, 200);
    const discovered = await discoverRes.json();
    assert.equal(discovered.streams[0].name, 'main');

    const openRes = await fetch(`${origin}/api/devices/mock.camera.kitchen/streams/main/open`, { method: 'POST', headers: writeHeaders });
    assert.equal(openRes.status, 200);
    const opened = await openRes.json();
    assert.equal(opened.id, 'stream://mock.camera.kitchen/main');

    const listRes = await fetch(`${origin}/api/streams`, { headers: { cookie } });
    const listed = await listRes.json();
    assert.equal(listed.streams.length, 1);

    const closeRes = await fetch(`${origin}/api/streams/close`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ streamId: opened.id }) });
    assert.equal(closeRes.status, 200);
    assert.equal((await closeRes.json()).closed, true);

    const listAfterClose = await fetch(`${origin}/api/streams`, { headers: { cookie } });
    assert.equal((await listAfterClose.json()).streams.length, 0);
  } finally {
    if (handle) await new Promise((r) => handle.server.close(r));
    cleanup(dir);
  }
});
