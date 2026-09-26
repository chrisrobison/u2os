import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { recordAudit } from '../server/policy/policy-engine.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import { buildOperationsResponse } from '../server/api/routes/actions.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';

function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-operations-'));
  process.env.U2OS_HOME = dir;
  try { return fn(); } finally {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('operations response groups pending and durable work without exposing arguments, actors, keys, or provider errors', () => withHome(() => {
  const pending = recordAudit({
    requestedBy: 'owner', tool: 'email.send', arguments: { body: 'private body' },
    status: 'pending', correlationId: 'corr_pending', requiresApproval: true,
  });
  const failed = recordAudit({
    requestedBy: 'owner', tool: 'calendar.create', arguments: { title: 'private title' },
    status: 'failed', correlationId: 'corr_failed', requiresApproval: false,
  });
  const queued = enqueueAction({
    actionId: failed.id, correlationId: failed.correlation_id, tool: failed.tool,
    arguments: failed.arguments, actor: { type: 'user', id: 'secret-owner-id' },
  });
  getDb().prepare(`
    UPDATE action_queue SET status = 'failed', error_class = 'authentication_required',
      last_error = 'token super-secret-token was rejected' WHERE id = ?
  `).run(queued.id);

  const response = buildOperationsResponse();
  assert.equal(response.counts.waiting_approval, 1);
  assert.equal(response.counts.failed, 1);
  assert.equal(response.items.find((item) => item.actionId === pending.id).status, 'waiting_approval');
  assert.equal(response.items.find((item) => item.actionId === failed.id).errorClass, 'authentication_required');
  const serialized = JSON.stringify(response);
  for (const secret of ['private body', 'private title', 'secret-owner-id', 'super-secret-token', 'idempotency']) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
}));

test('operation account metadata retains original pending/queued identities after account switch/removal without private binding fields', () => withHome(() => {
  const db = getDb(), original = createConnectionInstance(db, { connectorId: 'google', label: 'Original fixture account', status: 'connected' });
  const other = createConnectionInstance(db, { connectorId: 'google', label: 'Other fixture account', status: 'connected' });
  const binding = { providerId: 'gmail', instanceId: original.id, label: original.label, credentialRevision: 7,
    vaultKey: 'fixture-private-vault', access_token: 'fixture-private-token', extra: { secret: 'fixture-private-secret' } };
  const pending = recordAudit({ requestedBy: 'owner', tool: 'email.send', arguments: { to: 'private-recipient@example.test', body: 'fixture-private-body' }, status: 'pending', requiresApproval: true, accountBinding: binding });
  const approved = recordAudit({ requestedBy: 'owner', tool: 'email.send', arguments: { body: 'fixture-private-body' }, status: 'approved', accountBinding: binding });
  const queued = enqueueAction({ actionId: approved.id, tool: approved.tool, arguments: approved.arguments });
  db.prepare("UPDATE action_queue SET status='failed', error_class='outcome_uncertain', last_error='fixture-private-error' WHERE id=?").run(queued.id);
  const config = loadConnectorsConfig(); config.email = { ...config.email, active: 'gmail', activeInstanceId: other.id }; saveConnectorsConfig(config);
  db.prepare('DELETE FROM connection_instances WHERE id=?').run(original.id);
  const expected = { providerId: 'gmail', instanceId: original.id, label: original.label };
  const result = buildOperationsResponse();
  assert.deepEqual(result.items.find((item) => item.actionId === pending.id).account, expected);
  assert.deepEqual(result.items.find((item) => item.actionId === approved.id).account, expected);
  assert.equal(result.items.find((item) => item.actionId === approved.id).errorClass, 'outcome_uncertain');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|private-recipient|credentialRevision|vaultKey|Other fixture/);
}));

test('operation metadata exposes only exact associated SMTP sender identity, not its transport credentials/configuration', () => withHome(() => {
  const binding = { providerId: 'imap', instanceId: 'fixture_inbox', label: 'Fixture inbox', smtpIdentity: {
    instanceId: 'fixture_sender', label: 'Original SMTP fixture', from: 'owner@example.test', credentialRevision: 3,
    host: 'private-host.example.test', username: 'fixture-private-user', password: 'fixture-private-password', tls: true,
  } };
  const pending = recordAudit({ requestedBy: 'owner', tool: 'email.send', arguments: {}, status: 'pending', accountBinding: binding });
  const account = buildOperationsResponse().items.find((item) => item.actionId === pending.id).account;
  assert.deepEqual(account, { providerId: 'imap', instanceId: 'fixture_inbox', label: 'Fixture inbox', smtpIdentity: {
    instanceId: 'fixture_sender', label: 'Original SMTP fixture', from: 'owner@example.test',
  } });
  assert.doesNotMatch(JSON.stringify(account), /fixture-private|private-host|credentialRevision|username|password|tls/);
}));

test('legacy/corrupt operations have unavailable account without parsing private bodies; explicit mock identity remains distinct', () => withHome(() => {
  const db = getDb(), ids = [];
  for (const binding of [null, '{malformed', JSON.stringify({ providerId: 'gmail', instanceId: 'missing_label' }), JSON.stringify({ providerId: 'gmail', label: 'No instance' })]) {
    const action = recordAudit({ requestedBy: 'owner', tool: 'email.send', arguments: {}, status: 'approved' });
    enqueueAction({ actionId: action.id, tool: action.tool, arguments: {} }); ids.push(action.id);
    db.prepare('UPDATE agent_actions SET account_binding=?, arguments=?, result=? WHERE id=?').run(binding, '{private-malformed-body', '{private-malformed-result', action.id);
  }
  const mock = recordAudit({ requestedBy: 'owner', tool: 'email.send', arguments: {}, status: 'approved', accountBinding: { providerId: 'mock', label: 'Mock', instanceId: null, vaultKey: 'fixture-private' } });
  enqueueAction({ actionId: mock.id, tool: mock.tool, arguments: {} });
  const result = buildOperationsResponse();
  for (const id of ids) assert.equal(result.items.find((item) => item.actionId === id).account, null);
  assert.deepEqual(result.items.find((item) => item.actionId === mock.id).account, { providerId: 'mock', label: 'Mock', instanceId: null });
  assert.doesNotMatch(JSON.stringify(result), /private|malformed/);
}));
