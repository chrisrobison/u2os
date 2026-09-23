import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance, deleteConnectionInstance, findInstance, updateConnectionInstance } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { getAgentAction, updateAgentAction } from '../server/policy/policy-engine.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';
import { assertCalendarTarget } from '../server/agent/account-binding.js';
import { getProviderForBinding } from '../server/integrations/provider-registry.js';
import { writeEncryptedFile } from '../server/security/vault.js';

async function withAccounts(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-account-binding-'));
  process.env.U2OS_HOME = dir;
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const db = getDb();
    const create = (label, token) => {
      const account = createConnectionInstance(db, { connectorId: 'google', label, status: 'pending' });
      const row = findInstance(db, 'google', account.id);
      storeTokens(row.vault_key, 'gmail', { access_token: token, refresh_token: `refresh-${token}`, expires_in: 3600 }, dir);
      return row;
    };
    const first = create('First', 'token-first');
    const second = create('Second', 'token-second');
    const config = loadConnectorsConfig(dir);
    config.email = { ...config.email, active: 'gmail', activeInstanceId: first.id };
    saveConnectorsConfig(config, dir);
    await run({ handle, db, dir, first, second });
  } finally {
    syncScheduler.stopAll();
    await triggerEngine.stopAll();
    if (handle?.server) await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function switchTo(dir, instanceId) {
  const config = loadConnectorsConfig(dir);
  config.email = { ...config.email, active: 'gmail', activeInstanceId: instanceId };
  saveConnectorsConfig(config, dir);
}

function proposeSend(agent) {
  return agent.evaluateAndMaybeExecute({
    tool: 'email.send', arguments: { to: 'recipient@example.test', subject: 'Fixture', body: 'Fixture body' },
    requestedBy: 'owner', requestText: 'Send the fixture', reasoningSummary: 'fixture',
    correlationId: 'corr_binding_fixture', actor: { type: 'user', id: 'owner' },
  });
}

test('approved email send retains the original Google account after active account changes', async () => {
  await withAccounts(async ({ handle, dir, first, second }) => {
    const proposal = await proposeSend(handle.agent);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.accountBinding.instanceId, first.id);
    assert.equal(getAgentAction(proposal.id).accountBinding.label, 'First');
    switchTo(dir, second.id);

    const previousFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (input, options) => {
      if (String(input).includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        seen.push(options.headers.Authorization);
        return { ok: true, json: async () => ({ id: 'fixture-sent', threadId: 'fixture-thread' }) };
      }
      return previousFetch(input, options);
    };
    try {
      const outcome = await handle.agent.approveAction(proposal.id, 'owner');
      assert.equal(outcome.status, 'executed');
      assert.deepEqual(seen, ['Bearer token-first']);
      assert.equal(getAgentAction(proposal.id).accountBinding.instanceId, first.id);
    } finally { globalThis.fetch = previousFetch; }
  });
});

test('deleting the approved account blocks the pending send without attempting delivery', async () => {
  await withAccounts(async ({ handle, db, dir, first, second }) => {
    const proposal = await proposeSend(handle.agent);
    const sentBefore = db.prepare("SELECT count(*) AS n FROM emails WHERE folder = 'sent'").get().n;
    switchTo(dir, second.id);
    deleteConnectionInstance(db, { row: first, dataDir: dir });
    const outcome = await handle.agent.approveAction(proposal.id, 'owner');
    assert.equal(outcome.status, 'blocked');
    assert.match(outcome.reason, /deleted or disconnected/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM emails WHERE folder = 'sent'").get().n, sentBefore);
  });
});

test('changing credentials invalidates the prior approval while renaming does not change account identity', async () => {
  await withAccounts(async ({ handle, db, dir, first }) => {
    const proposal = await proposeSend(handle.agent);
    updateConnectionInstance(db, { row: first, label: 'Renamed', dataDir: dir });
    assert.equal(findInstance(db, 'google', first.id).credential_revision, proposal.accountBinding.credentialRevision);
    updateConnectionInstance(db, { row: findInstance(db, 'google', first.id), credentials: { tokens: { gmail: { access_token: 'new-token', refresh_token: 'new-refresh', expiry: Date.now() + 3600_000 } } }, dataDir: dir });
    const outcome = await handle.agent.approveAction(proposal.id, 'owner');
    assert.equal(outcome.status, 'blocked');
    assert.match(outcome.reason, /new approval/);
  });
});

test('a calendar event from another account cannot be rescheduled with the selected account', async () => {
  await withAccounts(async ({ db, first, second }) => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO calendar_events (id, title, start_at, end_at, attendees, category, status, source, created_at, updated_at)
      VALUES (?, 'Fixture', ?, ?, '[]', 'personal', 'confirmed', 'google-calendar', ?, ?)`).run(
      `gcal_${second.id}_event`, now, now, now, now,
    );
    assert.throws(
      () => assertCalendarTarget({ providerId: 'google-calendar', instanceId: first.id }, `gcal_${second.id}_event`),
      /different account/,
    );
  });
});

test('the action account binding survives reopening SQLite', async () => {
  await withAccounts(async ({ handle, first, second, dir }) => {
    const proposal = await proposeSend(handle.agent);
    switchTo(dir, second.id);
    closeAllForTests();
    const stored = getAgentAction(proposal.id);
    assert.equal(stored.accountBinding.instanceId, first.id);
    assert.equal(getProviderForBinding('email', stored.accountBinding).id, 'gmail');
  });
});

test('queued payload changes stop before an approved send is attempted', async () => {
  await withAccounts(async ({ handle }) => {
    const proposal = await proposeSend(handle.agent);
    updateAgentAction(proposal.id, { status: 'approved', approvedBy: 'owner', approvedAt: new Date().toISOString() });
    enqueueAction({
      actionId: proposal.id, correlationId: 'corr_binding_fixture', tool: 'email.send',
      arguments: { ...proposal.arguments, to: 'different@example.test' },
      actor: { type: 'user', id: 'owner' }, approvalReference: proposal.id,
    });
    const outcome = await handle.agent.actionQueueWorker.processAction(proposal.id);
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /differs from the approved proposal/);
  });
});

test('an IMAP send records the global SMTP sender and blocks if that sender changes', async () => {
  await withAccounts(async ({ handle, db, dir }) => {
    const imap = createConnectionInstance(db, { connectorId: 'imap', label: 'Inbox', status: 'connected', credentials: { host: 'imap.example.test', port: 993, username: 'owner@example.test', password: 'fixture' }, dataDir: dir });
    const config = loadConnectorsConfig(dir);
    config.email = { active: 'imap', activeInstanceId: imap.id };
    saveConnectorsConfig(config, dir);
    const smtp = { host: 'smtp.example.test', port: 587, username: 'owner@example.test', password: 'fixture', from: 'owner@example.test' };
    writeEncryptedFile('smtp', smtp, dir);
    const proposal = await proposeSend(handle.agent);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.accountBinding.smtpIdentity.from, 'owner@example.test');
    writeEncryptedFile('smtp', { ...smtp, from: 'other@example.test' }, dir);
    const outcome = await handle.agent.approveAction(proposal.id, 'owner');
    assert.equal(outcome.status, 'blocked');
    assert.match(outcome.reason, /SMTP sender identity changed/);
  });
});
