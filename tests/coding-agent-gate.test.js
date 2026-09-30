import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { createPackagePlatform } from '../server/packages/platform.js';
import { CliCodingAgentProvider } from '../server/coding-agent/cli-provider.js';
import { CodingAgentRegistry } from '../server/coding-agent/registry.js';
import { CodingAgentService } from '../server/coding-agent/service.js';
import { defaultCodingAgentConfig } from '../server/coding-agent/config.js';
import { isReservedEventType } from '../server/packages/events.js';

const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-coding-cli.js');

class MockProvider extends CliCodingAgentProvider {
  get id() { return 'mock'; }
  get name() { return 'Mock CLI'; }
  get defaultExecutable() { return process.execPath; }
  get versionArgs() { return [MOCK, 'version']; }
  buildInvocation(task) { return { args: [MOCK, 'ok'], stdin: task.task }; }
}

function setup(policies) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-gate-')));
  process.env.U2OS_HOME = home;
  ensureInstallationMode('demo', home);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-gate-proj-')));
  const eventBus = new EventBus(getDb());
  const agent = new Agent({ modelProvider: new MockModelProvider(), policyEngine: new PolicyEngine({ policies }), toolRegistry: createToolRegistry(), eventBus });
  const registry = new CodingAgentRegistry({ configLoader: () => defaultCodingAgentConfig() });
  registry.register(new MockProvider());
  const codingAgents = new CodingAgentService({ registry, eventBus });
  const platform = createPackagePlatform({ agent, eventBus, dataDir: home, codingAgents });
  const cleanup = async () => { await platform.runtime.stop(); closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); };
  return { agent, platform, project, codingAgents, cleanup };
}

test('coding.agent is a capability but never a planner tool', async () => {
  const { agent, platform, cleanup } = setup({});
  try {
    assert.ok(platform.registries.capabilities.has('coding.agent'));
    assert.equal(platform.registries.capabilities.get('coding.agent').requiredPermissions[0], 'shell.execute');
    assert.ok(agent.toolRegistry.has('coding.agent'));
    assert.ok(agent.toolRegistry.isHidden('coding.agent'));
    assert.equal(agent.toolRegistry.list().some((tool) => tool.name === 'coding.agent'), false);
  } finally { await cleanup(); }
});

test('the coding package event domain is reserved', () => {
  assert.equal(isReservedEventType('coding.agent.completed'), true);
});

test('gate: with no policy, a proposed run waits for approval and does not execute', async () => {
  const { agent, project, codingAgents, cleanup } = setup({});
  try {
    const outcome = await agent.evaluateAndMaybeExecute({ tool: 'coding.agent', arguments: { task: 'explain', cwd: project }, requestedBy: 'owner', actor: { type: 'owner', id: 'o' }, reasoningSummary: 'test' });
    assert.equal(outcome.status, 'pending');
    assert.equal(codingAgents.list().length, 0);
    const approved = await agent.approveAction(outcome.id, 'owner');
    assert.equal(approved.status, 'executed');
    const [run] = codingAgents.list();
    assert.equal(run.status, 'completed');
    assert.match(run.requestedBy, /^(user|owner):/);
  } finally { await cleanup(); }
});

test('gate: policy never blocks the run', async () => {
  const { agent, project, codingAgents, cleanup } = setup({ coding: { agent: 'never' } });
  try {
    const outcome = await agent.evaluateAndMaybeExecute({ tool: 'coding.agent', arguments: { task: 'explain', cwd: project }, requestedBy: 'owner', actor: { type: 'owner', id: 'o' }, reasoningSummary: 'test' });
    assert.equal(outcome.status, 'blocked');
    assert.equal(codingAgents.list().length, 0);
  } finally { await cleanup(); }
});
