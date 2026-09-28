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
import { Agent } from '../server/agent/agent.js';
import { getVaultDir, ensureVaultLayout } from '../server/vault/vault-dir.js';
import { parseMcpConfig } from '../server/mcp/config.js';
import { startMcpServers, stopMcpServers, getMcpStatus, toolResult } from '../server/mcp/mcp-tools.js';
import { classifyObservation } from '../server/agent/observation-filter.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-fake-server.js');

function mcpYaml({ tools = 'echo: { read: true, classification: public }\n      lookup: { read: true }\n      send: {}\n      env_probe: { read: true }\n      fail: { read: true }\n      crash: { read: true }\n      missing_tool: {}', extra = '' } = {}) {
  return `servers:
  fake:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(FAKE)}]
    env: { FAKE_SETTING: "vault \${VAULT}" }
    tools:
      ${tools}
${extra}`;
}

async function fixture(t, { yaml = mcpYaml(), vaultPolicy = null, plans = [], destination = 'local_model' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-mcp-'));
  process.env.U2OS_HOME = dir;
  process.env.U2OS_TEST_SECRET = 'must-not-leak';
  t.after(async () => {
    await stopMcpServers();
    closeAllForTests();
    delete process.env.U2OS_HOME; delete process.env.U2OS_TEST_SECRET;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const vault = ensureVaultLayout(getVaultDir());
  if (yaml !== null) fs.writeFileSync(path.join(vault, 'mcp.yaml'), yaml);
  if (vaultPolicy) fs.writeFileSync(path.join(vault, 'policies.yaml'), vaultPolicy);
  const toolRegistry = createToolRegistry();
  const status = await startMcpServers({ toolRegistry });
  const seen = [];
  const agent = new Agent({
    modelProvider: { id: 'fixture-model', destination, plan: async (context) => { seen.push(context); return plans[seen.length - 1] || { reasoning_summary: 'done', actions: [] }; } },
    policyEngine: new PolicyEngine(), toolRegistry, eventBus: new EventBus(getDb()),
  });
  return { vault, toolRegistry, status, agent, seen };
}

test('mcp.yaml is validated strictly and fails closed', () => {
  const parse = (raw) => parseMcpConfig(raw, { vaultDir: '/v' });
  const ok = parse({ servers: { jobs: { command: 'node', args: ['${U2OS_ROOT}/x.js', '${VAULT}'], tools: { search: { read: true, classification: 'public' }, apply: null } } } });
  assert.equal(ok[0].args[1], '/v');
  assert.ok(ok[0].args[0].endsWith('/x.js') && !ok[0].args[0].includes('${'));
  assert.deepEqual(ok[0].tools, [{ name: 'search', read: true, classification: 'public' }, { name: 'apply', read: false, classification: 'private' }]);
  assert.equal(ok[0].timeoutMs, 120_000);
  for (const [raw, message] of [
    [{}, /servers: mapping/],
    [{ servers: { email: { command: 'x', tools: { a: {} } } } }, /reserved/],
    [{ servers: { 'Bad-Name': { command: 'x', tools: { a: {} } } } }, /server names/],
    [{ servers: { jobs: { tools: { a: {} } } } }, /command/],
    [{ servers: { jobs: { command: 'x' } } }, /tools must list/],
    [{ servers: { jobs: { command: 'x', tools: { 'a.b': {} } } } }, /tool names/],
    [{ servers: { jobs: { command: 'x', tools: { a: { read: 'yes' } } } } }, /read must be/],
    [{ servers: { jobs: { command: 'x', tools: { a: { classification: 'secret' } } } } }, /classification/],
    [{ servers: { jobs: { command: 'x', timeout_seconds: 0, tools: { a: {} } } } }, /timeout_seconds/],
  ]) assert.throws(() => parse(raw), message);
});

test('only the tools the owner lists are registered, with owner-declared categories', async (t) => {
  const { toolRegistry, status } = await fixture(t);
  const [server] = status.servers;
  assert.equal(server.state, 'running');
  assert.deepEqual(server.tools.sort(), ['fake.crash', 'fake.echo', 'fake.env_probe', 'fake.fail', 'fake.lookup', 'fake.send']);
  assert.deepEqual(server.missingTools, ['missing_tool']);
  assert.equal(toolRegistry.has('fake.unlisted'), false);
  assert.equal(toolRegistry.get('fake.echo').category, 'read');
  // The server marks nothing about `send`; unlisted `read` means consequential.
  assert.equal(toolRegistry.get('fake.send').category, 'consequential');
  assert.equal(toolRegistry.get('fake.send').domain, 'fake');
  assert.match(toolRegistry.get('fake.echo').description, /Echo text back\. \(MCP server "fake"\)/);
  assert.ok(toolRegistry.list().some((tool) => tool.name === 'fake.send'), 'visible to the planner');
});

test('MCP calls go through the gate: reads run, unconfigured actions wait for confirmation', async (t) => {
  const { agent } = await fixture(t, { plans: [{ reasoning_summary: 'use fake tools', actions: [
    { tool: 'fake.echo', arguments: { text: 'hi' } },
    { tool: 'fake.send', arguments: { text: 'hello' } },
  ] }] });
  const result = await agent.handleMessage({ text: 'use the fake tools', actorId: 'owner' });
  assert.deepEqual(result.actions.map((action) => action.status), ['executed', 'pending']);
  assert.deepEqual(result.actions[0].result, { echoed: 'hi' });
  const audit = getDb().prepare("SELECT policy_rule FROM agent_actions WHERE tool = 'fake.send'").get();
  assert.equal(audit.policy_rule, 'fake.send:missing');
  const approved = await agent.approveAction(result.actions[1].id, 'owner');
  assert.equal(approved.status, 'executed');
  assert.deepEqual(approved.result, { sent: 'hello' });
});

test('the vault policy can make an MCP tool autonomous or forbid it', async (t) => {
  const { agent } = await fixture(t, { vaultPolicy: 'fake:\n  send: autonomous\n', plans: [{ reasoning_summary: 'send', actions: [{ tool: 'fake.send', arguments: { text: 'x' } }] }] });
  const result = await agent.handleMessage({ text: 'send it', actorId: 'owner' });
  assert.equal(result.actions[0].status, 'executed');
  fs.writeFileSync(path.join(getVaultDir(), 'policies.yaml'), 'fake:\n  send: never\n');
  const blocked = await agent.evaluateAndMaybeExecute({ actionId: 'act_never', tool: 'fake.send', arguments: { text: 'y' }, requestedBy: 'owner', requestText: 'send' });
  assert.equal(blocked.status, 'blocked');
});

test('tool servers get a minimal environment, the vault as working directory, and errors as failures', async (t) => {
  const { agent, vault } = await fixture(t, { plans: [{ reasoning_summary: 'probe', actions: [
    { tool: 'fake.env_probe', arguments: {} },
    { tool: 'fake.fail', arguments: {} },
  ] }] });
  const result = await agent.handleMessage({ text: 'probe', actorId: 'owner' });
  const probe = result.actions[0].result;
  assert.equal(probe.secret, null, 'U2OS environment secrets are not inherited');
  assert.equal(probe.configured, `vault ${vault}`);
  assert.equal(fs.realpathSync(probe.cwd), fs.realpathSync(vault));
  assert.equal(result.actions[1].status, 'failed');
  assert.match(result.actions[1].error, /upstream refused/);
});

test('owner-declared classifications decide what reaches a remote model', async (t) => {
  const { agent, seen } = await fixture(t, { destination: 'configured_remote_model', plans: [
    { reasoning_summary: 'look', continue: true, actions: [{ tool: 'fake.echo', arguments: { text: 'job posting' } }, { tool: 'fake.lookup', arguments: {} }] },
    { reasoning_summary: 'done', actions: [] },
  ] });
  await agent.handleMessage({ text: 'look things up', actorId: 'owner' });
  const observations = seen[1].observations;
  assert.deepEqual(observations.find((item) => item.tool === 'fake.echo').items[0].data, { echoed: 'job posting' });
  assert.deepEqual(observations.find((item) => item.tool === 'fake.lookup').items, [], 'private by default, withheld from a remote model');
  assert.equal(classifyObservation('fake.echo', { a: 1 }, true), 'private', 'history is never below private');
  assert.equal(classifyObservation('fake.echo', { classification: 'sensitive' }), 'sensitive', 'a result may tighten');
});

test('a crashed or slow server fails its call and is reported, never hanging U2OS', async (t) => {
  const slow = `  slow:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(FAKE)}]\n    timeout_seconds: 1\n    tools:\n      slow: { read: true }\n`;
  const { agent } = await fixture(t, { yaml: mcpYaml({ extra: slow }), plans: [
    { reasoning_summary: 'slow', actions: [{ tool: 'slow.slow', arguments: {} }] },
    { reasoning_summary: 'crash', actions: [{ tool: 'fake.crash', arguments: {} }] },
    { reasoning_summary: 'again', actions: [{ tool: 'fake.echo', arguments: { text: 'after crash' } }] },
  ] });
  const timedOut = await agent.handleMessage({ text: 'slow', actorId: 'owner' });
  assert.equal(timedOut.actions[0].status, 'failed');
  assert.match(timedOut.actions[0].error, /did not answer tools\/call within 1s/);
  const crashed = await agent.handleMessage({ text: 'crash', actorId: 'owner' });
  assert.equal(crashed.actions[0].status, 'failed');
  assert.match(crashed.actions[0].error, /exited/);
  assert.equal(getMcpStatus().servers.find((server) => server.name === 'fake').state, 'exited');
  const after = await agent.handleMessage({ text: 'again', actorId: 'owner' });
  assert.equal(after.actions[0].status, 'executed', 'restarted on the next call');
});

test('an invalid mcp.yaml, a name clash or a bad command starts nothing and is reported', async (t) => {
  const { status, toolRegistry } = await fixture(t, { yaml: 'servers: [nope]' });
  assert.match(status.error, /servers: mapping/);
  assert.deepEqual(status.servers, []);
  fs.writeFileSync(path.join(getVaultDir(), 'mcp.yaml'), 'servers:\n  broken:\n    command: /nonexistent/u2os-mcp\n    tools: { a: {} }\n');
  const broken = await startMcpServers({ toolRegistry });
  assert.equal(broken.servers[0].state, 'failed');
  assert.equal(toolRegistry.has('broken.a'), false);
  toolRegistry.register({ name: 'fixture.thing', domain: 'fixture', category: 'read', schema: {}, execute: async () => ({}) });
  fs.writeFileSync(path.join(getVaultDir(), 'mcp.yaml'), `servers:\n  fixture:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(FAKE)}]\n    tools: { echo: {} }\n`);
  const clash = await startMcpServers({ toolRegistry });
  assert.match(clash.servers[0].error, /already used/);
  assert.equal(toolRegistry.has('fixture.echo'), false);
});

test('a restart registers exactly the tools mcp.yaml lists now', async (t) => {
  const { toolRegistry } = await fixture(t);
  assert.ok(toolRegistry.has('fake.send'));
  fs.writeFileSync(path.join(getVaultDir(), 'mcp.yaml'), mcpYaml({ tools: 'echo: { read: true }' }));
  const status = await startMcpServers({ toolRegistry });
  assert.deepEqual(status.servers[0].tools, ['fake.echo']);
  assert.equal(toolRegistry.has('fake.send'), false, 'a tool the owner removed is gone without a U2OS restart');
  assert.ok(toolRegistry.has('email.send'), 'built-in tools are untouched');
  fs.writeFileSync(path.join(getVaultDir(), 'mcp.yaml'), mcpYaml({ tools: 'echo: { read: true }' }).replace('servers:\n  fake:', 'servers:\n  fake:\n    enabled: false'));
  assert.equal((await startMcpServers({ toolRegistry })).servers[0].state, 'disabled');
  assert.equal(toolRegistry.has('fake.echo'), false);
});

test('MCP results are plain JSON values', () => {
  assert.deepEqual(toolResult({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { b: 2 } }), { b: 2 });
  assert.deepEqual(toolResult({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.deepEqual(toolResult({ content: [{ type: 'text', text: 'plain' }] }), { text: 'plain' });
  assert.throws(() => toolResult({ isError: true, content: [{ type: 'text', text: 'nope' }] }), /nope/);
});
