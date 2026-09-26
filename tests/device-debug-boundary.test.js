import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { closeAllForTests, getDb } from '../server/db/connection.js';

async function fixture(options, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-device-debug-'));
  process.env.U2OS_HOME = dir;
  let handle;
  try {
    handle = await startServer({ port: 0, mode: 'demo', ...options });
    const base = `http://127.0.0.1:${handle.port}`;
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'fixture-only correct horse battery staple' }) });
    const auth = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-u2os-csrf': auth.csrfToken };
    await run({ handle, base, headers });
  } finally {
    if (handle) { handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve)); await handle.stopActionQueue(); }
    closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
  }
}
const routes = [
  ['/api/capabilities/temperature.read/invoke', { args: {}, developmentMode: true }],
  ['/api/devices/mock.sensor.temperature.office/test', { capability: 'temperature.read', developmentMode: true }],
  ['/api/devices/mock.camera.kitchen/streams/main/open', { developmentMode: true }],
];
async function denyAll({ handle, base, headers }) {
  let invoked = 0;
  const adapter = handle.deviceRegistry.getAdapter('mock');
  adapter.invoke = async () => { invoked++; throw new Error('must not invoke'); };
  adapter.getStream = async () => { invoked++; throw new Error('must not open'); };
  for (const [route, body] of routes) {
    const response = await fetch(`${base}${route}?developmentMode=true`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 403);
    const result = await response.json();
    assert.equal(result.code, 'device_debug_disabled');
    assert.equal(result.attempted, false);
  }
  assert.equal(invoked, 0);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM events WHERE type IN ('capability.invoked', 'capability.failed', 'stream.available')").get().n, 0);
  assert.equal((await (await fetch(`${base}/api/devices`, { headers })).json()).debugActionsEnabled, false);
}

test('raw device paths default to not attempted while discovery, metadata and policy-gated tools remain usable', async () => {
  const saved = process.env.U2OS_DEVELOPMENT_MODE;
  delete process.env.U2OS_DEVELOPMENT_MODE;
  try { await fixture({}, async (context) => {
    await denyAll(context);
    const { handle, base, headers } = context;
    assert.equal((await fetch(`${base}/api/devices/mock.camera.kitchen/streams`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/devices/mock.camera.kitchen`, { method: 'PATCH', headers, body: '{"name":"Fixture renamed camera"}' })).status, 200);
    handle.policyEngine.policies = { presentation: { present: 'confirm' } };
    const outcome = await handle.agent.evaluateAndMaybeExecute({ tool: 'presentation.present', arguments: { audience: 'owner', content: { text: 'Fixture content' } },
      requestedBy: 'owner', correlationId: 'debug_boundary_policy', requestText: 'Show fixture content' });
    assert.equal(outcome.status, 'pending');
    assert.equal(getDb().prepare('SELECT status FROM agent_actions WHERE id = ?').get(outcome.id).status, 'pending');
  }); } finally { if (saved === undefined) delete process.env.U2OS_DEVELOPMENT_MODE; else process.env.U2OS_DEVELOPMENT_MODE = saved; }
});

test('explicit development routes still require session/CSRF and refuse revoked devices', async () => {
  await fixture({ developmentMode: true }, async ({ handle, base, headers }) => {
    for (const [route, body] of routes) {
      assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
      assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, 'x-u2os-csrf': 'wrong' }, body: JSON.stringify(body) })).status, 403);
      assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
    }
    assert.equal((await (await fetch(`${base}/api/devices`, { headers })).json()).debugActionsEnabled, true);
    handle.deviceRegistry.setTrust('mock.sensor.temperature.office', 'revoked');
    handle.deviceRegistry.setTrust('mock.camera.kitchen', 'revoked');
    const before = getDb().prepare("SELECT COUNT(*) n FROM events WHERE type IN ('capability.invoked', 'stream.available')").get().n;
    for (const [route, body] of routes) assert.ok((await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) })).status >= 400);
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM events WHERE type IN ('capability.invoked', 'stream.available')").get().n, before);
  });
});

test('production ignores development opt-in and non-boolean programmatic flags fail closed', async () => {
  const savedMode = process.env.NODE_ENV;
  const savedDebug = process.env.U2OS_DEVELOPMENT_MODE;
  try {
    process.env.NODE_ENV = 'production'; process.env.U2OS_DEVELOPMENT_MODE = '1';
    await fixture({ developmentMode: true }, denyAll);
    process.env.NODE_ENV = 'test';
    await fixture({ developmentMode: 'true' }, denyAll);
    await fixture({}, async ({ base, headers }) => {
      assert.equal((await (await fetch(`${base}/api/devices`, { headers })).json()).debugActionsEnabled, true, 'explicit env flag enables non-production development');
    });
  } finally {
    if (savedMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedMode;
    if (savedDebug === undefined) delete process.env.U2OS_DEVELOPMENT_MODE; else process.env.U2OS_DEVELOPMENT_MODE = savedDebug;
  }
});
