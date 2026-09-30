import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { runProcess } from '../server/coding-agent/runner.js';
import { buildChildEnv } from '../server/coding-agent/env.js';
import { redact } from '../server/coding-agent/redact.js';
import { resolveWorkingDirectory } from '../server/coding-agent/cwd.js';
import { CliCodingAgentProvider } from '../server/coding-agent/cli-provider.js';
import { CodingAgentRegistry } from '../server/coding-agent/registry.js';
import { CodingAgentService } from '../server/coding-agent/service.js';
import { defaultCodingAgentConfig } from '../server/coding-agent/config.js';

const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-coding-cli.js');
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const node = (...args) => ({ executable: process.execPath, args: [MOCK, ...args], env: buildChildEnv({}) });

// --- runner -------------------------------------------------------------------

test('runner: captures stdout, stderr and exit code, streaming lines as they arrive', async () => {
  const lines = [];
  const result = await runProcess({ ...node('ok'), cwd: os.tmpdir(), onLine: (stream, line) => lines.push([stream, line]) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'line one\nline two\n');
  assert.equal(result.stderr, 'warning one\n');
  assert.deepEqual(lines.filter(([s]) => s === 'stdout').map(([, l]) => l), ['line one', 'line two']);
  assert.deepEqual(lines.filter(([s]) => s === 'stderr').map(([, l]) => l), ['warning one']);
  assert.ok(result.pid > 0);
});

test('runner: a nonzero exit is reported, not thrown', async () => {
  const result = await runProcess({ ...node('fail'), cwd: os.tmpdir() });
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /it broke/);
});

test('runner: a missing executable is a spawnError', async () => {
  const result = await runProcess({ executable: '/nonexistent/definitely-not-here', args: [], cwd: os.tmpdir(), env: {} });
  assert.equal(result.spawnError.code, 'ENOENT');
});

test('runner: uses the requested working directory', async () => {
  const dir = tmp('u2os-cwd-');
  try {
    const result = await runProcess({ ...node('echo'), cwd: dir });
    assert.equal(JSON.parse(result.stdout).cwd, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runner: timeout stops the whole process group, grandchildren included', async () => {
  const result = await runProcess({ ...node('hang'), cwd: os.tmpdir(), timeoutMs: 600, killGraceMs: 500 });
  assert.equal(result.timedOut, true);
  const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1]);
  assert.ok(pid, 'grandchild pid was reported');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(alive(pid), false);
});

test('runner: cancellation via AbortSignal', async () => {
  const controller = new AbortController();
  const promise = runProcess({ ...node('hang'), cwd: os.tmpdir(), signal: controller.signal, killGraceMs: 500 });
  setTimeout(() => controller.abort(), 300);
  const result = await promise;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
});

test('runner: arguments and stdin are passed literally, never through a shell', async () => {
  const dir = tmp('u2os-inject-');
  const canary = path.join(dir, 'pwned');
  const hostile = [`; touch ${canary}`, '$(touch ' + canary + ')', '`touch ' + canary + '`', '&& id', '| cat', "'; echo x #", '--dangerously-bypass-approvals-and-sandbox'];
  try {
    const result = await runProcess({ ...node('echo', ...hostile), cwd: dir, stdin: `task: $(touch ${canary}); rm -rf /` });
    const echoed = JSON.parse(result.stdout);
    assert.deepEqual(echoed.argv, hostile);
    assert.equal(echoed.stdin, `task: $(touch ${canary}); rm -rf /`);
    assert.equal(fs.existsSync(canary), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- environment --------------------------------------------------------------

test('environment: only allow-listed variables reach the child; U2OS and API-key variables do not', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, { U2OS_HOME_SECRET: 'nope', U2OS_SESSION: 'nope', OPENAI_API_KEY: 'sk-test-not-real', ANTHROPIC_API_KEY: 'sk-ant-not-real', GITHUB_TOKEN: 'ghp_not_real', CODEX_HOME: '/home/x/.codex', LC_ALL: 'C' });
  try {
    const env = JSON.parse((await runProcess({ ...node('env'), cwd: os.tmpdir(), env: buildChildEnv({ passthrough: ['CODEX_HOME'] }) })).stdout);
    assert.ok(env.PATH, 'PATH is forwarded');
    assert.equal(env.CODEX_HOME, '/home/x/.codex');
    assert.equal(env.LC_ALL, 'C');
    for (const name of ['U2OS_HOME_SECRET', 'U2OS_SESSION', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) assert.equal(env[name], undefined, `${name} must not be forwarded`);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('environment: a task may add variables but not ones that change what runs', () => {
  assert.equal(buildChildEnv({ extra: { FOO: 'bar' }, source: {} }).FOO, 'bar');
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'U2OS_HOME', 'BASH_ENV']) {
    assert.throws(() => buildChildEnv({ extra: { [name]: 'x' }, source: {} }), /may not be set/);
  }
});

// --- cwd and redaction --------------------------------------------------------

test('cwd: rejects relative, missing, non-directory, root and home; resolves symlinks', () => {
  const dir = tmp('u2os-cwdv-');
  try {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    const link = path.join(dir, 'link');
    fs.symlinkSync(dir, link);
    assert.throws(() => resolveWorkingDirectory('relative/dir'), /absolute/);
    assert.throws(() => resolveWorkingDirectory(path.join(dir, 'missing')), /does not exist/);
    assert.throws(() => resolveWorkingDirectory(file), /not a directory/);
    assert.throws(() => resolveWorkingDirectory(path.parse(dir).root), /filesystem root/);
    assert.throws(() => resolveWorkingDirectory(os.homedir()), /home directory/);
    assert.equal(resolveWorkingDirectory(link), dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cwd: roots confine runs, and a symlink cannot escape them', () => {
  const root = tmp('u2os-root-');
  const outside = tmp('u2os-outside-');
  try {
    fs.mkdirSync(path.join(root, 'proj'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.equal(resolveWorkingDirectory(path.join(root, 'proj'), { roots: [root] }), path.join(root, 'proj'));
    assert.throws(() => resolveWorkingDirectory(outside, { roots: [root] }), /outside the roots/);
    assert.throws(() => resolveWorkingDirectory(path.join(root, 'escape'), { roots: [root] }), /outside the roots/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('redact: removes common credential shapes and exact secret values', () => {
  // Built at runtime so no secret-shaped literal sits in the source (secret scanners).
  const fake = { sk: ['sk', 'abcdefghijklmnopqrstuv'].join('-'), gh: ['ghp', 'abcdefghijklmnopqrstuvwx'].join('_'), bearer: ['Bearer', 'abcdefghijklmnop' + '1234'].join(' ') };
  const text = redact(`key ${fake.sk} token=${fake.gh} Authorization: ${fake.bearer} mine=hunter22secret api_key: "abcd1234efgh"`, { secrets: ['hunter22secret'] });
  assert.doesNotMatch(text, /sk-abcdef|ghp_abcdef|abcdefghijklmnop1234|hunter22secret|abcd1234efgh/);
  assert.match(text, /\[REDACTED\]/);
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

// --- provider + service -------------------------------------------------------

class MockProvider extends CliCodingAgentProvider {
  constructor(options) { super(options); this.mode = 'ok'; }
  get id() { return 'mock'; }
  get name() { return 'Mock CLI'; }
  get defaultExecutable() { return process.execPath; }
  get versionArgs() { return [MOCK, 'version']; }
  buildInvocation(task) { return { args: [MOCK, this.mode, ...(this.mode === 'echo' ? [task.task] : [])], stdin: task.task }; }
}

function setup() {
  const home = tmp('u2os-svc-');
  process.env.U2OS_HOME = home;
  const project = tmp('u2os-proj-');
  const eventBus = new EventBus(getDb());
  const provider = new MockProvider();
  const registry = new CodingAgentRegistry({ configLoader: () => defaultCodingAgentConfig() });
  registry.register(provider);
  const service = new CodingAgentService({ registry, eventBus });
  const cleanup = () => { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); };
  return { service, provider, registry, project, eventBus, cleanup };
}

test('provider detection: installed, missing and custom executable', async () => {
  const provider = new MockProvider();
  const ok = await provider.probe();
  assert.equal(ok.available, true);
  assert.equal(ok.version, 'mock-cli 9.9.9');

  const missing = new MockProvider({ providerConfig: () => ({ executable: '/nonexistent/mock-agent' }) });
  const gone = await missing.probe();
  assert.equal(gone.available, false);
  assert.match(gone.reason, /not found/);

  const dir = tmp('u2os-custom-');
  try {
    const custom = path.join(dir, 'custom-agent');
    fs.writeFileSync(custom, `#!/bin/sh\necho custom-agent 1.2.3\n`, { mode: 0o755 });
    class Custom extends MockProvider { get versionArgs() { return ['--version']; } }
    const found = await new Custom({ providerConfig: () => ({ executable: custom }) }).probe();
    assert.deepEqual([found.available, found.version], [true, 'custom-agent 1.2.3']);
    fs.chmodSync(custom, 0o644);
    assert.match((await new Custom({ providerConfig: () => ({ executable: custom }) }).probe()).reason, /not executable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('service: a successful run is recorded, streamed and published', async () => {
  const { service, project, eventBus, cleanup } = setup();
  try {
    const live = [];
    service.subscribe((event) => live.push(event));
    const run = await service.run({ cwd: project, task: 'explain this', provider: 'auto' });
    assert.equal(run.status, 'completed');
    assert.equal(run.provider, 'mock');
    assert.equal(run.exitCode, 0);
    assert.match(run.output, /line one/);
    assert.match(run.stderr, /warning one/);
    assert.ok(run.completedAt);
    assert.equal(service.get(run.id).status, 'completed');

    assert.deepEqual(live.map((e) => e.type).filter((t) => t !== 'coding.agent.output'), ['coding.agent.started', 'coding.agent.completed']);
    assert.ok(live.some((e) => e.type === 'coding.agent.output' && e.data.stream === 'stdout' && e.data.data === 'line one'));
    const durable = getDb().prepare("SELECT type, data FROM events WHERE type LIKE 'coding.agent.%' ORDER BY rowid").all();
    assert.deepEqual(durable.map((e) => e.type), ['coding.agent.started', 'coding.agent.completed']);
    assert.doesNotMatch(durable.map((e) => e.data).join(''), /line one/, 'durable events carry no output');
    assert.ok(eventBus);
  } finally { cleanup(); }
});

test('service: nonzero exit is a failed run with the error recorded', async () => {
  const { service, provider, project, cleanup } = setup();
  try {
    provider.mode = 'fail';
    const run = await service.run({ cwd: project, task: 'x' });
    assert.equal(run.status, 'failed');
    assert.equal(run.exitCode, 3);
    assert.match(run.stderr, /it broke/);
    assert.match(run.error, /exited with 3/);
  } finally { cleanup(); }
});

test('service: timeout fails the run', async () => {
  const { service, provider, project, cleanup } = setup();
  try {
    provider.mode = 'hang';
    const run = await service.run({ cwd: project, task: 'x', timeout: 1000 });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /Timed out/);
  } finally { cleanup(); }
});

test('service: cancel stops a running run and records it cancelled', async () => {
  const { service, provider, project, cleanup } = setup();
  try {
    provider.mode = 'hang';
    const handle = await service.start({ cwd: project, task: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(handle.cancel(), true);
    const run = await handle.done;
    assert.equal(run.status, 'cancelled');
    assert.equal(service.cancel(run.id), false, 'nothing left to cancel');
  } finally { cleanup(); }
});

test('service: invalid cwd and invalid tasks are rejected before anything is recorded', async () => {
  const { service, project, cleanup } = setup();
  try {
    await assert.rejects(service.run({ cwd: path.join(project, 'nope'), task: 'x' }), (e) => e.code === 'invalid_cwd');
    await assert.rejects(service.run({ cwd: 'relative', task: 'x' }), (e) => e.code === 'invalid_cwd');
    await assert.rejects(service.run({ task: 'x' }), (e) => e.code === 'invalid_task');
    assert.equal(service.list().length, 0);
  } finally { cleanup(); }
});

test('service: injection attempts in the task text are harmless and stored redacted', async () => {
  const { service, provider, project, cleanup } = setup();
  try {
    provider.mode = 'echo';
    const canary = path.join(project, 'pwned');
    const run = await service.run({ cwd: project, task: `$(touch ${canary}); token=supersecretvalue1 \`touch ${canary}\``, environment: { EXTRA_SECRET: 'supersecretvalue1' } });
    assert.equal(run.status, 'completed');
    assert.equal(fs.existsSync(canary), false);
    assert.doesNotMatch(JSON.stringify(run), /supersecretvalue1/);
  } finally { cleanup(); }
});

test('service: secrets in output are redacted in the record and the live stream', async () => {
  const { service, provider, project, cleanup } = setup();
  try {
    provider.mode = 'secret';
    const live = [];
    service.subscribe((event) => live.push(event));
    const run = await service.run({ cwd: project, task: 'x' });
    assert.doesNotMatch(run.output, /abcd1234efgh5678|sk-abcdefghijklmnopqrstuv/);
    assert.doesNotMatch(JSON.stringify(live), /abcd1234efgh5678|sk-abcdefghijklmnopqrstuv/);
  } finally { cleanup(); }
});

test('service: reports files changed in a git repository', async () => {
  const { service, provider, project, cleanup } = setup();
  try {
    execFileSync('git', ['init', '-q'], { cwd: project });
    provider.mode = 'write';
    const run = await service.run({ cwd: project, task: 'x' });
    assert.deepEqual(run.filesChanged, ['created.txt']);
  } finally { cleanup(); }
});

test('service: an adapter that throws becomes a failed run, not a stuck one', async () => {
  const { service, provider, project, cleanup } = setup();
  try {
    provider.run = async () => { throw new Error('adapter bug'); };
    const run = await service.run({ cwd: project, task: 'x' });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /adapter bug/);
  } finally { cleanup(); }
});

test('service: roots from coding-agents.yaml confine working directories', async () => {
  const { provider, project, cleanup } = setup();
  const other = tmp('u2os-other-');
  try {
    const registry = new CodingAgentRegistry({ configLoader: () => ({ ...defaultCodingAgentConfig(), roots: [project] }) });
    registry.register(provider);
    const service = new CodingAgentService({ registry });
    await assert.rejects(service.run({ cwd: other, task: 'x' }), /outside the roots/);
    assert.equal((await service.run({ cwd: project, task: 'x' })).status, 'completed');
  } finally { cleanup(); fs.rmSync(other, { recursive: true, force: true }); }
});
