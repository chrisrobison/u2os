import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { startServer } from '../server/index.js';
import { DeviceRegistry } from '../server/devices/device-registry.js';
import { MockDeviceAdapter } from '../server/devices/adapters/mock-device-adapter.js';
import { createCapabilityRegistry } from '../server/devices/register-capabilities.js';
import { explainResolution } from '../server/devices/capability-resolver.js';

async function home(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-personal-devices-'));
  process.env.U2OS_HOME = dir;
  const handles = [];
  const start = async (options = {}) => { const handle = await startServer({ port: 0, ...options }); handles.push(handle); return handle; };
  const stop = async (handle) => {
    handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve));
    await handle.stopActionQueue(); await handle.deviceRegistry.stopAll();
    handles.splice(handles.indexOf(handle), 1);
  };
  try { await fn({ start, stop }); }
  finally { for (const handle of [...handles]) await stop(handle); closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}
function realAdapter(invoke = async () => ({ delivered: true })) {
  return { id: 'fixture-real', start: async () => {}, stop: async () => {},
    discover: async () => [{ id: 'fixture.display', name: 'Owner fixture display', type: 'display', owner: 'owner', trust: 'trusted', capabilities: ['ui.render'] }], invoke };
}
async function auth(handle) {
  const base = `http://127.0.0.1:${handle.port}`;
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"passphrase":"fixture-only correct horse battery staple"}' });
  return { base, headers: { cookie: setup.headers.get('set-cookie').split(';')[0] } };
}

test('fresh personal startup never registers mock devices, even with explicit development mode', () => home(async ({ start, stop }) => {
  for (const developmentMode of [false, true]) {
    const handle = await start({ mode: 'personal', developmentMode });
    assert.equal(handle.deviceRegistry.getAdapter('mock'), null);
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM devices WHERE adapter = 'mock'").get().n, 0);
    const result = explainResolution('ui.render', { privacy: 'personal' }, handle);
    assert.equal(result.chosen, null);
    await assert.rejects(handle.toolRegistry.get('presentation.present').execute({ audience: 'owner', content: { text: 'fixture content' } },
      { correlationId: 'fresh_personal_presentation', eventBus: handle.eventBus }), /No eligible device/);
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM events WHERE type = 'capability.invoked'").get().n, 0);
    await stop(handle);
  }
}));

test('legacy cached mock and real rows retain owner edits and trust but missing adapters cannot resolve or deliver', () => home(async ({ start, stop }) => {
  const registry = new DeviceRegistry({ db: getDb(), capabilityRegistry: createCapabilityRegistry() });
  await registry.registerAdapter(new MockDeviceAdapter()); await registry.registerAdapter(realAdapter());
  registry.updateDevice('mock.camera.kitchen', { name: 'Kept owner edit', owner: 'owner' });
  registry.setTrust('mock.phone.chris', 'revoked');
  registry.updateDevice('fixture.display', { name: 'Kept real display', location: 'office' });
  const original = getDb().prepare('SELECT * FROM devices ORDER BY id').all();
  await registry.stopAll(); closeAllForTests();
  const handle = await start();
  assert.equal(handle.deviceRegistry.getAdapter('mock'), null);
  assert.deepEqual(getDb().prepare("SELECT * FROM devices WHERE adapter IN ('mock', 'fixture-real') ORDER BY id").all(), original);
  const explanation = explainResolution('ui.render', { privacy: 'public' }, handle);
  assert.equal(explanation.chosen, null);
  assert.ok(explanation.candidates.find((item) => item.device === 'fixture.display').reasons.includes('adapter is unavailable; device record is cached'));
  await assert.rejects(handle.toolRegistry.get('presentation.present').execute({ audience: 'owner', privacy: 'public', content: { text: 'fixture' } },
    { correlationId: 'legacy_presentation', eventBus: handle.eventBus }), /No eligible device/);
  const session = await auth(handle);
  const records = (await (await fetch(`${session.base}/api/devices`, { headers: session.headers })).json()).devices;
  assert.equal(records.find((device) => device.id === 'mock.camera.kitchen').mock, true);
  assert.equal(records.find((device) => device.id === 'mock.camera.kitchen').adapterAvailable, false);
  assert.equal(records.find((device) => device.id === 'fixture.display').adapterAvailable, false);
  const detail = await (await fetch(`${session.base}/api/devices/fixture.display`, { headers: session.headers })).json();
  assert.equal(detail.name, 'Kept real display'); assert.equal(detail.adapterAvailable, false);
  await stop(handle); closeAllForTests();
  const restarted = await start();
  assert.deepEqual(getDb().prepare("SELECT * FROM devices WHERE adapter IN ('mock', 'fixture-real') ORDER BY id").all(), original);
  assert.equal(explainResolution('ui.render', { privacy: 'public' }, restarted).chosen, null);
}));

test('personal real adapter failure is retained as failure without mock substitution; available real adapters still route', () => home(async ({ start }) => {
  const handle = await start({ mode: 'personal' });
  let attempted = 0;
  await handle.deviceRegistry.registerAdapter(realAdapter(async () => { attempted++; throw new Error('fixture real device offline'); }));
  const tool = handle.toolRegistry.get('presentation.present');
  const args = { audience: 'owner', privacy: 'personal', content: { text: 'fixture content' } };
  await assert.rejects(tool.execute(args, { correlationId: 'failed_real_display', eventBus: handle.eventBus }), /fixture real device offline/);
  assert.equal(attempted, 1);
  assert.equal(handle.deviceRegistry.getAdapter('mock'), null);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM events WHERE type = 'capability.invoked'").get().n, 0);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM events WHERE type = 'capability.failed'").get().n, 1);
  handle.deviceRegistry.getAdapter('fixture-real').invoke = async () => ({ delivered: true, fixture: true });
  const result = await tool.execute(args, { correlationId: 'available_real_display', eventBus: handle.eventBus });
  assert.equal(result.device, 'fixture.display'); assert.equal(result.delivered, true);
}));

test('isolated demo startup still provides reproducible mock records with explicit API provenance', () => home(async ({ start, stop }) => {
  const handle = await start({ mode: 'demo' });
  assert.ok(handle.deviceRegistry.getAdapter('mock'));
  const session = await auth(handle);
  const records = (await (await fetch(`${session.base}/api/devices`, { headers: session.headers })).json()).devices.filter((device) => device.mock);
  assert.equal(records.length, 5); assert.ok(records.every((device) => device.adapterAvailable));
  const ids = records.map((device) => device.id).sort();
  await stop(handle); closeAllForTests();
  const restarted = await start();
  assert.deepEqual(restarted.deviceRegistry.listDevices().filter((device) => device.adapter === 'mock').map((device) => device.id).sort(), ids);
  assert.ok(restarted.deviceRegistry.getAdapter('mock'));
}));
