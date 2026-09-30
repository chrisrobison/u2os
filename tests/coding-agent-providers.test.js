import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexProvider } from '../server/coding-agent/providers/codex.js';
import { ClaudeCodeProvider } from '../server/coding-agent/providers/claude-code.js';
import { createCodingAgentRegistry } from '../server/coding-agent/index.js';
import { defaultCodingAgentConfig } from '../server/coding-agent/config.js';
import { normalizeTask } from '../server/coding-agent/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-official-cli.js');
let bin;
let project;

before(() => {
  bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-fakebin-')));
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-fakeproj-')));
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${fs.readFileSync(FIXTURE, 'utf8')}`, { mode: 0o755 });
  }
});
after(() => { fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });

const codex = (config = {}) => new CodexProvider({ providerConfig: () => ({ executable: path.join(bin, 'codex'), ...config }) });
const claude = (config = {}) => new ClaudeCodeProvider({ providerConfig: () => ({ executable: path.join(bin, 'claude'), ...config }) });
const task = (extra = {}) => ({ ...normalizeTask({ task: 'fix the tests', cwd: project, ...extra }), cwd: project });
const reported = (outcome) => JSON.parse(outcome.summary);
const flag = (argv, name) => argv[argv.indexOf(name) + 1];

// --- detection ----------------------------------------------------------------

test('both adapters detect their CLI, report versions, and find a missing one unavailable', async () => {
  assert.deepEqual(await codex().probe(), { available: true, version: 'codex-cli 9.9.9' });
  assert.deepEqual(await claude().probe(), { available: true, version: '9.9.9 (Claude Code)' });
  const missing = await new CodexProvider({ providerConfig: () => ({ executable: path.join(bin, 'nope') }) }).probe();
  assert.equal(missing.available, false);
  assert.match(missing.reason, /not found/);
});

test('registry discovers the built-in adapters, honours custom executables and auto-selects by preference', async () => {
  const registry = createCodingAgentRegistry({ configLoader: () => ({ ...defaultCodingAgentConfig(), preference: ['codex', 'claude-code'], providers: { codex: { enabled: true, executable: path.join(bin, 'nope') }, 'claude-code': { enabled: true, executable: path.join(bin, 'claude') } } }) });
  const found = await registry.discover();
  assert.deepEqual(found.map((p) => [p.id, p.name, p.available]), [['codex', 'OpenAI Codex CLI', false], ['claude-code', 'Claude Code', true]]);
  assert.equal((await registry.resolve({ provider: 'auto' })).id, 'claude-code');
  await assert.rejects(registry.resolve({ provider: 'codex' }), (error) => error.code === 'provider_unavailable');
});

// --- Codex --------------------------------------------------------------------

test('codex: translates the task into `codex exec` with stdin, sandbox and cwd', async () => {
  const outcome = await codex().run(task({ permissions: { filesystem: 'project', network: true } }), {});
  assert.equal(outcome.status, 'completed');
  const { argv, stdin, cwd } = reported(outcome);
  assert.deepEqual(argv.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.equal(flag(argv, '-C'), project);
  assert.equal(flag(argv, '-s'), 'workspace-write');
  assert.ok(argv.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(argv.at(-1), '-');
  assert.ok(stdin.endsWith('fix the tests'), 'the task travels on stdin');
  assert.ok(!argv.includes('fix the tests'), 'the task is never an argument');
  assert.equal(cwd, project);
});

test('codex: read-only tasks get the read-only sandbox and a constraints preamble', async () => {
  const { argv, stdin } = reported(await codex().run(task(), {}));
  assert.equal(flag(argv, '-s'), 'read-only');
  assert.ok(!argv.some((arg) => arg.includes('network_access')));
  assert.match(stdin, /read-only task/);
  assert.match(stdin, /Do not run shell commands/);
  assert.match(stdin, /Do not access the network/);
  const open = reported(await codex().run(task({ permissions: { filesystem: 'unrestricted', shell: true, git: true, network: true } }), {}));
  assert.equal(flag(open.argv, '-s'), 'danger-full-access');
  assert.doesNotMatch(open.stdin, /Do not run shell/);
});

test('codex: model comes from provider configuration, not the task', async () => {
  assert.equal(flag(reported(await codex({ model: 'gpt-5.1-codex' }).run(task(), {})).argv, '-m'), 'gpt-5.1-codex');
  assert.ok(!reported(await codex().run(task(), {})).argv.includes('-m'));
});

test('codex: output is normalized; thread and usage are kept as metadata', async () => {
  const shown = [];
  const outcome = await codex().run(task(), { onOutput: (stream, text) => shown.push(text) });
  assert.deepEqual(shown.slice(0, 3), ['$ npm test', 'changed: a.js', 'not json, shown raw']);
  assert.ok(!shown.some((text) => text.includes('thread.started')), 'protocol events are not shown');
  assert.equal(outcome.metadata.threadId, 'thread-1');
  assert.deepEqual(outcome.metadata.usage, { input_tokens: 1, output_tokens: 2 });
  assert.equal(outcome.exitCode, 0);
});

test('codex: does not forward API keys; CODEX_HOME is located, not read', async () => {
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_HOME: process.env.CODEX_HOME };
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  process.env.CODEX_HOME = '/somewhere/.codex';
  try {
    const seen = reported(await codex().run(task(), {}));
    assert.equal(seen.hasOpenAiKey, false);
    assert.equal(seen.codexHome, '/somewhere/.codex');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('codex: failures are normalized (nonzero exit, turn.failed with exit 0)', async () => {
  const exit = await codex().run(task({ environment: { FAKE_SCENARIO: 'exit2' } }), {});
  assert.equal(exit.status, 'failed');
  assert.equal(exit.exitCode, 2);
  assert.match(exit.stderr, /fatal/);
  const failed = await codex().run(task({ environment: { FAKE_SCENARIO: 'turn-failed' } }), {});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'model exploded');
});

// --- Claude Code --------------------------------------------------------------

test('claude: read-only task -> print mode, plan permissions, shell/network tools denied, task on stdin', async () => {
  const outcome = await claude().run(task(), {});
  assert.equal(outcome.status, 'completed');
  const { argv, stdin } = reported(outcome);
  assert.deepEqual(argv.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode']);
  assert.equal(flag(argv, '--permission-mode'), 'plan');
  assert.deepEqual(flag(argv, '--disallowedTools').split(','), ['Bash', 'WebFetch', 'WebSearch']);
  assert.ok(!argv.includes('--allowedTools'));
  assert.ok(!argv.includes('fix the tests'));
  assert.ok(stdin.endsWith('fix the tests'));
});

test('claude: a project-write task with shell, git and network pre-approves those tools', async () => {
  const { argv } = reported(await claude().run(task({ permissions: { filesystem: 'project', shell: true, git: true, network: true } }), {}));
  assert.equal(flag(argv, '--permission-mode'), 'acceptEdits');
  assert.deepEqual(flag(argv, '--allowedTools').split(','), ['Bash', 'WebFetch', 'WebSearch']);
  assert.ok(!argv.includes('--disallowedTools'));
  const noGit = reported(await claude().run(task({ permissions: { filesystem: 'project', shell: true } }), {}));
  assert.ok(flag(noGit.argv, '--disallowedTools').split(',').includes('Bash(git *)'));
  const none = reported(await claude().run(task({ permissions: { filesystem: 'none' } }), {}));
  assert.ok(flag(none.argv, '--disallowedTools').split(',').includes('Read'));
});

test('claude: output is normalized; bookkeeping events are hidden; result becomes the summary', async () => {
  const shown = [];
  const outcome = await claude({ model: 'sonnet' }).run(task(), { onOutput: (stream, text) => shown.push(text) });
  assert.deepEqual(shown, ['working\n→ Bash: npm test']);
  assert.equal(outcome.metadata.sessionId, 'sess-1');
  assert.equal(outcome.metadata.costUsd, 0.01);
  assert.equal(flag(reported(outcome).argv, '--model'), 'sonnet');
  assert.equal(reported(outcome).hasAnthropicKey, false);
});

test('claude: denied tools make the run needs_input; errors fail it; a missing result fails it', async () => {
  const denied = await claude().run(task({ environment: { FAKE_SCENARIO: 'denied' } }), {});
  assert.equal(denied.status, 'needs_input');
  assert.match(denied.error, /Bash, Edit/);
  assert.deepEqual(denied.metadata.permissionDenials, ['Bash', 'Edit']);
  const error = await claude().run(task({ environment: { FAKE_SCENARIO: 'error' } }), {});
  assert.equal(error.status, 'failed');
  assert.equal(error.error, 'login required');
  const none = await claude().run(task({ environment: { FAKE_SCENARIO: 'no-result' } }), {});
  assert.equal(none.status, 'failed');
  const exit = await claude().run(task({ environment: { FAKE_SCENARIO: 'exit2' } }), {});
  assert.equal(exit.status, 'failed');
  assert.equal(exit.exitCode, 2);
});

test('both adapters report what they can and cannot enforce', async () => {
  for (const provider of [codex(), claude()]) {
    const caps = await provider.capabilities();
    assert.equal(caps.streaming, true);
    assert.equal(caps.cancel, true);
    assert.ok(Object.keys(caps.enforcement).length >= 3);
  }
  assert.match((await codex().capabilities()).enforcement.shell, /NOT enforced/);
});
