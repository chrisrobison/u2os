import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LmStudioProvider } from '../server/agent/lmstudio-provider.js';
import { loadModelsConfig, setFastModel } from '../mcp/jobs/hunt/llm/models.js';
import { createLlm } from '../mcp/jobs/hunt/llm/structured.js';
import { Autopilot } from '../server/jobhunt/autopilot.js';
import { openStore, huntDbPath } from '../mcp/jobs/hunt/storage/store.js';
import { RESUME, fakeLlm } from './fixtures/job-hunt-candidate.js';

const KEY = 'sk-lm-TESTKEY:do-not-leak-this-secret';

function fakeLmStudio(handler = null) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `Invalid LM Studio API token provided: ${KEY}` } })); }
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qwen/qwen3.5-9b' }] })); }
      if (handler) return handler(req, res, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model_instance_id: body.model, output: [{ type: 'message', content: '<think>hidden reasoning</think>{"ok":true}' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }) })));
}

test('the LM Studio provider speaks the native API with reasoning off, strips thinking, and never leaks the key', async (t) => {
  const lm = await fakeLmStudio();
  t.after(() => lm.close());
  const provider = new LmStudioProvider({ baseUrl: lm.url, model: 'qwen/qwen3.5-9b', apiKey: KEY });
  assert.equal(provider.destination, 'local_model');
  assert.equal(await provider.complete('SYSTEM', 'USER'), '{"ok":true}', 'the chain of thought is not the answer');
  const sent = lm.requests.at(-1);
  assert.equal(sent.path, '/api/v1/chat');
  assert.equal(sent.auth, `Bearer ${KEY}`);
  assert.deepEqual([sent.body.model, sent.body.system_prompt, sent.body.input, sent.body.reasoning, sent.body.stream, sent.body.temperature], ['qwen/qwen3.5-9b', 'SYSTEM', 'USER', 'off', false, 0]);
  await assert.rejects(provider.plan(), /text prompts only/);

  const wrong = new LmStudioProvider({ baseUrl: lm.url, model: 'qwen/qwen3.5-9b', apiKey: 'sk-lm-WRONG:wrong-wrong-wrong' });
  const error = await wrong.complete('s', 'u').catch((e) => e);
  assert.match(error.message, /rejected the credentials/);
  for (const text of [error.message, JSON.stringify(error), String(error.stack)]) assert.ok(!text.includes('WRONG') && !text.includes(KEY), 'no key in errors');
  assert.deepEqual(await provider.probe(), { available: true });
  assert.deepEqual(await wrong.probe(), { available: false, reason: 'the server rejected the credentials' });
  assert.match((await new LmStudioProvider({ baseUrl: lm.url, model: 'not/loaded', apiKey: KEY }).probe()).reason, /not available on the server/);
  assert.match((await new LmStudioProvider({ baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: KEY }).probe()).reason, /could not be reached/);
  assert.throws(() => new LmStudioProvider({ baseUrl: 'ftp://x', model: 'm' }), /http\(s\)/);
});

test('provider failures are plain and bounded: not JSON, no answer, a server error, a timeout', async (t) => {
  let mode = 'ok';
  const lm = await fakeLmStudio((req, res) => {
    if (mode === 'html') { res.writeHead(200); return res.end('<html>'); }
    if (mode === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ output: [{ type: 'reasoning', content: 'x' }] })); }
    if (mode === 'error') { res.writeHead(500); return res.end('boom'); }
    if (mode === 'hang') return undefined;
    return undefined;
  });
  t.after(() => lm.close());
  const provider = (over = {}) => new LmStudioProvider({ baseUrl: lm.url, model: 'm', apiKey: KEY, timeoutMs: 300, ...over });
  mode = 'html'; await assert.rejects(provider().complete('s', 'u'), /not JSON/);
  mode = 'empty'; await assert.rejects(provider().complete('s', 'u'), /returned no answer/);
  mode = 'error'; await assert.rejects(provider().complete('s', 'u'), /answered 500/);
  mode = 'hang'; await assert.rejects(provider().complete('s', 'u'), /timed out/);
});

test('models.yaml: no local tier by default; a valid one loads; bad values are refused; the setter keeps other keys', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-models-'));
  assert.deepEqual(loadModelsConfig(vault), { fast: null, quality: 'planner', confirm_margin: 10, local_bias: 12 });
  const config = setFastModel(vault, { base_url: 'http://127.0.0.1:1234', model: 'qwen/qwen3.5-9b' });
  assert.deepEqual([config.fast.provider, config.fast.model, config.fast.reasoning, config.fast.timeout_seconds], ['lmstudio', 'qwen/qwen3.5-9b', 'off', 120]);
  const file = path.join(vault, 'job-hunt', 'models.yaml');
  fs.appendFileSync(file, 'confirm_margin: 14\nlocal_bias: 8\n');
  assert.deepEqual([loadModelsConfig(vault).confirm_margin, loadModelsConfig(vault).local_bias], [14, 8]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-lm'), 'no secrets in the file');
  for (const bad of ['fast:\n  provider: openai\n  model: x\n', 'fast:\n  provider: lmstudio\n  model: "a b;c"\n', 'fast:\n  provider: lmstudio\n  model: m\n  base_url: file:///etc\n', 'fast:\n  provider: lmstudio\n  model: m\n  reasoning: maybe\n', 'confirm_margin: 99\n', 'local_bias: 90\n', 'quality: gpt\n']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => loadModelsConfig(vault), /models\.yaml/, bad);
  }
});

function pilotWorld({ jobs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-tier-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'job-hunt'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'job-hunt', 'resume.json'), JSON.stringify(RESUME));
  fs.writeFileSync(path.join(vault, 'job-hunt', 'preferences.yaml'), 'minimum_score: 70\n');
  fs.writeFileSync(path.join(vault, 'job-hunt', 'autopilot.yaml'), 'enabled: true\nmode: dry_run\nsources: [hn]\nper_cycle:\n  confirm: 5\n');
  const store = openStore(huntDbPath(vault));
  const made = jobs.map(([company, score, model, email]) => {
    const { job } = store.upsertSighting({ source: 'hackernews', sourceKey: `hackernews:${company}#0`, company, role: 'Founding Engineer', rawText: company, applicationUrls: [], contactEmails: email === false ? [] : [`a@${company.toLowerCase()}.io`], author: null });
    if (score !== null) store.saveScore(job.id, { score, confidence: 0.8, label: 'strong', dimensions: {}, reasons: [], concerns: [], recommendedNarrative: 'staff-principal', projects: [], flags: [], degraded: false, model });
    return store.getJob(job.id);
  });
  return { dir, vault, store, jobs: made };
}
const FAST = 'lmstudio:qwen/qwen3.5-9b';

function tierPilot(w, { fast, quality = fakeLlm({}), scoreCalls = [] } = {}) {
  const qualityLlm = createLlm([quality.provider]);
  const autopilot = new Autopilot({
    agent: { evaluateAndMaybeExecute: async () => ({ id: 'a', status: 'executed' }), actionEvaluator: { resolve: (n) => ({ name: n }), evaluate: () => ({ requiresApproval: false }) } },
    toolRegistry: { get: () => ({}), isHidden: () => false }, vaultDir: w.vault, clock: () => new Date('2026-10-08T12:00:00Z'),
    deps: {
      createTiers: () => ({ fast, quality: qualityLlm, margin: 10, bias: 12 }), discoverSources: async () => [],
      scoreJobs: async (options) => { scoreCalls.push({ llm: options.llm, only: options.only, rescore: options.rescore, limit: options.limit }); return { scored: options.only?.length ?? 2, screened: 0, errors: [] }; },
      generateMaterials: async () => {}, planApplication: async () => ({ status: 'planned', plan: {} }),
    },
  });
  return { autopilot, qualityLlm, scoreCalls };
}
const localLlm = (available = true) => { const f = fakeLlm({}); const llm = createLlm([f.provider]); llm.probe = async () => (available ? { available: true } : { available: false, reason: 'the server could not be reached' }); return llm; };

test('with a local tier, scoring is the local model\'s job and the quality model is not used for it', async () => {
  const w = pilotWorld();
  const fast = localLlm();
  const { autopilot, qualityLlm, scoreCalls } = tierPilot(w, { fast });
  const report = await autopilot.runCycle();
  assert.equal(scoreCalls.length, 1);
  assert.equal(scoreCalls[0].llm, fast, 'the first pass used the local model');
  assert.equal(scoreCalls[0].limit, 6, 'the per-cycle budget for the local tier (about 30 s per job on a 9B model)');
  assert.equal(report.steps.score.tier, 'fast');
  assert.equal(qualityLlm.stats.calls, 0);
  assert.deepEqual(report.llm, { fast: 0, quality: 0, fastConfigured: true });
});

test('if the local model is down, fast scoring is skipped: it never silently falls back to the cloud', async () => {
  const w = pilotWorld();
  const { autopilot, qualityLlm, scoreCalls } = tierPilot(w, { fast: localLlm(false) });
  const report = await autopilot.runCycle();
  assert.equal(scoreCalls.length, 0, 'nothing was scored');
  assert.deepEqual(report.steps.score, { skipped: 'local model unavailable' });
  assert.ok(report.errors.some((entry) => /local model unavailable: the server could not be reached/.test(entry)));
  assert.equal(qualityLlm.stats.calls, 0);
});

test('a first-pass score is confirmed by the quality model near the threshold before anything is prepared', async () => {
  const w = pilotWorld({ jobs: [['Near', 74, FAST], ['Far', 40, FAST], ['Mid', 66, FAST], ['Done', 80, 'cli:claude'], ['High', 95, FAST]] });
  const { autopilot, qualityLlm, scoreCalls } = tierPilot(w, { fast: localLlm() });
  const report = await autopilot.runCycle();
  const confirm = scoreCalls.find((call) => call.rescore);
  assert.ok(confirm, 'a confirmation pass ran');
  assert.equal(confirm.llm, qualityLlm, 'by the quality tier');
  const ids = new Set(confirm.only);
  assert.deepEqual([ids.has(w.jobs[0].id), ids.has(w.jobs[1].id), ids.has(w.jobs[2].id), ids.has(w.jobs[3].id), ids.has(w.jobs[4].id)], [true, false, false, false, true], 'the local bias (12) lifts the cutoff to 72: near and high first-pass scores are confirmed; a 66 is below it, and already-confirmed ones are left alone');
  assert.equal(report.steps.confirm.confirmed, 2);
  // Until confirmed, a first-pass score never spends a materials run.
  const store = w.store;
  const pool = autopilot.candidatesToPrepare({ store, candidate: { preferences: { minimum_score: 70 } }, config: { routes: { form: false } }, limit: 10, tiered: true }).map((job) => job.company);
  assert.deepEqual(pool, ['Done'], 'only the quality-confirmed job is eligible');
  const untiered = autopilot.candidatesToPrepare({ store, candidate: { preferences: { minimum_score: 70 } }, config: { routes: { form: false } }, limit: 10, tiered: false }).map((job) => job.company).sort();
  assert.deepEqual(untiered, ['Done', 'High', 'Near'], 'without a local tier nothing changes');
});

test('without a local tier the cycle is exactly as before: the quality model scores and there is no confirmation step', async () => {
  const w = pilotWorld({ jobs: [['Near', 74, 'cli:claude']] });
  const { autopilot, qualityLlm, scoreCalls } = tierPilot(w, { fast: null });
  const report = await autopilot.runCycle();
  assert.equal(scoreCalls.length, 1);
  assert.equal(scoreCalls[0].llm, qualityLlm);
  assert.equal(scoreCalls[0].limit, 6);
  assert.deepEqual(report.steps.confirm, { skipped: 'no local tier' });
  assert.equal(report.llm.fastConfigured, false);
});

test('call counters count model calls per tier, including retries', async () => {
  const f = fakeLlm('not json at all');
  const llm = createLlm([f.provider]);
  await llm.json({ system: 's', user: 'u', validate: (raw) => raw }).catch(() => {});
  assert.equal(llm.stats.calls, 2, 'a malformed answer is retried once, and both calls are counted');
  assert.equal(llm.stats.failures, 2);
});
