import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { CodingAgentProvider } from '../server/coding-agent/provider.js';
import { CodingAgentRegistry } from '../server/coding-agent/registry.js';
import { normalizeTask, DEFAULT_PERMISSIONS, DEFAULT_TIMEOUT_MS } from '../server/coding-agent/types.js';
import { loadCodingAgentConfig, parseCodingAgentConfig, defaultCodingAgentConfig } from '../server/coding-agent/config.js';
import { createRun, updateRun, getRun, listRuns, failInterruptedRuns } from '../server/coding-agent/store.js';

class FakeProvider extends CodingAgentProvider {
  constructor(id, { available = true, reason } = {}) { super(); this._id = id; this.state = { available, reason }; this.probes = 0; }
  get id() { return this._id; }
  get name() { return `Fake ${this._id}`; }
  async probe() { this.probes += 1; return { available: this.state.available, reason: this.state.reason, version: '1.0' }; }
}

const registry = (providers, config = {}) => {
  const reg = new CodingAgentRegistry({ configLoader: () => ({ ...defaultCodingAgentConfig(), ...config }) });
  for (const provider of providers) reg.register(provider);
  return reg;
};

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-coding-agent-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- task model ---------------------------------------------------------------

test('normalizeTask applies least-privilege defaults', () => {
  const task = normalizeTask({ task: 'explain', cwd: '/tmp/x' });
  assert.deepEqual(task.permissions, DEFAULT_PERMISSIONS);
  assert.equal(task.permissions.filesystem, 'read');
  assert.equal(task.permissions.shell, false);
  assert.equal(task.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('normalizeTask rejects missing cwd, empty task, unknown permissions and git without shell', () => {
  assert.throws(() => normalizeTask({ task: 'x' }), /cwd is required/);
  assert.throws(() => normalizeTask({ task: '  ', cwd: '/x' }), /non-empty/);
  assert.throws(() => normalizeTask({ task: 'x', cwd: '/x', permissions: { root: true } }), /not a known permission/);
  assert.throws(() => normalizeTask({ task: 'x', cwd: '/x', permissions: { filesystem: 'everything' } }), /filesystem must be one of/);
  assert.throws(() => normalizeTask({ task: 'x', cwd: '/x', permissions: { git: true } }), /requires permissions.shell/);
  assert.throws(() => normalizeTask({ task: 'x', cwd: '/x', timeout: 5 }), /timeout/);
  assert.throws(() => normalizeTask({ task: 'x', cwd: '/x', environment: { 'BAD NAME': '1' } }), /valid variable name/);
});

// --- registry -----------------------------------------------------------------

test('registry: registration, lookup and duplicate protection', () => {
  const codex = new FakeProvider('codex');
  const reg = registry([codex]);
  assert.equal(reg.get('codex'), codex);
  assert.ok(reg.has('codex'));
  assert.throws(() => reg.get('nope'), (error) => error.code === 'unknown_provider');
  assert.throws(() => reg.register(new FakeProvider('codex')), /already registered/);
  assert.throws(() => reg.register(new FakeProvider('Bad Id')), /needs an id/);
});

test('registry: discover reports availability and never probes a disabled provider', async () => {
  const codex = new FakeProvider('codex');
  const claude = new FakeProvider('claude-code', { available: false, reason: 'claude not found on PATH' });
  const off = new FakeProvider('off');
  const reg = registry([codex, claude, off], { providers: { off: { enabled: false } } });
  const found = await reg.discover();
  assert.deepEqual(found.map((p) => [p.id, p.enabled, p.available]), [['codex', true, true], ['claude-code', true, false], ['off', false, false]]);
  assert.match(found[1].reason, /not found/);
  assert.equal(off.probes, 0);
});

test('registry: auto picks by preference, skipping unavailable, disabled and unknown providers', async () => {
  const codex = new FakeProvider('codex', { available: false, reason: 'missing' });
  const claude = new FakeProvider('claude-code');
  const other = new FakeProvider('other');
  const reg = registry([codex, claude, other], { preference: ['local', 'codex', 'claude-code', 'other'] });
  assert.equal((await reg.resolve({ provider: 'auto' })).id, 'claude-code');

  const disabled = registry([claude, other], { preference: ['claude-code', 'other'], providers: { 'claude-code': { enabled: false } } });
  assert.equal((await disabled.resolve()).id, 'other');
});

test('registry: default leads the order; an explicit preference argument is exclusive', async () => {
  const a = new FakeProvider('aaa');
  const b = new FakeProvider('bbb');
  const reg = registry([a, b], { default: 'bbb' });
  assert.equal((await reg.resolve()).id, 'bbb');
  assert.equal((await reg.resolve({ preference: ['aaa'] })).id, 'aaa');
  const none = registry([new FakeProvider('aaa', { available: false })]);
  await assert.rejects(none.resolve({ preference: ['aaa'] }), (error) => error.code === 'no_provider');
  await assert.rejects(reg.resolve({ preference: ['local'] }), (error) => error.code === 'no_provider');
});

test('registry: an explicit provider must exist, be enabled and be available', async () => {
  const reg = registry([new FakeProvider('codex', { available: false, reason: 'not installed' }), new FakeProvider('off')], { providers: { off: { enabled: false } } });
  await assert.rejects(reg.resolve({ provider: 'nope' }), (error) => error.code === 'unknown_provider');
  await assert.rejects(reg.resolve({ provider: 'off' }), (error) => error.code === 'provider_disabled');
  await assert.rejects(reg.resolve({ provider: 'codex' }), (error) => error.code === 'provider_unavailable' && /not installed/.test(error.message));
});

test('registry: a throwing probe is unavailable, not a crash', async () => {
  const broken = new FakeProvider('broken');
  broken.probe = async () => { throw new Error('boom'); };
  const reg = registry([broken]);
  assert.equal((await reg.discover())[0].available, false);
  await assert.rejects(reg.resolve(), (error) => error.code === 'no_provider');
});

test('registry: an invalid config fails closed', async () => {
  const reg = registry([new FakeProvider('codex')], { disabled: true, error: 'bad yaml' });
  assert.equal((await reg.discover())[0].enabled, false);
  await assert.rejects(reg.resolve(), (error) => error.code === 'config_invalid');
});

// --- config -------------------------------------------------------------------

test('config: no file means defaults; a valid file is parsed; an invalid one fails closed', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-coding-vault-'));
  try {
    assert.equal(loadCodingAgentConfig(vault).error, null);
    fs.writeFileSync(path.join(vault, 'coding-agents.yaml'), [
      'default: codex', 'preference: [codex, claude-code, local]', 'roots: [/srv/work]', 'timeout_seconds: 60',
      'providers:', '  codex: { executable: /opt/bin/codex }', '  claude-code: { enabled: false, model: sonnet }',
    ].join('\n'));
    const config = loadCodingAgentConfig(vault);
    assert.equal(config.error, null);
    assert.deepEqual(config.preference, ['codex', 'claude-code', 'local']);
    assert.equal(config.timeoutMs, 60_000);
    assert.equal(config.providers.codex.executable, '/opt/bin/codex');
    assert.equal(config.providers['claude-code'].enabled, false);

    fs.writeFileSync(path.join(vault, 'coding-agents.yaml'), 'providers:\n  codex: { executable: "a\\nb" }\n');
    const bad = loadCodingAgentConfig(vault);
    assert.equal(bad.disabled, true);
    assert.match(bad.error, /executable/);
  } finally { fs.rmSync(vault, { recursive: true, force: true }); }
});

test('config: rejects unknown keys, relative roots and out-of-range timeouts', () => {
  assert.throws(() => parseCodingAgentConfig({ surprise: 1 }), /unknown setting/);
  assert.throws(() => parseCodingAgentConfig({ roots: ['relative/path'] }), /absolute/);
  assert.throws(() => parseCodingAgentConfig({ timeout_seconds: 0 }), /timeout_seconds/);
  assert.throws(() => parseCodingAgentConfig({ providers: { codex: { api_key: 'x' } } }), /unknown setting/);
});

// --- store --------------------------------------------------------------------

test('store: creates, updates, lists runs and fails interrupted ones', () => {
  const dir = tempHome();
  try {
    const run = createRun({ provider: 'codex', task: 'do it', cwd: '/tmp/p', permissions: DEFAULT_PERMISSIONS, metadata: { issue: 1 } });
    assert.equal(run.status, 'queued');
    assert.match(run.id, /^cagent_/);
    const done = updateRun(run.id, { status: 'completed', exitCode: 0, summary: 'ok', filesChanged: ['a.js'], completedAt: new Date().toISOString() });
    assert.equal(done.exitCode, 0);
    assert.deepEqual(done.filesChanged, ['a.js']);
    assert.equal(done.terminal, true);
    assert.deepEqual(done.metadata, { issue: 1 });

    const stuck = createRun({ provider: 'codex', task: 't', cwd: '/tmp/p', permissions: DEFAULT_PERMISSIONS });
    updateRun(stuck.id, { status: 'running', pid: 999999 });
    const alive = createRun({ provider: 'codex', task: 't', cwd: '/tmp/p', permissions: DEFAULT_PERMISSIONS });
    updateRun(alive.id, { status: 'running', pid: process.pid });
    assert.deepEqual(failInterruptedRuns({ isAlive: (pid) => pid === process.pid }), [stuck.id]);
    assert.equal(getRun(stuck.id).status, 'failed');
    assert.equal(getRun(alive.id).status, 'running');
    assert.equal(listRuns({ status: 'completed' }).length, 1);
    assert.equal(listRuns({ limit: 2 }).length, 2);
    assert.equal(getRun('missing'), null);
  } finally { cleanup(dir); }
});
