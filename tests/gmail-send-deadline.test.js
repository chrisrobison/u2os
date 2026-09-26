import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { sendEmail } from '../server/integrations/gmail-provider.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { Agent } from '../server/agent/agent.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { EventBus } from '../server/events/event-bus.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { getQueuedActionByActionId, listActionAttempts, requeueAction } from '../server/agent/action-queue-store.js';

const message = { to: 'recipient@example.test', subject: 'Approved fixture subject', body: 'Approved fixture body' };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const ready = (pending, reached) => Promise.race([reached.promise, pending.then(() => { throw new Error('Send completed before fixture stage'); })]);
const uncertain = (error) => {
  assert.equal(error.code, 'GMAIL_SEND_OUTCOME_UNCERTAIN'); assert.equal(error.actionErrorClass, 'outcome_uncertain');
  assert.equal(error.safeToRetry, false); assert.match(error.message, /outcome uncertain.*acknowledgement timed out.*Sent mail.*no automatic retry/);
  assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/); return true;
};
function clock() {
  let callback, cleared = 0, scheduled = 0; const handle = { fixtureDeadline: true };
  return { handle, setTimeout(fn, delay) { assert.equal(delay, 30_000); scheduled++; callback = fn; return handle; },
    clearTimeout(id) { assert.equal(id, handle); cleared++; }, fire() { assert.ok(callback); callback(); },
    get cleared() { return cleared; }, get scheduled() { return scheduled; } };
}
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-gmail-send-deadline-')), previousHome = process.env.U2OS_HOME;
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

for (const stage of ['headers', 'body']) {
  test(`Gmail send bounds ${stage} stall and discards a non-cooperating late receipt without cache writes`, () => fixture(async (f) => {
    const timers = clock(), reached = deferred(), late = deferred(); let calls = 0, parsed = 0, cancelled = 0, signal;
    const response = { ok: true, status: 200, body: { cancel() { cancelled++; } }, json() {
      parsed++; reached.resolve(); return stage === 'body' ? late.promise : { id: 'late_receipt', threadId: 'late_thread' };
    } };
    const pending = sendEmail(message, { ...f.options, timers, fetchImpl: async (url, init) => {
      calls++; assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.equal(init.method, 'POST');
      signal = init.signal; if (stage === 'headers') { reached.resolve(); return late.promise; } return response;
    } });
    const rejected = assert.rejects(pending, uncertain); await ready(pending, reached); timers.fire(); await rejected;
    late.resolve(stage === 'headers' ? response : { id: 'late_receipt', threadId: 'late_thread' }); await new Promise(setImmediate);
    assert.equal(calls, 1); assert.equal(parsed, stage === 'headers' ? 0 : 1); assert.equal(signal.aborted, true);
    assert.ok(cancelled >= 1); assert.equal(timers.scheduled, 1); assert.equal(timers.cleared, 1);
    assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
  }));
}

for (const stage of ['headers', 'body']) {
  test(`Gmail send aborts an actual isolated native HTTP ${stage} stall without retry`, () => fixture(async (f) => {
    const timers = clock(), reached = deferred(); let calls = 0;
    const server = http.createServer((request, response) => {
      calls++; assert.equal(request.method, 'POST');
      request.resume(); request.on('end', () => {
        if (stage === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"id":'); }
        if (stage === 'headers') reached.resolve();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const nativeFetch = globalThis.fetch;
    try {
      const pending = sendEmail(message, { ...f.options, timers, fetchImpl: async (url, init) => {
        assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
        const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/fixture-send`, init);
        return { ok: response.ok, status: response.status, body: response.body,
          json() { reached.resolve(); return response.json(); } };
      } });
      const rejected = assert.rejects(pending, uncertain); await ready(pending, reached);
      // The body fixture reaches native JSON parsing before firing; the
      // headers fixture reaches the server without receiving headers.
      timers.fire(); await rejected; assert.equal(calls, 1); assert.equal(timers.cleared, 1);
      assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }));
}

for (const timeoutMs of [0, -1, 30_001, Infinity, NaN, '10']) {
  test(`Gmail invalid send deadline ${String(timeoutMs)} fails as not attempted before expired-token refresh`, () => fixture(async (f) => {
    storeTokens(f.instance.vault_key, 'gmail', { access_token: 'fixture-expired', refresh_token: 'fixture-refresh', expires_in: -1 }, f.home);
    const credentialFile = path.join(f.home, 'credentials', `${f.instance.vault_key}.enc.json`), before = fs.readFileSync(credentialFile); let calls = 0;
    await assert.rejects(sendEmail(message, { ...f.options, timeoutMs, fetchImpl() { calls++; throw new Error('Fixture prohibits any transport'); } }), /invalid send deadline; no message was attempted/);
    assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(credentialFile), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
  }));
}

test('bounded successful Gmail acknowledgement clears its only timer and retains exact approved account/payload', () => fixture(async (f) => {
  const timers = clock(); let calls = 0, signal;
  const result = await sendEmail(message, { ...f.options, timers, fetchImpl: async (_url, init) => {
    calls++; signal = init.signal; assert.equal(init.headers.Authorization, 'Bearer fixture-valid');
    assert.equal(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString(), `To: ${message.to}\r\nSubject: ${message.subject}\r\n\r\n${message.body}`);
    return { ok: true, status: 200, json: async () => ({ id: 'real_receipt', threadId: 'real_thread' }) };
  } });
  assert.equal(calls, 1); assert.equal(timers.scheduled, 1); assert.equal(timers.cleared, 1); assert.equal(signal.aborted, true);
  assert.equal(result.id, `gmail_${f.instance.id}_real_receipt`); assert.equal(result.thread_id, 'real_thread');
  assert.equal(result.subject, message.subject); assert.equal(result.body, message.body); assert.deepEqual(result.to_addr, [message.to]);
  assert.deepEqual(f.db.prepare("SELECT * FROM emails WHERE id='prior_fixture'").get(), f.before[0]);
}));

test('Gmail permits a shorter internal deadline without changing the provider request or retrying', () => fixture(async (f) => {
  const reached = deferred(); let callback, calls = 0, cleared = 0;
  const pending = sendEmail(message, { ...f.options, timeoutMs: 25,
    timers: { setTimeout(fn, delay) { assert.equal(delay, 25); callback = fn; return 9; }, clearTimeout(id) { assert.equal(id, 9); cleared++; } },
    fetchImpl: async () => { calls++; reached.resolve(); return new Promise(() => {}); },
  });
  const rejected = assert.rejects(pending, uncertain); await ready(pending, reached); callback(); await rejected;
  assert.equal(calls, 1); assert.equal(cleared, 1); assert.deepEqual(f.db.prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
}));

for (const stage of ['headers', 'body']) {
  test(`approved Gmail ${stage} timeout keeps uncertainty/dependents across restart and never resends a late receipt`, () => fixture(async (f) => {
    const nativeFetch = globalThis.fetch, nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
    const timers = clock(), reached = deferred(), late = deferred(); let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++; assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.equal(init.method, 'POST');
      if (stage === 'headers') { reached.resolve(); return late.promise; }
      return { ok: true, status: 200, json() { reached.resolve(); return late.promise; } };
    };
    const agent = () => {
      const registry = createToolRegistry(), result = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => ({ reasoning_summary: 'Fixture approved send and dependent draft', actions: [
        { tool: 'email.send', arguments: message }, { tool: 'email.draft', arguments: message, dependsOn: [0] },
      ] }) }, toolRegistry: registry, policyEngine: new PolicyEngine({ policies: { email: { send: 'confirm' } } }), eventBus: new EventBus(getDb()) });
      result.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return result;
    };
    try {
      const first = agent(), run = await first.handleMessage({ text: 'Fixture approval timeout', actorId: 'owner' }), actionId = run.actions[0].id;
      // Only the provider's 30-second acknowledgement timer is controlled;
      // queue lease heartbeats and other runtime timers stay real.
      globalThis.setTimeout = (fn, delay, ...args) => delay === 30_000 ? timers.setTimeout(fn, delay) : nativeSetTimeout(fn, delay, ...args);
      globalThis.clearTimeout = (handle) => handle === timers.handle ? timers.clearTimeout(handle) : nativeClearTimeout(handle);
      const pending = first.approveAction(actionId, 'owner'); await ready(pending, reached); timers.fire();
      const outcome = await pending; assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'outcome_uncertain');
      late.resolve(stage === 'headers' ? { ok: true, json: async () => ({ id: 'late_receipt' }) } : { id: 'late_receipt' }); await new Promise(setImmediate);
      const queue = getQueuedActionByActionId(actionId); assert.equal(queue.error_class, 'outcome_uncertain');
      assert.equal(getRun(run.runId).status, 'needs_attention'); assert.equal(getRun(run.runId).objectiveStatus, 'unverified');
      assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']);
      assert.throws(() => requeueAction(queue.id), /cannot be requeued/);
      assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type IN ('email.sent','agent.action.completed')").get().n, 0);
      globalThis.setTimeout = nativeSetTimeout; globalThis.clearTimeout = nativeClearTimeout;
      closeAllForTests(); getDb(); reconcileInterruptedRuns(); const restarted = agent();
      assert.equal(await restarted.actionQueueWorker.processNext(), null); await restarted.resumeRunDependents(run.runId);
      assert.equal(listActionAttempts(queue.id).length, 1); assert.equal(calls, 1); assert.equal(timers.scheduled, 1); assert.equal(timers.cleared, 1);
      assert.deepEqual(getDb().prepare('SELECT * FROM emails ORDER BY id').all(), f.before);
      assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']);
    } finally { globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeSetTimeout; globalThis.clearTimeout = nativeClearTimeout; }
  }));
}
