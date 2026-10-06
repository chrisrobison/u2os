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
import { startMcpServers, stopMcpServers } from '../server/mcp/mcp-tools.js';
import { updateAddonDecisions } from '../server/addons/decisions.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'addon-fake-server.js');
const MANIFEST = `apiVersion: u2os/v1
kind: Addon
metadata: { id: fakemail, name: Fake mail, version: 0.1.0 }
servers:
  fakemail:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(FAKE)}, "--limit=\${setting.limit}"]
    env: { FAKE_LIMIT: "\${setting.limit}" }
    tools:
      mail_unread: { tool: mail, fixed: { operation: unread }, read: true, classification: personal, description: Read unread mail. }
      mail_send: { tool: mail, fixed: { operation: send }, description: Send a message. }
      ghost: { tool: not_offered }
settings:
  limit: { type: number, default: 5 }
`;

async function fixture(t, { decisions, mcpYaml = null, plans = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-addon-runtime-'));
  process.env.U2OS_HOME = dir;
  t.after(async () => { await stopMcpServers(); closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'addons', 'fakemail'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'addons', 'fakemail', 'addon.yaml'), MANIFEST);
  const vault = ensureVaultLayout(getVaultDir());
  if (mcpYaml) fs.writeFileSync(path.join(vault, 'mcp.yaml'), mcpYaml);
  if (decisions) updateAddonDecisions(decisions, vault);
  const toolRegistry = createToolRegistry();
  const status = await startMcpServers({ toolRegistry });
  const seen = [];
  const agent = new Agent({
    modelProvider: { id: 'fixture-model', destination: 'local_model', plan: async () => plans[seen.push(1) - 1] || { reasoning_summary: 'done', actions: [] } },
    policyEngine: new PolicyEngine(), toolRegistry, eventBus: new EventBus(getDb()),
  });
  return { vault, toolRegistry, status, agent };
}

const enabled = (tools = {}, settings = {}) => (a) => { a.fakemail = { enabled: true, settings, tools }; };

test('a disabled or unlisted add-on registers nothing and starts nothing', async (t) => {
  const { toolRegistry, status } = await fixture(t);
  assert.deepEqual(status.servers, []);
  assert.ok(!toolRegistry.list().some((tool) => tool.name.startsWith('fakemail.')));
});

test('an enabled add-on exposes each variant as its own tool; unconfirmed ones are confirm-required actions', async (t) => {
  const { toolRegistry, status } = await fixture(t, { decisions: enabled() });
  const [server] = status.servers;
  assert.equal(server.state, 'running'); assert.equal(server.addon, 'fakemail');
  assert.deepEqual(server.tools.sort(), ['fakemail.mail_send', 'fakemail.mail_unread']);
  assert.deepEqual(server.missingTools, ['ghost']);
  // the manifest SUGGESTS mail_unread is read-only; unconfirmed, it is not
  assert.equal(toolRegistry.get('fakemail.mail_unread').category, 'consequential');
  assert.equal(toolRegistry.get('fakemail.mail_send').category, 'consequential');
  assert.match(toolRegistry.get('fakemail.mail_unread').description, /Read unread mail\. \(MCP server "fakemail"\)/);
});

test('confirming a tool makes it read-only; fixed arguments cannot be overridden or even seen by the model', async (t) => {
  const { toolRegistry } = await fixture(t, { decisions: enabled({ mail_unread: { read: true, classification: 'personal' } }) });
  const unread = toolRegistry.get('fakemail.mail_unread');
  assert.equal(unread.category, 'read');
  assert.ok(!('operation' in unread.schema.properties) && !unread.schema.required.includes('operation'));
  assert.ok('to' in unread.schema.properties);
  const result = await unread.execute({ operation: 'send', to: 'x@example.com' });
  assert.equal(result.ran, 'unread', 'the model cannot override a fixed argument');
  assert.equal((await toolRegistry.get('fakemail.mail_send').execute({ to: 'a@b.c', operation: 'unread' })).ran, 'send');
});

test('settings are substituted into args and env', async (t) => {
  const { toolRegistry } = await fixture(t, { decisions: enabled({}, { limit: 25 }) });
  const result = await toolRegistry.get('fakemail.mail_send').execute({});
  assert.ok(result.argv.includes('--limit=25')); assert.equal(result.setting, '25');
});

test('calls go through the gate: a confirmed read runs, send waits for approval, and policy can still forbid', async (t) => {
  const { agent } = await fixture(t, { decisions: enabled({ mail_unread: { read: true, classification: 'personal' } }), plans: [{ reasoning_summary: 'mail', actions: [
    { tool: 'fakemail.mail_unread', arguments: {} }, { tool: 'fakemail.mail_send', arguments: { to: 'a@b.c' } },
  ] }] });
  const result = await agent.handleMessage({ text: 'check and reply', actorId: 'owner' });
  assert.deepEqual(result.actions.map((a) => a.status), ['executed', 'pending']);
  assert.equal(result.actions[0].result.ran, 'unread');
  const approved = await agent.approveAction(result.actions[1].id, 'owner');
  assert.equal(approved.status, 'executed'); assert.equal(approved.result.ran, 'send');
});

test('a server in mcp.yaml wins a name clash with an add-on', async (t) => {
  const mcpYaml = `servers:\n  fakemail:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(FAKE)}]\n    tools:\n      mail: { read: true }\n`;
  const { status, toolRegistry } = await fixture(t, { decisions: enabled(), mcpYaml });
  const byAddon = status.servers.find((s) => s.addon === 'fakemail');
  assert.equal(byAddon.state, 'failed'); assert.match(byAddon.error, /already used/);
  assert.ok(toolRegistry.get('fakemail.mail'), 'the mcp.yaml tool is the one registered');
  assert.equal(toolRegistry.list().some((tool) => tool.name === 'fakemail.mail_send'), false);
});

test('an invalid addons.yaml starts no add-on servers', async (t) => {
  const { vault, status } = await fixture(t);
  fs.writeFileSync(path.join(vault, 'addons.yaml'), 'addons: [');
  const toolRegistry = createToolRegistry();
  const after = await startMcpServers({ toolRegistry });
  assert.deepEqual(after.servers, []); assert.deepEqual(status.servers, []);
});
