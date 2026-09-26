import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { sendEmail } from '../server/integrations/gmail-provider.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { Agent } from '../server/agent/agent.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { EventBus } from '../server/events/event-bus.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { getAgentAction } from '../server/policy/policy-engine.js';

const PRIVATE = 'fixture-private-recipient';
const message = { to: 'recipient@example.test', subject: 'Fixture subject', body: 'Fixture body\r\nWith a second line' };
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-gmail-preflight-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), created = createConnectionInstance(db, { connectorId: 'google', label: 'Selected fixture account', status: 'connected', dataDir: home });
    const instance = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(created.id);
    writeEncryptedFile('google', { clientId: 'fixture-client', clientSecret: 'fixture-secret' }, home);
    storeTokens(instance.vault_key, 'gmail', { access_token: 'fixture-expired', refresh_token: 'fixture-refresh', expires_in: -1 }, home);
    const config = loadConnectorsConfig(home); config.email = { ...config.email, active: 'gmail', activeInstanceId: instance.id }; saveConnectorsConfig(config, home);
    await operation({ home, db, instance, credentialFile: path.join(home, 'credentials', `${instance.vault_key}.enc.json`) });
  } finally {
    closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const [name, to] of [
  ['nested injected array', [[`${PRIVATE}@example.test\r\nBcc: other@example.test`]]],
  ['nested clean array', [['recipient@example.test']]], ['object', { email: `${PRIVATE}@example.test` }],
  ['array object', [{ email: `${PRIVATE}@example.test` }]], ['null', null], ['number', 123], ['empty array', []],
  ['sparse array', new Array(1)],
  ['empty string', ''], ['blank string', '  '], ['blank element', ['recipient@example.test', ' ']],
  ['injected string', `${PRIVATE}@example.test\nBcc: other@example.test`],
  ['injected array element', ['recipient@example.test', `${PRIVATE}@example.test\rBcc: other@example.test`]],
]) {
  test(`Gmail ${name} fails before OAuth or transport without changing credentials/cache`, () => fixture(async (f) => {
    const before = fs.readFileSync(f.credentialFile); let calls = 0;
    await assert.rejects(sendEmail({ ...message, to }, { dataDir: f.home, instance: f.instance, fetchImpl() { calls++; throw new Error('Transport must not be reached'); } }), (error) => {
      assert.match(error.message, /no message was attempted/); assert.doesNotMatch(error.message, new RegExp(PRIVATE)); return true;
    });
    assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.credentialFile), before); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
  }));
}

for (const [name, changes] of [['injected subject', { subject: `${PRIVATE}\r\nBcc: other@example.test` }], ['object subject', { subject: {} }], ['object body', { body: {} }]]) {
  test(`Gmail ${name} fails before OAuth or transport and omits submitted values`, () => fixture(async (f) => {
    let calls = 0;
    await assert.rejects(sendEmail({ ...message, ...changes }, { dataDir: f.home, instance: f.instance, fetchImpl() { calls++; } }), (error) => {
      assert.match(error.message, /no message was attempted/); assert.doesNotMatch(error.message, new RegExp(PRIVATE)); return true;
    });
    assert.equal(calls, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
  }));
}

test('Gmail valid string and flat recipients preserve exact MIME and selected-account acknowledgement IDs', () => fixture(async (f) => {
  storeTokens(f.instance.vault_key, 'gmail', { access_token: 'fixture-valid', refresh_token: 'fixture-refresh', expires_in: 3600 }, f.home);
  for (const to of ['Recipient <recipient@example.test>', ['recipient@example.test', 'Second <second@example.test>']]) {
    let calls = 0;
    const sent = await sendEmail({ ...message, to }, { dataDir: f.home, instance: f.instance, fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fixture-valid');
      const raw = Buffer.from(JSON.parse(options.body).raw, 'base64url').toString('utf8');
      assert.equal(raw, `To: ${Array.isArray(to) ? to.join(', ') : to}\r\nSubject: Fixture subject\r\n\r\n${message.body}`);
      return { ok: true, json: async () => ({ id: `fixture_sent_${calls}`, threadId: 'fixture_thread' }) };
    } });
    assert.equal(calls, 1); assert.equal(sent.id, `gmail_${f.instance.id}_fixture_sent_1`); assert.deepEqual(sent.to_addr, Array.isArray(to) ? to : [to]);
  }
}));

test('approved malformed Gmail recipient fails without provider work, blocks dependents and cannot retry after restart', () => fixture(async (f) => {
  const nativeFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Fixture prohibits all provider work'); };
  const agent = () => {
    const registry = createToolRegistry();
    const instance = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => ({ reasoning_summary: 'Fixture approved malformed reply', actions: [
      { tool: 'email.send', arguments: { ...message, to: [[`${PRIVATE}@example.test\r\nBcc: other@example.test`]] } },
      { tool: 'email.draft', arguments: message, dependsOn: [0] },
    ] }) }, toolRegistry: registry, policyEngine: new PolicyEngine({ policies: { email: { send: 'confirm' } } }), eventBus: new EventBus(getDb()) });
    instance.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return instance;
  };
  try {
    const first = agent(), run = await first.handleMessage({ text: 'Fixture send proposal', actorId: 'owner' });
    assert.equal(run.actions[0].status, 'pending'); const actionId = run.actions[0].id;
    const outcome = await first.approveAction(actionId, 'owner');
    assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'non_retryable'); assert.match(outcome.error, /no message was attempted/);
    assert.doesNotMatch(JSON.stringify(getAgentAction(actionId).result), new RegExp(PRIVATE));
    assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['needs_attention', 'skipped']);
    assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type IN ('email.sent','agent.action.completed')").get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM emails').get().n, 0);
    closeAllForTests(); getDb(); reconcileInterruptedRuns(); const restarted = agent();
    assert.equal(await restarted.actionQueueWorker.processNext(), null);
    await restarted.resumeRunDependents(run.runId);
    assert.equal(getDb().prepare('SELECT count(*) n FROM action_attempts').get().n, 1); assert.equal(calls, 0);
    assert.equal(getAgentAction(actionId).status, 'failed'); assert.equal(getRun(run.runId).objectiveStatus, 'unverified');
  } finally { globalThis.fetch = nativeFetch; }
}));
