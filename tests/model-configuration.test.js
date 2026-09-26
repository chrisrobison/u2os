import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { closeAllForTests } from '../server/db/connection.js';
import { readEncryptedFile } from '../server/security/vault.js';

async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-model-configuration-'));
  const previousHome = process.env.U2OS_HOME, nativeFetch = globalThis.fetch;
  process.env.U2OS_HOME = home;
  let handle, origin, headers; const unexpected = [];
  globalThis.fetch = (url, options) => {
    if (origin && String(url).startsWith(`${origin}/`)) return nativeFetch(url, options);
    unexpected.push(String(url)); throw new Error('Model/provider networking is prohibited during configuration');
  };
  const restart = async () => {
    if (handle) { await handle.shutdown(); closeAllForTests(); }
    handle = await startServer({ port: 0 }); origin = `http://127.0.0.1:${handle.port}`;
    if (headers) headers.origin = origin;
  };
  const api = async (body, expected = 200) => {
    const response = await fetch(`${origin}/api/model`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected); return result;
  };
  const snapshot = () => {
    const bytes = {};
    const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file); else bytes[path.relative(home, file)] = fs.readFileSync(file).toString('base64');
    } };
    walk(path.join(home, 'config')); if (fs.existsSync(path.join(home, 'credentials'))) walk(path.join(home, 'credentials')); return bytes;
  };
  try {
    await restart();
    const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'fixture-only model configuration owner' }) });
    assert.equal(setup.status, 201);
    headers = { cookie: setup.headers.get('set-cookie').split(';')[0], origin, 'x-u2os-csrf': (await setup.json()).csrfToken, 'Content-Type': 'application/json' };
    await operation({ home, api, restart, snapshot, handle: () => handle });
    assert.deepEqual(unexpected, []);
  } finally {
    if (handle) await handle.shutdown(); closeAllForTests(); globalThis.fetch = nativeFetch;
    if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const single = { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', model: 'fixture-unreachable-model', timeoutMs: 5000 };

test('conditional personal setup saves encrypted key but distinguishes saved and running planner until restart without probing', () => fixture(async ({ home, api, restart }) => {
  const initial = await api(); assert.equal(initial.runtimePlannerStatus, 'configuration-required'); assert.equal(initial.restartRequired, false);
  assert.match(initial.configurationRevision, /^[a-f0-9]{64}$/);
  const saved = await api({ ...single, apiKey: 'fixture-only-model-secret', configurationRevision: initial.configurationRevision });
  assert.equal(saved.restartRequired, true);
  const pending = await api(); assert.equal(pending.plannerStatus, 'configured'); assert.equal(pending.runtimePlannerStatus, 'configuration-required'); assert.equal(pending.restartRequired, true);
  assert.notEqual(pending.configurationRevision, initial.configurationRevision); assert.equal(pending.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(pending).includes('fixture-only-model-secret'));
  assert.ok(!fs.readFileSync(path.join(home, 'config', 'config.json'), 'utf8').includes('fixture-only-model-secret'));
  assert.equal(readEncryptedFile('model-openai-compatible', home).apiKey, 'fixture-only-model-secret');
  await restart(); const current = await api(); assert.equal(current.configurationRevision, pending.configurationRevision); assert.equal(current.runtimePlannerStatus, 'configured'); assert.equal(current.restartRequired, false);
}));

test('stale and malformed conditional saves cannot overwrite newer advanced roles or credentials', () => fixture(async ({ home, api, snapshot }) => {
  const initial = await api();
  await api({ providers: { planner: { type: 'openai-compatible', baseUrl: single.baseUrl, model: 'advanced-fixture', apiKey: 'fixture-advanced-secret' } }, roles: { planner: 'planner', response: 'planner' } });
  const before = snapshot(), advanced = await api();
  for (const revision of [initial.configurationRevision, null, {}, 7, '', 'fixture-invalid']) {
    const failure = await api({ ...single, apiKey: 'fixture-unwanted-secret', configurationRevision: revision }, 409);
    assert.match(failure.error, /configuration changed/); assert.deepEqual(snapshot(), before);
    assert.equal(readEncryptedFile('model-openai-compatible', home), null);
  }
  assert.deepEqual((await api()).roles, advanced.roles); assert.equal(readEncryptedFile('model-provider-planner', home).apiKey, 'fixture-advanced-secret');
}));

test('current revision retains blank existing key, rejects mock and invalid payload without writes, and marks same-config secret edits restart-required', () => fixture(async ({ home, api, restart, snapshot }) => {
  await api({ ...single, apiKey: 'fixture-original-key' }); await restart();
  const current = await api(), before = snapshot();
  await api({ provider: 'mock', configurationRevision: current.configurationRevision }, 400);
  await api({ provider: 'openai-compatible', configurationRevision: current.configurationRevision }, 400);
  assert.deepEqual(snapshot(), before); assert.equal((await api()).restartRequired, false);
  await api({ ...single, configurationRevision: current.configurationRevision, apiKey: '' });
  assert.equal(readEncryptedFile('model-openai-compatible', home).apiKey, 'fixture-original-key');
  assert.equal((await api()).restartRequired, true);
  await restart(); const same = await api();
  await api({ ...single, apiKey: 'fixture-replacement-key', configurationRevision: same.configurationRevision });
  const changed = await api(); assert.equal(changed.configurationRevision, same.configurationRevision); assert.equal(changed.restartRequired, true);
  assert.equal(changed.runtimePlannerStatus, 'configured'); assert.equal(readEncryptedFile('model-openai-compatible', home).apiKey, 'fixture-replacement-key');
}));

test('legacy unconditional owner API remains compatible and conditional current revision can update advanced configuration', () => fixture(async ({ api }) => {
  await api(single);
  const current = await api();
  await api({ provider: 'anthropic', model: 'fixture-anthropic' });
  await api({ ...single, configurationRevision: current.configurationRevision }, 409);
  const latest = await api();
  await api({ providers: { named: { type: 'openai-compatible', baseUrl: single.baseUrl, model: 'fixture-role' } }, roles: { planner: 'named' }, configurationRevision: latest.configurationRevision });
  assert.equal((await api()).roles.planner, 'named');
}));
