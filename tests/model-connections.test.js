import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliModelProvider, CLI_PRESETS } from '../server/agent/cli-model-provider.js';
import { buildConfigFromConnections, describeConnections } from '../server/agent/model-connections.js';
import { testConnection } from '../server/agent/model-connection-test.js';
import { ModelRouter } from '../server/agent/model-router.js';
import { Planner } from '../server/agent/planner.js';
import { createToolRegistry } from '../server/tools/register-all.js';

const registry = createToolRegistry();
const PLAN = { reasoning_summary: 'nothing to do', actions: [] };
const ok = (stdout) => async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

function recorder(stdout, extra = {}) {
  const calls = [];
  const impl = async (options) => { calls.push(options); return { exitCode: 0, stdout, stderr: '', timedOut: false, ...extra }; };
  return { calls, impl };
}

test('claude preset: tools off, prompt on stdin, JSON result unwrapped, env scrubbed', async () => {
  const { calls, impl } = recorder(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(PLAN) }));
  const provider = new CliModelProvider({ preset: 'claude', runProcessImpl: impl, source: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-secret', U2OS_HOME: '/x', CLAUDE_CONFIG_DIR: '/c' } });
  const plan = await provider.plan({ toolRegistry: registry }, 'say hi');
  assert.equal(plan.reasoning_summary, 'nothing to do');
  const [call] = calls;
  assert.equal(call.executable, 'claude');
  assert.deepEqual(call.args.slice(0, 5), ['-p', '--output-format', 'json', '--no-session-persistence', '--tools']);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.match(call.stdin, /say hi/);
  assert.ok(!call.args.some((a) => a.includes('say hi')), 'objective must not be on the command line');
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.env.U2OS_HOME, undefined);
  assert.equal(call.env.CLAUDE_CONFIG_DIR, '/c');
  assert.equal(provider.destination, 'configured_remote_model');
});

test('codex preset reads the final message file; grok preset passes a prompt file', async () => {
  let promptSeen;
  const codex = new CliModelProvider({ preset: 'codex', runProcessImpl: async (o) => { fs.writeFileSync(o.args[o.args.indexOf('-o') + 1], `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``); assert.equal(o.args.at(-1), '-'); assert.ok(o.args.includes('read-only')); return { exitCode: 0, stdout: 'noise', stderr: '' }; } });
  assert.equal((await codex.plan({ toolRegistry: registry }, 'x')).reasoning_summary, 'nothing to do');
  const grok = new CliModelProvider({ preset: 'grok', model: 'grok-4', runProcessImpl: async (o) => { promptSeen = fs.readFileSync(o.args[o.args.indexOf('--prompt-file') + 1], 'utf8'); assert.equal(o.stdin, null); assert.ok(o.args.includes('plan')); return { exitCode: 0, stdout: `Here you go: ${JSON.stringify(PLAN)} done`, stderr: '' }; } });
  assert.equal((await grok.plan({ toolRegistry: registry }, 'find me')).reasoning_summary, 'nothing to do');
  assert.match(promptSeen, /find me/);
});

test('custom command substitutes placeholders and reads stdout', async () => {
  const { calls, impl } = recorder(JSON.stringify(PLAN));
  const provider = new CliModelProvider({ preset: 'custom', executable: '/usr/local/bin/my-llm', args: ['--model', '{model}', '--in', '{promptFile}'], input: 'file', model: 'tiny', runProcessImpl: impl });
  await provider.plan({ toolRegistry: registry }, 'x');
  assert.equal(calls[0].executable, '/usr/local/bin/my-llm');
  assert.equal(calls[0].args[1], 'tiny');
  assert.match(calls[0].args[3], /prompt\.txt$/);
});

test('CLI failures are reported without raw output', async () => {
  const run = (result) => new CliModelProvider({ preset: 'claude', runProcessImpl: async () => result }).plan({ toolRegistry: registry }, 'x');
  await assert.rejects(run({ spawnError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }), /could not start \(ENOENT\)/);
  await assert.rejects(run({ exitCode: 1, stdout: 'secret detail', stderr: 'more secret' }), (e) => /exit 1/.test(e.message) && !/secret/.test(e.message));
  await assert.rejects(run({ exitCode: 1, stderr: 'Error: Not signed in. To authenticate...' }), /not signed in/);
  await assert.rejects(run({ timedOut: true }), /timed out/);
  await assert.rejects(run({ exitCode: 0, stdout: 'not json at all' }), /invalid JSON/);
  await assert.rejects(run({ exitCode: 0, stdout: JSON.stringify({ result: JSON.stringify({ reasoning_summary: 'x', actions: [{ tool: 'nope.nothing', arguments: {} }] }) }) }), /./);
});

test('router tries the owner-ordered connections in turn', async () => {
  const names = [];
  const make = (id, fails) => ({ id, plan: async () => { names.push(id); if (fails) throw new Error(`${id} down`); return { ...PLAN, reasoning_summary: id }; } });
  const router = new ModelRouter({
    providers: { a: { type: 'cli' }, b: { type: 'cli' }, c: { type: 'cli' } }, roles: { planner: 'a' }, order: ['a', 'b', 'c'],
  }, { allowMock: false, createProvider: (cfg, ) => cfg.make });
  router.config.providers.a.make = make('a', true); router.config.providers.b.make = make('b', true); router.config.providers.c.make = make('c', false);
  router.createProvider = (cfg) => cfg.make;
  const planner = new Planner({ modelRouter: router });
  const plan = await planner.plan({ toolRegistry: registry }, 'x');
  assert.deepEqual(names, ['a', 'b', 'c']);
  assert.equal(plan.reasoning_summary, 'c');
  assert.equal(planner.lastProviderId, 'c');
  // all failing -> unavailable naming the last one tried
  router.config.providers.c.make = make('c', true); router._cache.clear();
  await assert.rejects(new Planner({ modelRouter: router }).plan({ toolRegistry: registry }, 'x'), (e) => e.code === 'MODEL_UNAVAILABLE' && /c failed/.test(e.message));
});

test('buildConfigFromConnections validates and keeps unrelated providers', () => {
  const { config, secrets } = buildConfigFromConnections([
    { id: 'sub', type: 'cli', preset: 'claude' },
    { id: 'api', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234', model: 'm', apiKey: 'k1' },
  ], { providers: { emb: { type: 'embedding-openai-compatible', baseUrl: 'http://x', model: 'e' } }, roles: { embeddings: 'emb', planner: 'old' } });
  assert.deepEqual(config.order, ['sub', 'api']);
  assert.equal(config.roles.planner, 'sub'); assert.equal(config.roles.embeddings, 'emb');
  assert.ok(config.providers.emb);
  assert.deepEqual(secrets, { api: 'k1' });
  assert.ok(!JSON.stringify(config).includes('k1'));
  const bad = (conns, re) => assert.throws(() => buildConfigFromConnections(conns), re);
  bad([], /at least one/);
  bad([{ id: 'a b', type: 'cli', preset: 'claude' }], /Invalid connection name/);
  bad([{ id: 'a', type: 'cli', preset: 'claude' }, { id: 'a', type: 'cli', preset: 'codex' }], /Duplicate/);
  bad([{ id: 'a', type: 'mock' }], /type must be/);
  bad([{ id: 'a', type: 'cli', preset: 'nope' }], /preset/);
  bad([{ id: 'a', type: 'cli', preset: 'custom' }], /executable/);
  bad([{ id: 'a', type: 'cli', preset: 'custom', executable: 'rm -rf /' }], /command name or an absolute path/);
  bad([{ id: 'a', type: 'cli', preset: 'custom', executable: '../bin/x' }], /command name or an absolute path/);
  bad([{ id: 'a', type: 'openai-compatible', model: 'm' }], /endpoint URL is required/);
  bad([{ id: 'a', type: 'openai-compatible', model: 'm', baseUrl: 'http://u:p@h' }], /credentials/);
  bad([{ id: 'a', type: 'anthropic' }], /model is required/);
  bad([{ id: 'a', type: 'cli', preset: 'claude', timeoutMs: 5 }], /timeout/);
});

test('describeConnections never exposes keys and presents legacy config as one connection', () => {
  const legacy = describeConnections({ provider: 'openai-compatible', baseUrl: 'http://h', model: 'm', timeoutMs: 1000 }, os.tmpdir());
  assert.equal(legacy.length, 1); assert.equal(legacy[0].id, 'default'); assert.equal(legacy[0].keyConfigured, false);
  const multi = describeConnections({ providers: { b: { type: 'cli', preset: 'codex' }, a: { type: 'anthropic', model: 'm', apiKey: 'leak' }, e: { type: 'embedding-openai-compatible' } }, roles: { planner: 'a' }, order: ['b', 'a'] }, os.tmpdir());
  assert.deepEqual(multi.map((c) => c.id), ['b', 'a']);
  assert.ok(!JSON.stringify(multi).includes('leak'));
});

test('testConnection: CLI install, prompt and API reachability stages use the fixed vocabulary', async () => {
  const provider = new CliModelProvider({ preset: 'claude', runProcessImpl: async (o) => (o.args[0] === '--version' ? { exitCode: 0, stdout: '2.1.0 (Claude Code)\n' } : { exitCode: 0, stdout: JSON.stringify({ result: 'ok' }) }) });
  assert.deepEqual((await testConnection(provider, { type: 'cli' })).stage, 'install');
  const sent = await testConnection(provider, { type: 'cli' }, { sendPrompt: true });
  assert.equal(sent.ok, true); assert.equal(sent.stage, 'prompt'); assert.equal(sent.version, '2.1.0 (Claude Code)');
  const missing = new CliModelProvider({ preset: 'grok', runProcessImpl: async () => ({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }) });
  assert.equal((await testConnection(missing, { type: 'cli' })).reason, 'not_installed');
  const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  assert.equal((await testConnection(null, { type: 'openai-compatible', baseUrl: 'http://h:1', model: 'm' }, { fetchImpl: refused })).reason, 'connection_refused');
  const listing = async () => ({ ok: true, json: async () => ({ data: [{ id: 'other' }] }) });
  const found = await testConnection(null, { type: 'openai-compatible', baseUrl: 'http://h:1', model: 'm' }, { fetchImpl: listing });
  assert.equal(found.ok, true); assert.equal(found.modelFound, false);
  const denied = await testConnection(null, { type: 'anthropic', apiKey: 'k', model: 'm' }, { fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(denied.reason, 'unauthorized');
});

test('presets cover claude, codex, grok and custom', () => {
  assert.deepEqual(Object.keys(CLI_PRESETS), ['claude', 'codex', 'grok', 'custom']);
});
