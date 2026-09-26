import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance, findInstance, updateConnectionInstance, deleteConnectionInstance } from '../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { Agent } from '../server/agent/agent.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine, getAgentAction, updateAgentAction } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { enqueueAction, getQueuedActionByActionId, leaseActionByActionId, beginActionAttempt } from '../server/agent/action-queue-store.js';
import { deleteEncryptedFile } from '../server/security/vault.js';

async function withAccounts(run) {
  const savedHome = process.env.U2OS_HOME;
  const originalFetch = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-notification-binding-'));
  process.env.U2OS_HOME = dir;
  try {
    const db = getDb();
    const create = (label, token) => createConnectionInstance(db, { connectorId: 'webhook', label,
      status: 'connected', credentials: { webhookUrl: `https://notify.example.test/${token}`, format: 'json' }, dataDir: dir });
    const first = create('First notifications', 'private-first-token');
    const second = create('Second notifications', 'private-second-token');
    const select = (id) => {
      const config = loadConnectorsConfig(dir);
      config.notifications = { ...config.notifications, active: 'webhook', activeInstanceId: id };
      saveConnectorsConfig(config, dir);
    };
    select(first.id);
    const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model' },
      policyEngine: new PolicyEngine({ policies: { notifications: { send: 'confirm' } } }),
      toolRegistry: createToolRegistry(), eventBus: new EventBus(db) });
    const seen = [];
    globalThis.fetch = async (url) => { seen.push(String(url)); return new Response(null, { status: 204 }); };
    const propose = () => agent.evaluateAndMaybeExecute({ tool: 'notifications.send',
      arguments: { title: 'Fixture update', body: 'Review the fixture finding.' }, requestedBy: 'owner',
      requestText: 'Notify me', reasoningSummary: 'Fixture', correlationId: 'corr_notify_binding', actor: { type: 'user', id: 'owner' } });
    const queue = (proposal) => {
      updateAgentAction(proposal.id, { status: 'approved', approvedBy: 'owner', approvedAt: new Date().toISOString() });
      return enqueueAction({ actionId: proposal.id, tool: proposal.tool, arguments: proposal.arguments,
        approvalReference: proposal.id, actor: { type: 'user', id: 'owner' } });
    };
    await run({ agent, db, dir, first, second, select, seen, propose, queue });
  } finally {
    globalThis.fetch = originalFetch;
    closeAllForTests();
    if (savedHome === undefined) delete process.env.U2OS_HOME;
    else process.env.U2OS_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('approved notification uses its named account after active selection changes', () => withAccounts(async ({ agent, first, second, select, seen, propose }) => {
  const proposal = await propose();
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.accountBinding.instanceId, first.id);
  assert.equal(proposal.accountBinding.label, 'First notifications');
  assert.ok(Number.isInteger(proposal.accountBinding.credentialRevision));
  assert.ok(!JSON.stringify(getAgentAction(proposal.id)).includes('private-first-token'));
  select(second.id);
  assert.equal((await agent.approveAction(proposal.id, 'owner')).status, 'executed');
  assert.deepEqual(seen, ['https://notify.example.test/private-first-token']);
}));

test('queued notification binding survives SQLite reopen and does not send twice', () => withAccounts(async ({ first, second, select, seen, propose, queue }) => {
  const proposal = await propose();
  queue(proposal);
  select(second.id);
  closeAllForTests();
  const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model' },
    policyEngine: new PolicyEngine({ policies: { notifications: { send: 'confirm' } } }),
    toolRegistry: createToolRegistry(), eventBus: new EventBus(getDb()) });
  assert.equal(getAgentAction(proposal.id).accountBinding.instanceId, first.id);
  assert.equal((await agent.actionQueueWorker.processAction(proposal.id)).status, 'executed');
  await agent.actionQueueWorker.processAction(proposal.id);
  assert.deepEqual(seen, ['https://notify.example.test/private-first-token']);
  assert.equal(getQueuedActionByActionId(proposal.id).attempt_count, 1);
}));

for (const invalidation of ['deleted', 'disconnected', 'retained credentials with disconnected status', 'reconnected', 'legacy missing binding']) {
  test(`queued notification with ${invalidation} stops without attempting delivery`, () => withAccounts(async ({ agent, db, dir, first, second, select, seen, propose, queue }) => {
    const proposal = await propose();
    queue(proposal);
    select(second.id);
    const row = findInstance(db, 'webhook', first.id);
    if (invalidation === 'deleted') deleteConnectionInstance(db, { row, dataDir: dir });
    if (invalidation === 'disconnected') deleteEncryptedFile(row.vault_key, dir);
    if (invalidation === 'retained credentials with disconnected status') db.prepare("UPDATE connection_instances SET status = 'disconnected' WHERE id = ?").run(row.id);
    if (invalidation === 'reconnected') updateConnectionInstance(db, { row, credentials: { webhookUrl: 'https://notify.example.test/replaced-token', format: 'json' }, dataDir: dir });
    if (invalidation === 'legacy missing binding') db.prepare('UPDATE agent_actions SET account_binding = NULL WHERE id = ?').run(proposal.id);
    const result = await agent.actionQueueWorker.processAction(proposal.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorClass, 'owner_attention_required');
    assert.match(result.error, /no action was attempted|new approval is required|owner review required/);
    assert.deepEqual(seen, []);
    assert.equal(getQueuedActionByActionId(proposal.id).attempt_count, 0);
  }));
}

test('recovered uncertain notification attempt is not delivered again', () => withAccounts(async ({ agent, db, seen, propose, queue }) => {
  const proposal = await propose();
  const item = queue(proposal);
  leaseActionByActionId(proposal.id, { leaseOwner: 'interrupted-worker', leaseMs: 1000 });
  beginActionAttempt({ queueId: item.id, leaseOwner: 'interrupted-worker' });
  db.prepare("UPDATE action_queue SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(item.id);
  const result = await agent.actionQueueWorker.processAction(proposal.id);
  assert.equal(result.errorClass, 'outcome_uncertain');
  assert.match(result.error, /outcome is uncertain/);
  assert.deepEqual(seen, []);
  assert.equal(getQueuedActionByActionId(proposal.id).attempt_count, 1);
}));

test('material notification payload change cannot use an existing approval', () => withAccounts(async ({ agent, db, seen, propose, queue }) => {
  const proposal = await propose();
  const item = queue(proposal);
  db.prepare('UPDATE action_queue SET arguments = ? WHERE id = ?').run(JSON.stringify({ ...proposal.arguments, body: 'Changed body' }), item.id);
  const result = await agent.actionQueueWorker.processAction(proposal.id);
  assert.match(result.error, /differs from the approved proposal/);
  assert.deepEqual(seen, []);
  assert.equal(getQueuedActionByActionId(proposal.id).attempt_count, 0);
}));
