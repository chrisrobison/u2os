import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { closeAllForTests } from '../server/db/connection.js';
import { getOrCreateDeviceConnectToken } from '../server/devices/realtime/device-token.js';

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-device-token-route-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
async function stop(handle, dir) {
  if (handle) await new Promise((r) => handle.server.close(r));
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}
function base(handle) {
  return `http://127.0.0.1:${handle.port}`;
}

test('GET /api/devices/connect-token requires auth and returns the persisted token', async () => {
  const dir = home();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = base(handle);

    const unauth = await fetch(`${origin}/api/devices/connect-token`);
    assert.equal(unauth.status, 401);

    const setup = await fetch(`${origin}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
    });
    const cookie = setup.headers.get('set-cookie').split(';')[0];

    const res = await fetch(`${origin}/api/devices/connect-token`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.token, getOrCreateDeviceConnectToken(dir));
    assert.equal(body.token.length >= 32, true);
  } finally {
    await stop(handle, dir);
  }
});
