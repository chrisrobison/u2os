import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { listEvents, createEvent, rescheduleEvent } from '../server/integrations/google-calendar-provider.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { Agent } from '../server/agent/agent.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { EventBus } from '../server/events/event-bus.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { getQueuedActionByActionId, listActionAttempts, requeueAction } from '../server/agent/action-queue-store.js';

const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const proposed = { title: 'Approved fixture meeting', startAt: '2026-09-26T12:00:00Z', endAt: '2026-09-26T13:00:00Z', attendees: ['person@example.test'] };
const original = { id: 'source_event', summary: 'Prior fixture meeting', start: { dateTime: '2026-09-26T10:00:00Z' }, end: { dateTime: '2026-09-26T11:00:00Z' } };
const receipt = (operation) => ({ ...original, id: operation === 'create' ? 'new_event' : original.id, start: { dateTime: proposed.startAt }, end: { dateTime: proposed.endAt } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const ready = (pending, reached) => Promise.race([reached.promise, pending.then(() => { throw new Error('Write completed before fixture stage'); })]);
const uncertain = (error) => {
  assert.equal(error.code, 'GOOGLE_CALENDAR_WRITE_OUTCOME_UNCERTAIN'); assert.equal(error.actionErrorClass, 'outcome_uncertain'); assert.equal(error.safeToRetry, false);
  assert.match(error.message, /outcome uncertain.*acknowledgement timed out.*originally bound calendar.*no automatic retry/); assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/); return true;
};
function clock(delay = 30_000) {
  let callback, cleared = 0, scheduled = 0; const handle = { fixtureDeadline: true };
  return { handle, setTimeout(fn, ms) { assert.equal(ms, delay); scheduled++; callback = fn; return handle; }, clearTimeout(id) { assert.equal(id, handle); cleared++; },
    fire() { assert.ok(callback); callback(); }, get cleared() { return cleared; }, get scheduled() { return scheduled; } };
}
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-calendar-write-deadline-')), previous = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), created = createConnectionInstance(db, { connectorId: 'google', label: 'Selected fixture account', status: 'connected', dataDir: home });
    const instance = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(created.id), options = { dataDir: home, instance };
    storeTokens(instance.vault_key, 'calendar', { access_token: 'fixture-valid', refresh_token: 'fixture-refresh', expires_in: 3600 }, home);
    const config = loadConnectorsConfig(home); config.calendar = { ...config.calendar, active: 'google-calendar', activeInstanceId: instance.id }; saveConnectorsConfig(config, home);
    await listEvents({}, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [original] }) }) });
    const localId = `gcal_${instance.id}_source_event`, rows = () => getDb().prepare('SELECT * FROM calendar_events ORDER BY id').all(), before = rows();
    const run = (name, overrides) => name === 'create' ? createEvent(proposed, { ...options, ...overrides }) : rescheduleEvent(localId, { newStartAt: proposed.startAt, newEndAt: proposed.endAt }, { ...options, ...overrides });
    const check = (name, url, init) => {
      assert.equal(url, name === 'create' ? base : `${base}/source_event`); assert.equal(init.method, name === 'create' ? 'POST' : 'PATCH'); assert.equal(init.headers.Authorization, 'Bearer fixture-valid');
      assert.deepEqual(JSON.parse(init.body), name === 'create' ? { summary: proposed.title, start: { dateTime: proposed.startAt }, end: { dateTime: proposed.endAt }, attendees: [{ email: proposed.attendees[0] }] }
        : { start: { dateTime: proposed.startAt }, end: { dateTime: proposed.endAt } });
    };
    await operation({ db, home, instance, options, localId, rows, before, run, check });
  } finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); }
}
for (const operation of ['create', 'reschedule']) {
  for (const stage of ['headers', 'body']) {
    test(`Calendar ${operation} discards non-cooperating late ${stage} receipt after deadline`, () => fixture(async (f) => {
      const timers = clock(), reached = deferred(), late = deferred(); let calls = 0, validated = 0, parsed = 0, cancelled = 0, signal;
      const response = { ok: true, status: 200, body: { cancel() { cancelled++; } }, json() { parsed++; reached.resolve(); return stage === 'body' ? late.promise : receipt(operation); } };
      const pending = f.run(operation, { timers, fetchImpl: async (url, init) => { calls++; f.check(operation, url, init); validated++; signal = init.signal;
        if (stage === 'headers') { reached.resolve(); return late.promise; } return response;
      } });
      const rejected = assert.rejects(pending, uncertain); await ready(pending, reached); timers.fire(); await rejected;
      late.resolve(stage === 'headers' ? response : receipt(operation)); await new Promise(setImmediate);
      assert.equal(calls, 1); assert.equal(validated, 1); assert.equal(parsed, stage === 'headers' ? 0 : 1); assert.equal(signal.aborted, true);
      assert.ok(cancelled >= 1); assert.equal(timers.scheduled, 1); assert.equal(timers.cleared, 1); assert.deepEqual(f.rows(), f.before);
    }));
    test(`Calendar ${operation} aborts isolated native HTTP ${stage} stall without retry`, () => fixture(async (f) => {
      const timers = clock(), reached = deferred(); let calls = 0, validated = 0;
      const server = http.createServer((request, response) => {
        calls++; assert.equal(request.method, operation === 'create' ? 'POST' : 'PATCH'); request.resume(); request.on('end', () => {
          if (stage === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"id":'); }
          if (stage === 'headers') reached.resolve();
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const nativeFetch = globalThis.fetch;
      try {
        const pending = f.run(operation, { timers, fetchImpl: async (url, init) => {
          f.check(operation, url, init); validated++; const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/fixture-write`, init);
          return { ok: response.ok, status: response.status, body: response.body, json() { reached.resolve(); return response.json(); } };
        } });
        const rejected = assert.rejects(pending, uncertain); await ready(pending, reached); timers.fire(); await rejected;
        assert.equal(calls, 1); assert.equal(validated, 1); assert.equal(timers.cleared, 1); assert.deepEqual(f.rows(), f.before);
      } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    }));
    test(`approved Calendar ${operation} ${stage} timeout stops work across restart without late-receipt replay`, () => fixture(async (f) => {
      const nativeFetch = globalThis.fetch, nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
      const timers = clock(), reached = deferred(), late = deferred(); let calls = 0, validated = 0, modelCalls = 0;
      globalThis.setTimeout = (callback, delay, ...args) => delay === 30_000 ? timers.setTimeout(callback, delay) : nativeSetTimeout(callback, delay, ...args);
      globalThis.clearTimeout = (handle) => handle === timers.handle ? timers.clearTimeout(handle) : nativeClearTimeout(handle);
      globalThis.fetch = async (url, init) => { calls++; f.check(operation, url, init); validated++;
        if (stage === 'headers') { reached.resolve(); return late.promise; }
        return { ok: true, status: 200, json() { reached.resolve(); return late.promise; } };
      };
      const agent = () => {
        const registry = createToolRegistry(), instance = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => { modelCalls++; return { reasoning_summary: 'Fixture write and dependent task', continue: true, actions: [
          { tool: `calendar.${operation}`, arguments: operation === 'create' ? proposed : { eventId: f.localId, newStartAt: proposed.startAt, newEndAt: proposed.endAt } },
          { tool: 'tasks.create', arguments: { title: 'Dependent fixture task' }, dependsOn: [0] },
        ] }; } }, toolRegistry: registry, policyEngine: new PolicyEngine({ policies: { calendar: { create: 'confirm', reschedule: { personal: 'confirm' } }, tasks: { create: 'autonomous' } } }), eventBus: new EventBus(getDb()) });
        instance.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return instance;
      };
      try {
        const first = agent(), run = await first.handleMessage({ text: 'Fixture bounded approved change', actorId: 'owner' }), actionId = run.actions[0].id;
        assert.equal(run.actions[0].status, 'pending'); const pending = first.approveAction(actionId, 'owner'); await ready(pending, reached); timers.fire();
        const outcome = await pending; assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'outcome_uncertain'); assert.match(outcome.error, /acknowledgement timed out/);
        const queue = getQueuedActionByActionId(actionId); assert.equal(queue.error_class, 'outcome_uncertain'); assert.throws(() => requeueAction(queue.id), /cannot be requeued/);
        closeAllForTests(); getDb(); reconcileInterruptedRuns(); const restarted = agent();
        late.resolve(stage === 'headers' ? { ok: true, json: async () => receipt(operation) } : receipt(operation)); await new Promise(setImmediate);
        assert.equal(await restarted.actionQueueWorker.processNext(), null); await restarted.resumeRunDependents(run.runId); await restarted.resumeRunPlanning(run.runId);
        assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']); assert.equal(getRun(run.runId).status, 'needs_attention'); assert.equal(getRun(run.runId).objectiveStatus, 'unverified');
        assert.equal(listActionAttempts(queue.id).length, 1); assert.equal(calls, 1); assert.equal(validated, 1); assert.equal(modelCalls, 1); assert.deepEqual(f.rows(), f.before);
        assert.equal(getDb().prepare("SELECT count(*) n FROM events WHERE type IN ('calendar.event_added','calendar.event_changed','agent.action.completed')").get().n, 0);
        assert.equal(getDb().prepare('SELECT count(*) n FROM tasks').get().n, 0); await assert.rejects(restarted.approveAction(actionId, 'owner'), /not pending/);
      } finally { globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeSetTimeout; globalThis.clearTimeout = nativeClearTimeout; }
    }));
  }
  for (const timeoutMs of [0, -1, 30_001, Infinity, NaN, '10']) test(`Calendar ${operation} invalid deadline ${String(timeoutMs)} is not attempted before expired-token refresh`, () => fixture(async (f) => {
    storeTokens(f.instance.vault_key, 'calendar', { access_token: 'fixture-expired', refresh_token: 'fixture-refresh', expires_in: -1 }, f.home);
    const credentialFile = path.join(f.home, 'credentials', `${f.instance.vault_key}.enc.json`), before = fs.readFileSync(credentialFile); let calls = 0;
    await assert.rejects(f.run(operation, { timeoutMs, fetchImpl() { calls++; throw new Error('No fixture transport allowed'); } }), /invalid write deadline; no calendar change was attempted/);
    assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(credentialFile), before); assert.deepEqual(f.rows(), f.before);
  }));
  test(`Calendar ${operation} successful acknowledgement clears its only timer with exact approved bytes`, () => fixture(async (f) => {
    const timers = clock(); let calls = 0, signal;
    const result = await f.run(operation, { timers, fetchImpl: async (url, init) => { calls++; f.check(operation, url, init); signal = init.signal; return { ok: true, json: async () => receipt(operation) }; } });
    assert.equal(calls, 1); assert.equal(timers.scheduled, 1); assert.equal(timers.cleared, 1); assert.equal(signal.aborted, true);
    const after = operation === 'create' ? result : result.after; assert.equal(after.id, `gcal_${f.instance.id}_${receipt(operation).id}`); assert.equal(after.start_at, proposed.startAt);
    if (operation === 'reschedule') assert.equal(result.before.start_at, original.start.dateTime); else assert.deepEqual(f.rows().find((row) => row.id === f.localId), f.before[0]);
  }));
  test(`Calendar ${operation} supports a shorter internal deadline without altering request or retrying`, () => fixture(async (f) => {
    const timers = clock(25), reached = deferred(); let calls = 0, validated = 0;
    const pending = f.run(operation, { timeoutMs: 25, timers, fetchImpl: async (url, init) => { calls++; f.check(operation, url, init); validated++; reached.resolve(); return new Promise(() => {}); } });
    const rejected = assert.rejects(pending, uncertain); await ready(pending, reached); timers.fire(); await rejected;
    assert.equal(calls, 1); assert.equal(validated, 1); assert.equal(timers.cleared, 1); assert.deepEqual(f.rows(), f.before);
  }));
}
