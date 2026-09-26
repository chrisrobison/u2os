import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance, deleteConnectionInstance, findInstance, updateConnectionInstance, associateSmtpInstance } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { getAgentAction, updateAgentAction } from '../server/policy/policy-engine.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';
import { assertCalendarTarget } from '../server/agent/account-binding.js';
import { getProviderForBinding } from '../server/integrations/provider-registry.js';
import { captureAccountBinding } from '../server/integrations/provider-registry.js';
import { EmailSearchTool } from '../server/tools/email-tools.js';
import { Agent } from '../server/agent/agent.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { getRun } from '../server/agent/run-store.js';
import { createRun, recordRunPlan } from '../server/agent/run-store.js';
import { createConversation } from '../server/agent/conversation-store.js';

async function withAccounts(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-account-binding-'));
  process.env.U2OS_HOME = dir;
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const db = getDb();
    const create = (label, token) => {
      const account = createConnectionInstance(db, { connectorId: 'google', label, status: 'connected' });
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

test('read results retain the exact selected account and do not follow a later switch', async () => {
  await withAccounts(async ({ handle, dir, first, second }) => {
    const binding = captureAccountBinding('email');
    assert.equal(binding.instanceId, first.id);
    switchTo(dir, second.id);
    const previousFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        seen.push(options.headers.Authorization);
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return previousFetch(url, options);
    };
    try {
      assert.deepEqual(await new EmailSearchTool().execute({ query: 'fixture' }, { accountBinding: binding }), []);
      assert.deepEqual(seen, ['Bearer token-first']);
      const result = await handle.agent.evaluateAndMaybeExecute({
        tool: 'email.search', arguments: { query: 'fixture' }, requestedBy: 'owner',
        requestText: 'Search fixture', reasoningSummary: 'fixture', correlationId: 'corr_read_binding',
        actor: { type: 'user', id: 'owner' },
      });
      assert.equal(result.status, 'executed');
      assert.equal(getAgentAction(result.id).accountBinding.instanceId, second.id);
    } finally { globalThis.fetch = previousFetch; }
  });
});

test('a prior email reference reads from its source account after active selection changes', async () => {
  await withAccounts(async ({ db, dir, first, second }) => {
    const conversationId = createConversation('owner');
    const sourceRun = createRun({ correlationId: 'corr_prior_email', actorId: 'owner', objective: 'Search mail', conversationId });
    recordRunPlan(sourceRun, { reasoning_summary: 'Search', actions: [{ tool: 'email.search', arguments: { query: 'fixture' } }] });
    const sourceId = 'act_prior_email_fixture';
    const now = new Date().toISOString();
    const binding = captureAccountBinding('email');
    const messageId = `gmail_${first.id}_one`;
    db.prepare(`INSERT INTO agent_actions (id, requested_by, tool, arguments, status, result, account_binding, created_at, updated_at)
      VALUES (?, 'owner', 'email.search', '{}', 'executed', ?, ?, ?, ?)`).run(sourceId,
      JSON.stringify([{ id: messageId, subject: 'Recruiter' }]), JSON.stringify(binding), now, now);
    db.prepare("UPDATE agent_run_steps SET action_id = ?, status = 'executed' WHERE run_id = ? AND step_index = 0").run(sourceId, sourceRun);
    switchTo(dir, second.id);
    const previousFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('gmail.googleapis.com/gmail/v1/users/me/messages/')) {
        seen.push(options.headers.Authorization);
        return new Response(JSON.stringify({ id: 'one', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'Recruiter' }] } }), { status: 200 });
      }
      return previousFetch(url, options);
    };
    try {
      const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async (context) => {
        assert.equal(context.priorReadArtifacts[0].account.instanceId, first.id);
        assert.equal(context.priorReadArtifacts[0].accountBinding, undefined);
        assert.ok(!JSON.stringify(context.priorReadArtifacts).includes('credentialRevision'));
        return { reasoning_summary: 'Read the prior email', actions: [{ tool: 'email.read', arguments: { id: '' },
          priorResultRefs: { id: { actionId: sourceId, itemIndex: 0, path: 'id' } } }] };
      } }, policyEngine: new PolicyEngine(), toolRegistry: createToolRegistry(), eventBus: new EventBus(db) });
      const result = await agent.handleMessage({ text: 'Read that one', actorId: 'owner', conversationId });
      assert.equal(result.actions[0].status, 'executed');
      assert.equal(getAgentAction(result.actions[0].id).accountBinding.instanceId, first.id);
      assert.deepEqual(seen, ['Bearer token-first']);
      deleteConnectionInstance(db, { row: first, dataDir: dir });
      const blocked = await agent.handleMessage({ text: 'Read that one again', actorId: 'owner', conversationId });
      assert.equal(blocked.actions[0].status, 'blocked');
      assert.match(blocked.actions[0].reason, /deleted or disconnected/);
      assert.deepEqual(seen, ['Bearer token-first']);
    } finally { globalThis.fetch = previousFetch; }
  });
});

test('a deferred send retains the selected account before its prerequisite is approved', async () => {
  await withAccounts(async ({ db, dir, first, second }) => {
    const agent = new Agent({
      modelProvider: { id: 'account-plan-fixture', destination: 'local_model', plan: async () => ({
        reasoning_summary: 'Create a task, then prepare the send', actions: [
          { tool: 'tasks.create', arguments: { title: 'First step' } },
          { tool: 'email.send', arguments: { to: 'recipient@example.test', subject: 'Fixture', body: 'Fixture body' }, dependsOn: [0] },
        ],
      }) },
      policyEngine: new PolicyEngine({ policies: { tasks: { create: 'confirm' }, email: { send: 'confirm' } } }),
      toolRegistry: createToolRegistry(), eventBus: new EventBus(db),
    });
    const result = await agent.handleMessage({ text: 'Create task, then send mail', actorId: 'owner' });
    assert.deepEqual(result.actions.map((item) => item.status), ['pending', 'waiting_dependency']);
    assert.equal(JSON.parse(db.prepare('SELECT account_context FROM agent_run_steps WHERE run_id = ? AND step_index = 1').get(result.runId).account_context).binding.instanceId, first.id);
    switchTo(dir, second.id);
    await agent.approveAction(result.actions[0].id, 'owner');
    const sendId = getRun(result.runId).steps[1].actionId;
    assert.equal(getAgentAction(sendId).status, 'pending');
    assert.equal(getAgentAction(sendId).accountBinding.instanceId, first.id);
    assert.equal(getAgentAction(sendId).model, 'account-plan-fixture');
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

test('an IMAP send records its SMTP instance and blocks if that sender changes', async () => {
  await withAccounts(async ({ handle, db, dir }) => {
    const imap = createConnectionInstance(db, { connectorId: 'imap', label: 'Inbox', status: 'connected', credentials: { host: 'imap.example.test', port: 993, username: 'owner@example.test', password: 'fixture' }, dataDir: dir });
    const config = loadConnectorsConfig(dir);
    config.email = { active: 'imap', activeInstanceId: imap.id };
    saveConnectorsConfig(config, dir);
    const smtp = { host: 'smtp.example.test', port: 587, username: 'owner@example.test', password: 'fixture', from: 'owner@example.test' };
    const sender = createConnectionInstance(db, { connectorId: 'smtp', label: 'Sender', status: 'connected', credentials: smtp, dataDir: dir });
    associateSmtpInstance(db, { imapRow: findInstance(db, 'imap', imap.id), smtpInstanceId: sender.id });
    const proposal = await proposeSend(handle.agent);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.accountBinding.smtpIdentity.from, 'owner@example.test');
    updateConnectionInstance(db, { row: findInstance(db, 'smtp', sender.id), credentials: { ...smtp, from: 'other@example.test' }, dataDir: dir });
    const outcome = await handle.agent.approveAction(proposal.id, 'owner');
    assert.equal(outcome.status, 'blocked');
    assert.match(outcome.reason, /SMTP sender identity changed/);
  });
});

test('switching an IMAP sender after approval blocks rather than using the new SMTP account', async () => {
  await withAccounts(async ({ handle, db, dir }) => {
    const imap = createConnectionInstance(db, { connectorId: 'imap', label: 'Inbox', status: 'connected', credentials: { host: 'imap.example.test', port: 993, username: 'owner@example.test', password: 'fixture' }, dataDir: dir });
    const first = createConnectionInstance(db, { connectorId: 'smtp', label: 'First sender', status: 'connected', credentials: { host: 'smtp.example.test', port: 587, username: 'first@example.test', password: 'fixture', from: 'first@example.test' }, dataDir: dir });
    const second = createConnectionInstance(db, { connectorId: 'smtp', label: 'Second sender', status: 'connected', credentials: { host: 'smtp.example.test', port: 587, username: 'second@example.test', password: 'fixture', from: 'second@example.test' }, dataDir: dir });
    associateSmtpInstance(db, { imapRow: findInstance(db, 'imap', imap.id), smtpInstanceId: first.id });
    const config = loadConnectorsConfig(dir);
    config.email = { active: 'imap', activeInstanceId: imap.id };
    saveConnectorsConfig(config, dir);
    const proposal = await proposeSend(handle.agent);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.accountBinding.smtpIdentity.instanceId, first.id);
    associateSmtpInstance(db, { imapRow: findInstance(db, 'imap', imap.id), smtpInstanceId: second.id });
    const outcome = await handle.agent.approveAction(proposal.id, 'owner');
    assert.equal(outcome.status, 'blocked');
    assert.match(outcome.reason, /reconnected or changed|sender identity changed/);
  });
});
