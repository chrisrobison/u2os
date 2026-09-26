import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { sendEmail } from '../server/integrations/gmail-provider.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { Agent } from '../server/agent/agent.js';
import { PolicyEngine, getAgentAction } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { EventBus } from '../server/events/event-bus.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { getQueuedActionByActionId, listActionAttempts, requeueAction } from '../server/agent/action-queue-store.js';
import { classifyActionError } from '../server/agent/action-error-classifier.js';

const PRIVATE = 'fixture-private-send-provider-token-body';
const message = { to: 'recipient@example.test', subject: 'Approved fixture subject', body: 'Approved fixture body' };
const uncertain = (error) => {
  assert.equal(error.code, 'GMAIL_SEND_OUTCOME_UNCERTAIN'); assert.equal(error.actionErrorClass, 'outcome_uncertain');
  assert.equal(error.safeToRetry, false); assert.match(error.message, /outcome uncertain.*Sent mail.*no automatic retry/);
  assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/); assert.equal(classifyActionError(error), 'outcome_uncertain'); return true;
};
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-gmail-ack-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), created = createConnectionInstance(db, { connectorId: 'google', label: 'Selected fixture account', status: 'connected', dataDir: home });
    const instance = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(created.id);
    storeTokens(instance.vault_key, 'gmail', { access_token: 'fixture-valid', refresh_token: 'fixture-refresh', expires_in: 3600 }, home);
    const config = loadConnectorsConfig(home); config.email = { ...config.email, active: 'gmail', activeInstanceId: instance.id }; saveConnectorsConfig(config, home);
    db.prepare("INSERT INTO emails(id,from_addr,to_addr,subject,body,folder,is_read,created_at) VALUES('prior_fixture','prior@example.test','[]','Prior fixture','Preserve fixture content','inbox',1,'2020-01-01')").run();
    const before = db.prepare('SELECT * FROM emails ORDER BY id').all();
    await operation({ home, db, instance, before, options: { dataDir: home, instance } });
  } finally {
    closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const [name, acknowledgement] of [
  ['null', null], ['array', []], ['primitive', 'not a receipt'], ['missing ID', {}], ['empty ID', { id: '' }], ['blank ID', { id: ' ' }],
  ['numeric ID', { id: 42 }], ['object ID', { id: { private: PRIVATE } }],
  ['null thread', { id: 'real_receipt', threadId: null }], ['blank thread', { id: 'real_receipt', threadId: ' ' }],
  ['object thread', { id: 'real_receipt', threadId: { private: PRIVATE } }],
]) {
  test(`Gmail ${name} acknowledgement cannot invent sent evidence and requires uncertain owner review`, () => fixture(async (f) => {
    let calls = 0;
    await assert.rejects(sendEmail(message, { ...f.options, fetchImpl: async (url, init) => {
      calls++; assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.equal(init.method, 'POST');
      return { ok: true, status: 200, json: async () => acknowledgement };
    } }), uncertain);
    assert.equal(calls, 1); assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
  }));
}

for (const stage of ['transport', 'parser']) {
  test(`Gmail ${stage} failure cannot leak upstream private text or forge retry/permission metadata`, () => fixture(async (f) => {
    let calls = 0;
    await assert.rejects(sendEmail(message, { ...f.options, fetchImpl: async () => {
      calls++; const error = Object.assign(new Error(PRIVATE), { code: 'ETIMEDOUT', safeToRetry: true, actionErrorClass: 'retryable', status: 429 });
      if (stage === 'transport') throw error;
      return { ok: true, status: 200, json() { throw error; } };
    } }), (error) => { uncertain(error); assert.equal(error.status, stage === 'transport' ? undefined : 200); return true; });
    assert.equal(calls, 1); assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
  }));
}

for (const status of [401, 403, 429, 503]) {
  test(`Gmail HTTP ${status} after handoff is not proof of no delivery, consumes no private error body and never retries`, () => fixture(async (f) => {
    let calls = 0, cancelled = 0;
    await assert.rejects(sendEmail(message, { ...f.options, fetchImpl: async () => {
      calls++; return { ok: false, status, body: { cancel() { cancelled++; } }, json() { throw new Error(PRIVATE); } };
    } }), (error) => { uncertain(error); assert.equal(error.status, status); return true; });
    assert.equal(calls, 1); assert.equal(cancelled, 1); assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
  }));
}

test('validated Gmail acknowledgement preserves exact selected receipt/payload and optional absent thread without inventing identity', () => fixture(async (f) => {
  let calls = 0;
  const sent = await sendEmail(message, { ...f.options, fetchImpl: async (_url, init) => {
    calls++; assert.equal(init.headers.Authorization, 'Bearer fixture-valid');
    assert.equal(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString(), `To: ${message.to}\r\nSubject: ${message.subject}\r\n\r\n${message.body}`);
    return { ok: true, json: async () => ({ id: 'provider_receipt' }) };
  } });
  assert.equal(calls, 1); assert.equal(sent.id, `gmail_${f.instance.id}_provider_receipt`); assert.equal(sent.thread_id, null);
  assert.equal(sent.subject, message.subject); assert.equal(sent.body, message.body); assert.deepEqual(sent.to_addr, [message.to]);
  assert.deepEqual(f.db.prepare("SELECT * FROM emails WHERE id='prior_fixture'").get(), f.before[0]);
}));

test('local cache failure after a validated receipt retains uncertainty rather than authorizing another send', () => fixture(async (f) => {
  f.db.exec("CREATE TRIGGER fixture_refuse_sent BEFORE INSERT ON emails WHEN NEW.folder='sent' BEGIN SELECT RAISE(ABORT,'fixture-private-send-provider-token-body'); END");
  let calls = 0;
  await assert.rejects(sendEmail(message, { ...f.options, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ id: 'provider_receipt' }) }; } }), uncertain);
  assert.equal(calls, 1); assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
}));

for (const failure of ['missing receipt', 'forged transport retry']) {
  test(`approved Gmail ${failure} persists explicit uncertainty, blocks dependents/requeue and survives restart without resend`, () => fixture(async (f) => {
    const nativeFetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++; assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.equal(init.method, 'POST');
      if (failure === 'forged transport retry') throw Object.assign(new Error(PRIVATE), { code: 'ETIMEDOUT', safeToRetry: true, actionErrorClass: 'retryable' });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const agent = () => {
      const registry = createToolRegistry();
      const instance = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => ({ reasoning_summary: 'Fixture authorized send, then prepare follow-up', actions: [
        { tool: 'email.send', arguments: message }, { tool: 'email.draft', arguments: message, dependsOn: [0] },
      ] }) }, toolRegistry: registry, policyEngine: new PolicyEngine({ policies: { email: { send: 'confirm' } } }), eventBus: new EventBus(getDb()) });
      instance.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return instance;
    };
    try {
      const first = agent(), run = await first.handleMessage({ text: 'Fixture send with approval', actorId: 'owner' });
      const actionId = run.actions[0].id; assert.equal(run.actions[0].status, 'pending');
      const outcome = await first.approveAction(actionId, 'owner');
      assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'outcome_uncertain'); assert.match(outcome.error, /outcome uncertain/);
      const queue = getQueuedActionByActionId(actionId); assert.equal(queue.status, 'failed'); assert.equal(queue.error_class, 'outcome_uncertain');
      assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']);
      assert.equal(getRun(run.runId).status, 'needs_attention'); assert.equal(getRun(run.runId).objectiveStatus, 'unverified');
      assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type IN ('email.sent','agent.action.completed')").get().n, 0);
      assert.doesNotMatch(JSON.stringify(getAgentAction(actionId).result), /fixture-private/);
      const errors = f.db.prepare("SELECT data FROM events WHERE type='agent.action.failed'").all(); assert.doesNotMatch(JSON.stringify(errors), /fixture-private/);
      assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
      assert.throws(() => requeueAction(queue.id), /outcome is uncertain.*cannot be requeued/);
      await assert.rejects(first.approveAction(actionId, 'owner'), /not pending/);
      closeAllForTests(); getDb(); reconcileInterruptedRuns(); const restarted = agent();
      assert.equal(await restarted.actionQueueWorker.processNext(), null); await restarted.resumeRunDependents(run.runId);
      assert.throws(() => requeueAction(queue.id), /cannot be requeued/);
      assert.equal(listActionAttempts(queue.id).length, 1); assert.equal(calls, 1);
      assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']);
      assert.equal(getDb().prepare("SELECT count(*) n FROM emails WHERE folder IN ('sent','drafts')").get().n, 0);
    } finally { globalThis.fetch = nativeFetch; }
  }));
}
