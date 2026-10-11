import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTiers } from '../server/jobhunt/llm.js';
import { loadModelsConfig } from '../mcp/jobs/hunt/llm/models.js';

// local_fallback (#545): when every cloud connection fails, writing steps may
// use the local model; the judgement tier never does.

function vaultWith(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-fb-'));
  fs.mkdirSync(path.join(dir, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'job-hunt', 'models.yaml'), models);
  return dir;
}

const FAST = 'fast:\n  provider: lmstudio\n  base_url: http://127.0.0.1:1234\n  model: qwen/test\n';
const limited = (id) => ({ id, complete: async () => { throw new Error('You have hit your usage limit'); } });
const router = (...providers) => ({ resolve: () => providers[0], resolveFallbacks: () => providers.slice(1) });
const answer = (text) => async () => ({ ok: true, status: 200, json: async () => ({ output: [{ type: 'message', content: text }] }) });
const ok = { system: 'Reply with JSON.', user: 'go', validate: (value) => value };

test('local_fallback defaults off and needs a fast model', () => {
  assert.equal(loadModelsConfig(vaultWith(FAST)).local_fallback, false);
  assert.equal(loadModelsConfig(vaultWith(`${FAST}local_fallback: true\n`)).local_fallback, true);
  assert.throws(() => loadModelsConfig(vaultWith('local_fallback: true\n')), /needs a fast model/);
  assert.throws(() => loadModelsConfig(vaultWith(`${FAST}local_fallback: yes please\n`)), /true or false/);
});

test('without local_fallback a rate-limited cloud chain fails and quality is the judge', async () => {
  const vaultDir = vaultWith(FAST);
  const tiers = createTiers({ vaultDir, dataDir: vaultDir, router: router(limited('cli:codex'), limited('cli:claude')), fetchImpl: answer('{"a":1}') });
  assert.equal(tiers.quality, tiers.judge);
  assert.deepEqual(tiers.quality.providers, ['cli:codex', 'cli:claude']);
  await assert.rejects(tiers.quality.json(ok));
});

test('with local_fallback the quality tier falls through to the local model and the judge never does', async () => {
  const vaultDir = vaultWith(`${FAST}local_fallback: true\n`);
  const tiers = createTiers({ vaultDir, dataDir: vaultDir, router: router(limited('cli:codex'), limited('cli:claude')), fetchImpl: answer('{"a":1}') });
  assert.deepEqual(tiers.quality.providers, ['cli:codex', 'cli:claude', 'lmstudio:qwen/test']);
  assert.deepEqual(tiers.judge.providers, ['cli:codex', 'cli:claude']);
  const result = await tiers.quality.json(ok);
  assert.deepEqual(result.value, { a: 1 });
  assert.equal(result.model, 'lmstudio:qwen/test');
  await assert.rejects(tiers.judge.json(ok), 'confirmation and review pause instead of using the local model');
});

test('a working cloud model is still used first', async () => {
  const vaultDir = vaultWith(`${FAST}local_fallback: true\n`);
  const good = { id: 'cli:codex', complete: async () => '{"b":2}' };
  const tiers = createTiers({ vaultDir, dataDir: vaultDir, router: router(good, limited('cli:claude')), fetchImpl: answer('{"a":1}') });
  assert.equal((await tiers.quality.json(ok)).model, 'cli:codex');
});
