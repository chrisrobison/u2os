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

test('conditional personal setup saves encrypted key and hot-reloads the running planner without a restart or probing', () => fixture(async ({ home, api, restart }) => {
  const initial = await api(); assert.equal(initial.runtimePlannerStatus, 'configuration-required'); assert.equal(initial.restartRequired, false);
  assert.match(initial.configurationRevision, /^[a-f0-9]{64}$/);
  const saved = await api({ ...single, apiKey: 'fixture-only-model-secret', configurationRevision: initial.configurationRevision });
  assert.equal(saved.reloaded, true); assert.equal(saved.restartRequired, false);
  const pending = await api(); assert.equal(pending.plannerStatus, 'configured'); assert.equal(pending.runtimePlannerStatus, 'configured'); assert.equal(pending.restartRequired, false);
  assert.notEqual(pending.configurationRevision, initial.configurationRevision); assert.equal(pending.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(pending).includes('fixture-only-model-secret'));
  assert.ok(!fs.readFileSync(path.join(home, 'config', 'config.json'), 'utf8').includes('fixture-only-model-secret'));
  assert.equal(readEncryptedFile('model-openai-compatible', home).apiKey, 'fixture-only-model-secret');
  // A real restart still lands on the same configuration.
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

test('current revision retains blank existing key, rejects mock and invalid payload without writes, and hot-reloads same-config secret edits', () => fixture(async ({ home, api, restart, snapshot }) => {
  await api({ ...single, apiKey: 'fixture-original-key' }); await restart();
  const current = await api(), before = snapshot();
  await api({ provider: 'mock', configurationRevision: current.configurationRevision }, 400);
  await api({ provider: 'openai-compatible', configurationRevision: current.configurationRevision }, 400);
  assert.deepEqual(snapshot(), before); assert.equal((await api()).restartRequired, false);
  await api({ ...single, configurationRevision: current.configurationRevision, apiKey: '' });
  assert.equal(readEncryptedFile('model-openai-compatible', home).apiKey, 'fixture-original-key');
  assert.equal((await api()).restartRequired, false);
  await restart(); const same = await api();
  await api({ ...single, apiKey: 'fixture-replacement-key', configurationRevision: same.configurationRevision });
  const changed = await api(); assert.equal(changed.configurationRevision, same.configurationRevision); assert.equal(changed.restartRequired, false);
  assert.equal(changed.runtimePlannerStatus, 'configured'); assert.equal(readEncryptedFile('model-openai-compatible', home).apiKey, 'fixture-replacement-key');
}));

test('legacy unconditional owner API remains compatible and conditional current revision can update advanced configuration', () => fixture(async ({ api, home, snapshot, restart }) => {
  await api(single);
  const current = await api();
  await api({ provider: 'anthropic', model: 'fixture-anthropic' });
  await api({ ...single, configurationRevision: current.configurationRevision }, 409);
  const latest = await api();
  await api({ providers: { named: { type: 'openai-compatible', baseUrl: single.baseUrl, model: 'fixture-role' } }, roles: { planner: 'named' }, configurationRevision: latest.configurationRevision });
  assert.equal((await api()).roles.planner, 'named');
  await restart(); const original = await api(); assert.equal(original.restartRequired, false);
  // Isolated owner file edit: credential *reference* is configuration, not a
  // secret value. It must change the revision/restart signal even though GET
  // still omits the reference itself. Never read a referenced real credential.
  const file = path.join(home, 'config', 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.model.providers.named.apiKeyRef = 'fixture-new-key-reference'; fs.writeFileSync(file, JSON.stringify(config));
  const changed = await api(); assert.notEqual(changed.configurationRevision, original.configurationRevision); assert.equal(changed.restartRequired, true);
  assert.ok(!JSON.stringify(changed).includes('fixture-new-key-reference'));
  const before = snapshot(); await api({ ...single, configurationRevision: original.configurationRevision }, 409); assert.deepEqual(snapshot(), before);
}));

test('a save swaps the live router: the next resolve() uses the new provider and key, never a cached one', () => fixture(async ({ api, handle }) => {
  const router = handle().modelRouter;
  assert.throws(() => router.resolve('planner'), (error) => error.code === 'MODEL_UNAVAILABLE');
  const first = await api({ ...single, apiKey: 'fixture-first-key' });
  assert.equal(first.reloaded, true);
  const before = router.resolve('planner');
  assert.equal(before.model, single.model); assert.equal(before.apiKey, 'fixture-first-key');
  assert.equal(router.resolve('planner'), before, 'resolves within one config are still cached');
  // Same provider name and same model, different key only: must not reuse the cache.
  await api({ ...single, apiKey: 'fixture-second-key' });
  const rekeyed = router.resolve('planner');
  assert.notEqual(rekeyed, before); assert.equal(rekeyed.apiKey, 'fixture-second-key');
  await api({ ...single, model: 'fixture-other-model' });
  const swapped = router.resolve('planner');
  assert.equal(swapped.model, 'fixture-other-model'); assert.equal(swapped.apiKey, 'fixture-second-key');
  // The provider a call already holds is untouched by later reloads.
  assert.equal(before.model, single.model); assert.equal(before.apiKey, 'fixture-first-key');
}));

test('a multi-provider save hot-reloads roles and fallback', () => fixture(async ({ api, handle }) => {
  const router = handle().modelRouter;
  await api({ providers: { local: { type: 'openai-compatible', baseUrl: single.baseUrl, model: 'fixture-local' }, hosted: { type: 'anthropic', model: 'fixture-hosted', apiKey: 'fixture-hosted-key' } },
    roles: { planner: 'local' }, fallback: 'hosted' });
  assert.equal(router.resolve('planner').model, 'fixture-local');
  assert.equal(router.resolveFallback('planner').model, 'fixture-hosted');
  assert.equal(router.resolveFallback('planner').apiKey, 'fixture-hosted-key');
  assert.equal((await api()).restartRequired, false);
}));

test('a save the running router cannot adopt keeps the previous planner and honestly reports restart-required until a later save succeeds', () => fixture(async ({ api, handle }) => {
  const router = handle().modelRouter, realReload = router.reload;
  await api({ ...single, apiKey: 'fixture-good-key' });
  const good = router.resolve('planner');
  router.reload = () => { throw new Error('fixture reload failure'); };
  const failed = await api({ ...single, model: 'fixture-unadopted-model' });
  assert.equal(failed.configured, true); assert.equal(failed.reloaded, false); assert.equal(failed.restartRequired, true);
  assert.equal(router.resolve('planner'), good, 'the previous planner keeps serving');
  const status = await api();
  assert.equal(status.restartRequired, true); assert.equal(status.model, 'fixture-unadopted-model');
  router.reload = realReload;
  const recovered = await api({ ...single, model: 'fixture-adopted-model' });
  assert.equal(recovered.reloaded, true); assert.equal(recovered.restartRequired, false);
  assert.equal(router.resolve('planner').model, 'fixture-adopted-model'); assert.equal((await api()).restartRequired, false);
}));

test('hot reload never loosens the personal-mode mock restriction and re-resolves the embeddings provider', () => fixture(async ({ api, handle }) => {
  const router = handle().modelRouter, assembler = handle().agent.contextAssembler;
  await api({ provider: 'mock' }, 400);
  await api({ providers: { p: { type: 'mock' } }, roles: { planner: 'p' } }, 400);
  assert.equal(router.allowMock, false);
  assert.equal(assembler.embeddingProvider, null);
  await api({ providers: { chat: { type: 'openai-compatible', baseUrl: single.baseUrl, model: 'fixture-chat' }, emb: { type: 'embedding-openai-compatible', baseUrl: single.baseUrl, model: 'fixture-embed' } },
    roles: { planner: 'chat', embeddings: 'emb' } });
  assert.equal(router.allowMock, false);
  assert.equal(assembler.embeddingProvider?.model, 'fixture-embed');
  // Dropping the embeddings role turns semantic ranking back off.
  await api({ ...single });
  assert.equal(assembler.embeddingProvider, null);
}));
