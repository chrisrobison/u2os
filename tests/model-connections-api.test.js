import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { closeAllForTests } from '../server/db/connection.js';
import { readEncryptedFile } from '../server/security/vault.js';

test('ordered API and CLI connections: save, view, test, reorder, keys stay in the vault', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-connections-'));
  const previous = process.env.U2OS_HOME; process.env.U2OS_HOME = home;
  const script = path.join(home, 'fake-model.js');
  fs.writeFileSync(script, "process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log(JSON.stringify({reasoning_summary:'ok',actions:[]})));");
  const handle = await startServer({ port: 0 });
  const origin = `http://127.0.0.1:${handle.port}`;
  try {
    const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'fixture-only connections owner phrase' }) });
    assert.equal(setup.status, 201);
    const headers = { cookie: setup.headers.get('set-cookie').split(';')[0], origin, 'x-u2os-csrf': (await setup.json()).csrfToken, 'Content-Type': 'application/json' };
    const call = async (method, url, body, expected = 200) => {
      const response = await fetch(`${origin}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      const json = await response.json(); assert.equal(response.status, expected, JSON.stringify(json)); return json;
    };
    const before = await call('GET', '/api/model');
    assert.deepEqual(before.connections, []);
    assert.equal(before.cliPresets.claude.executable, 'claude');
    const connections = [
      { id: 'fake', type: 'cli', preset: 'custom', executable: process.execPath, args: [script], timeoutMs: 20000, destination: 'local_model' },
      { id: 'hosted', type: 'anthropic', model: 'claude-test', apiKey: 'fixture-only-connection-secret' },
    ];
    const saved = await call('PUT', '/api/model/connections', { connections, configurationRevision: before.configurationRevision });
    assert.equal(saved.reloaded, true); assert.equal(saved.restartRequired, false);
    assert.deepEqual(saved.connections.map((c) => c.id), ['fake', 'hosted']);
    const view = await call('GET', '/api/model');
    assert.equal(view.plannerStatus, 'configured'); assert.equal(view.runtimePlannerStatus, 'configured');
    assert.equal(view.connections[1].keyConfigured, true);
    assert.ok(!JSON.stringify(view).includes('fixture-only-connection-secret'));
    assert.ok(!fs.readFileSync(path.join(home, 'config', 'config.json'), 'utf8').includes('fixture-only-connection-secret'));
    assert.equal(readEncryptedFile('model-provider-hosted', home).apiKey, 'fixture-only-connection-secret');
    // stale revision is refused
    await call('PUT', '/api/model/connections', { connections, configurationRevision: before.configurationRevision }, 409);
    // test the CLI connection end to end (the fake prints a plan)
    const installed = await call('POST', '/api/model/connections/test', { id: 'fake' });
    assert.equal(installed.ok, true);
    const prompted = await call('POST', '/api/model/connections/test', { id: 'fake', sendPrompt: true });
    assert.equal(prompted.ok, true); assert.equal(prompted.stage, 'prompt');
    await call('POST', '/api/model/connections/test', { id: 'nope' }, 404);
    // reorder; a blank key keeps the stored one
    const reordered = await call('PUT', '/api/model/connections', { connections: [{ id: 'hosted', type: 'anthropic', model: 'claude-test' }, connections[0]] });
    assert.deepEqual(reordered.connections.map((c) => c.id), ['hosted', 'fake']);
    assert.equal(reordered.connections[0].keyConfigured, true);
    // invalid input leaves configuration untouched
    await call('PUT', '/api/model/connections', { connections: [{ id: 'x', type: 'cli', preset: 'custom', executable: 'bad cmd' }] }, 400);
    assert.deepEqual((await call('GET', '/api/model')).connections.map((c) => c.id), ['hosted', 'fake']);
  } finally {
    await handle.shutdown(); closeAllForTests();
    if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
