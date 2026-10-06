import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { closeAllForTests } from '../server/db/connection.js';
import { fileURLToPath } from 'node:url';
import { getVaultDir } from '../server/vault/vault-dir.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'addon-fake-server.js');

const MANIFEST = () => `apiVersion: u2os/v1
kind: Addon
metadata: { id: demo, name: Demo, version: 0.1.0 }
servers:
  demo:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(FAKE)}]
    tools:
      read_thing: { tool: mail, fixed: { operation: unread }, read: true, classification: personal }
      send_thing: { tool: mail, fixed: { operation: send } }
settings:
  limit: { type: number, default: 5 }
  mode: { type: string, enum: [a, b], default: a }
`;

test('add-on API: list, enable, confirm tools, settings; writes the vault addons.yaml; rejects bad input', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-addon-api-'));
  const previous = process.env.U2OS_HOME; process.env.U2OS_HOME = home;
  fs.mkdirSync(path.join(home, 'addons', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(home, 'addons', 'demo', 'addon.yaml'), MANIFEST());
  fs.mkdirSync(path.join(home, 'addons', 'busted'), { recursive: true });
  fs.writeFileSync(path.join(home, 'addons', 'busted', 'addon.yaml'), 'kind: Nope');
  const handle = await startServer({ port: 0 });
  const origin = `http://127.0.0.1:${handle.port}`;
  try {
    const anon = await fetch(`${origin}/api/addons`); assert.equal(anon.status, 401);
    const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'fixture-only addon api owner phrase' }) });
    const headers = { cookie: setup.headers.get('set-cookie').split(';')[0], origin, 'x-u2os-csrf': (await setup.json()).csrfToken, 'Content-Type': 'application/json' };
    const call = async (method, url, body, expected = 200) => {
      const r = await fetch(`${origin}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      const json = await r.json(); assert.equal(r.status, expected, JSON.stringify(json)); return json;
    };
    const list = await call('GET', '/api/addons');
    const demo = list.addons.find((a) => a.id === 'demo');
    assert.equal(demo.enabled, false); assert.equal(demo.state, 'available');
    assert.equal(list.addons.find((a) => a.id === 'busted').state, 'invalid');
    assert.ok(!JSON.stringify(list).includes(path.join(home, 'addons')), 'add-on folder paths are not exposed');

    await call('PUT', '/api/addons/busted', { enabled: true }, 404);
    await call('PUT', '/api/addons/Bad-Id', { enabled: true }, 400);
    await call('PUT', '/api/addons/demo', { enabled: 'yes' }, 400);
    await call('PUT', '/api/addons/demo', { surprise: 1 }, 400);
    await call('PUT', '/api/addons/demo', { settings: { nope: 1 } }, 400);
    await call('PUT', '/api/addons/demo', { settings: { limit: 'ten' } }, 400);
    await call('PUT', '/api/addons/demo', { settings: { mode: 'z' } }, 400);
    await call('PUT', '/api/addons/demo', { confirmTools: { ghost: { read: true, classification: 'public' } } }, 400);
    await call('PUT', '/api/addons/demo', { confirmTools: { read_thing: { read: true } } }, 400);
    assert.equal(fs.existsSync(path.join(getVaultDir(), 'addons.yaml')), false, 'rejected requests write nothing');

    const enabled = await call('PUT', '/api/addons/demo', { enabled: true, settings: { limit: 12 }, confirmTools: { read_thing: { read: true, classification: 'personal' } } });
    assert.equal(enabled.addon.enabled, true);
    assert.equal(enabled.addon.runtime[0].state, 'running', 'enabling starts the add-on\'s tool server');
    assert.deepEqual(enabled.addon.runtime[0].tools.sort(), ['demo.read_thing', 'demo.send_thing']);
    const tools = enabled.addon.servers[0].tools;
    assert.deepEqual(tools.find((t) => t.name === 'read_thing').effective, { read: true, classification: 'personal' });
    assert.deepEqual(tools.find((t) => t.name === 'send_thing').effective, { read: false, classification: 'private' });
    assert.equal(enabled.addon.settings.find((s) => s.key === 'limit').value, 12);
    const file = fs.readFileSync(path.join(getVaultDir(), 'addons.yaml'), 'utf8');
    assert.match(file, /enabled: true/); assert.match(file, /classification: personal/);

    const off = await call('PUT', '/api/addons/demo', { enabled: false, unconfirmTools: ['read_thing'] });
    assert.equal(off.addon.enabled, false);
    assert.deepEqual(off.addon.runtime, [], 'disabling stops it');
    assert.equal(off.addon.servers[0].tools.find((t) => t.name === 'read_thing').confirmed, false);

    // a hand-broken addons.yaml refuses writes and enables nothing
    fs.writeFileSync(path.join(getVaultDir(), 'addons.yaml'), 'addons: [');
    const broken = await call('GET', '/api/addons'); assert.ok(broken.decisionsError);
    await call('PUT', '/api/addons/demo', { enabled: true }, 409);
    assert.equal(fs.readFileSync(path.join(getVaultDir(), 'addons.yaml'), 'utf8'), 'addons: [');
  } finally {
    await handle.shutdown(); closeAllForTests();
    if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
