import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { listEvents, createEvent, rescheduleEvent } from '../server/integrations/google-calendar-provider.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { Agent } from '../server/agent/agent.js';
import { PolicyEngine, getAgentAction } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { EventBus } from '../server/events/event-bus.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { getQueuedActionByActionId, listActionAttempts, requeueAction } from '../server/agent/action-queue-store.js';
import { classifyActionError } from '../server/agent/action-error-classifier.js';

const PRIVATE = 'fixture-private-calendar-write-body-token';
const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const original = { id: 'source_event', summary: 'Prior fixture appointment', start: { dateTime: '2026-09-26T10:00:00Z' }, end: { dateTime: '2026-09-26T11:00:00Z' } };
const proposed = { title: 'Approved fixture appointment', startAt: '2026-09-26T12:00:00Z', endAt: '2026-09-26T13:00:00Z', attendees: ['person@example.test'], location: 'Fixture room' };
const receipt = (operation) => ({ ...original, id: operation === 'create' ? 'new_event' : original.id, summary: proposed.title,
  start: { dateTime: proposed.startAt }, end: { dateTime: proposed.endAt } });
const uncertain = (error) => {
  assert.equal(error.code, 'GOOGLE_CALENDAR_WRITE_OUTCOME_UNCERTAIN'); assert.equal(error.actionErrorClass, 'outcome_uncertain');
  assert.equal(error.safeToRetry, false); assert.equal(error.ownerAttentionRequired, true); assert.equal(classifyActionError(error), 'outcome_uncertain');
  assert.match(error.message, /outcome uncertain.*originally bound calendar.*no automatic retry/); assert.doesNotMatch(error.message, /fixture-private|Bearer|googleapis/); return true;
};
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-calendar-write-ack-')), previous = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb();
    const add = (label, legacy = false) => {
      const created = createConnectionInstance(db, { connectorId: 'google', label, status: 'connected', dataDir: home });
      if (legacy) db.prepare('UPDATE connection_instances SET metadata=? WHERE id=?').run(JSON.stringify({ migratedFrom: 'legacy-single-file' }), created.id);
      const instance = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(created.id);
      storeTokens(instance.vault_key, 'calendar', { access_token: `fixture-${instance.id}`, refresh_token: 'fixture-refresh', expires_in: 3600 }, home); return instance;
    };
    const instance = add('Original fixture account'), options = { dataDir: home, instance };
    const activate = (account) => { const config = loadConnectorsConfig(home); config.calendar = { ...config.calendar, active: 'google-calendar', activeInstanceId: account.id }; saveConnectorsConfig(config, home); };
    const seed = (account) => listEvents({}, { dataDir: home, instance: account, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [original] }) }) });
    activate(instance); await seed(instance);
    const localId = `gcal_${instance.id}_source_event`, rows = () => getDb().prepare('SELECT * FROM calendar_events ORDER BY id').all(), before = rows();
    const run = (name, fetchImpl) => name === 'create' ? createEvent(proposed, { ...options, fetchImpl }) : rescheduleEvent(localId, { newStartAt: proposed.startAt, newEndAt: proposed.endAt }, { ...options, fetchImpl });
    const checkRequest = (name, url, init, account = instance) => {
      assert.equal(url, name === 'create' ? base : `${base}/source_event`); assert.equal(init.method, name === 'create' ? 'POST' : 'PATCH');
      assert.equal(init.headers.Authorization, `Bearer fixture-${account.id}`);
      assert.deepEqual(JSON.parse(init.body), name === 'create' ? { summary: proposed.title, start: { dateTime: proposed.startAt }, end: { dateTime: proposed.endAt }, location: proposed.location, attendees: [{ email: proposed.attendees[0] }] }
        : { start: { dateTime: proposed.startAt }, end: { dateTime: proposed.endAt } });
    };
    await operation({ db, home, instance, options, add, activate, seed, localId, rows, before, run, checkRequest });
  } finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); }
}
for (const operation of ['create', 'reschedule']) {
  const valid = receipt(operation);
  for (const [shape, invalid] of [
    ['null', null], ['array', []], ['primitive', PRIVATE], ['missing ID', { ...valid, id: undefined }], ['empty ID', { ...valid, id: '' }], ['blank ID', { ...valid, id: ' ' }],
    ['numeric ID', { ...valid, id: 42 }], ['object ID', { ...valid, id: { private: PRIVATE } }], ['missing end', { ...valid, end: {} }], ['unusable start', { ...valid, start: { dateTime: PRIVATE } }],
    ['unknown status', { ...valid, status: PRIVATE }], ['cancelled', { ...valid, status: 'cancelled' }], ['tentative', { ...valid, status: 'tentative' }],
    ['ignored change', { ...valid, start: original.start, end: original.end }],
    ['offset-less times', { ...valid, start: { dateTime: '2026-09-26T12:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-26T13:00:00', timeZone: 'UTC' } }],
    ['object attendee email', { ...valid, attendees: [{ email: { private: PRIVATE } }] }],
  ]) test(`Calendar ${operation} rejects ${shape} acknowledgement without inventing cache evidence`, () => fixture(async (f) => {
    let calls = 0, validatedRequests = 0;
    await assert.rejects(f.run(operation, async (url, init) => { calls++; f.checkRequest(operation, url, init); validatedRequests++; return { ok: true, status: 200, json: async () => invalid }; }), uncertain);
    assert.equal(calls, 1); assert.equal(validatedRequests, 1); assert.deepEqual(f.rows(), f.before);
  }));
  for (const status of [401, 403, 429, 503]) test(`Calendar ${operation} HTTP ${status} consumes no private body and never retries`, () => fixture(async (f) => {
    let calls = 0, cancelled = 0;
    await assert.rejects(f.run(operation, async () => { calls++; return { ok: false, status, body: { cancel() { cancelled++; } }, json() { throw new Error(PRIVATE); } }; }), (error) => { uncertain(error); assert.equal(error.status, status); return true; });
    assert.equal(calls, 1); assert.equal(cancelled, 1); assert.deepEqual(f.rows(), f.before);
  }));
  for (const stage of ['transport', 'parser']) test(`Calendar ${operation} ${stage} cannot leak text or forge retry metadata`, () => fixture(async (f) => {
    let calls = 0;
    await assert.rejects(f.run(operation, async () => {
      calls++; const error = Object.assign(new Error(PRIVATE), { code: 'ETIMEDOUT', safeToRetry: true, actionErrorClass: 'retryable', status: 429 });
      if (stage === 'transport') throw error; return { ok: true, status: 200, json() { throw error; } };
    }), (error) => { uncertain(error); assert.equal(error.status, stage === 'transport' ? undefined : 200); return true; });
    assert.equal(calls, 1); assert.deepEqual(f.rows(), f.before);
  }));
  test(`Calendar ${operation} cache failure after receipt does not authorize another external effect`, () => fixture(async (f) => {
    f.db.exec(`CREATE TRIGGER fixture_refuse_write BEFORE ${operation === 'create' ? 'INSERT' : 'UPDATE'} ON calendar_events BEGIN SELECT RAISE(ABORT,'${PRIVATE}'); END`);
    let calls = 0; await assert.rejects(f.run(operation, async () => { calls++; return { ok: true, json: async () => valid }; }), uncertain);
    assert.equal(calls, 1); assert.deepEqual(f.rows(), f.before);
  }));
  for (const failure of ['missing receipt', 'forged retry']) test(`approved Calendar ${operation} ${failure} retains original account, blocks dependents and cannot replay after restart`, () => fixture(async (f) => {
    const nativeFetch = globalThis.fetch; let calls = 0, modelCalls = 0, validatedRequests = 0;
    globalThis.fetch = async (url, init) => { calls++; f.checkRequest(operation, url, init); validatedRequests++;
      if (failure === 'forged retry') throw Object.assign(new Error(PRIVATE), { code: 'ETIMEDOUT', safeToRetry: true });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const agent = () => {
      const registry = createToolRegistry(), instance = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => { modelCalls++; return { reasoning_summary: 'Fixture calendar change then dependent task', continue: true, actions: [
        { tool: `calendar.${operation}`, arguments: operation === 'create' ? proposed : { eventId: f.localId, newStartAt: proposed.startAt, newEndAt: proposed.endAt } },
        { tool: 'tasks.create', arguments: { title: 'Dependent fixture task' }, dependsOn: [0] },
      ] }; } }, toolRegistry: registry, policyEngine: new PolicyEngine({ policies: { calendar: { create: 'confirm', reschedule: { personal: 'confirm' } }, tasks: { create: 'autonomous' } } }), eventBus: new EventBus(getDb()) });
      instance.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return instance;
    };
    try {
      const first = agent(), run = await first.handleMessage({ text: 'Fixture approved calendar change', actorId: 'owner' }), actionId = run.actions[0].id;
      assert.equal(run.actions[0].status, 'pending'); f.activate(f.add('Other fixture account'));
      const outcome = await first.approveAction(actionId, 'owner'); assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'outcome_uncertain');
      const queue = getQueuedActionByActionId(actionId); assert.equal(queue.error_class, 'outcome_uncertain');
      assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']); assert.equal(getRun(run.runId).status, 'needs_attention');
      assert.equal(getRun(run.runId).objectiveStatus, 'unverified'); assert.deepEqual(f.rows(), f.before);
      assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type IN ('calendar.event_added','calendar.event_changed','agent.action.completed')").get().n, 0);
      assert.doesNotMatch(JSON.stringify(getAgentAction(actionId).result), /fixture-private/);
      assert.throws(() => requeueAction(queue.id), /cannot be requeued/); await assert.rejects(first.approveAction(actionId, 'owner'), /not pending/);
      closeAllForTests(); getDb(); reconcileInterruptedRuns(); const restarted = agent();
      assert.equal(await restarted.actionQueueWorker.processNext(), null); await restarted.resumeRunDependents(run.runId); await restarted.resumeRunPlanning(run.runId);
      assert.equal(listActionAttempts(queue.id).length, 1); assert.equal(calls, 1); assert.equal(validatedRequests, 1); assert.equal(modelCalls, 1); assert.deepEqual(f.rows(), f.before);
      assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['outcome_uncertain', 'waiting_dependency']);
      assert.equal(getDb().prepare('SELECT count(*) n FROM tasks').get().n, 0);
    } finally { globalThis.fetch = nativeFetch; }
  }));
}
test('Calendar valid acknowledgements preserve exact requests, equivalent source offsets and independent/legacy account identities', () => fixture(async (f) => {
  for (const [index, instance] of [f.instance, f.add('Second fixture account'), f.add('Legacy fixture account', true)].entries()) {
    await f.seed(instance); const prefix = index === 2 ? 'gcal_' : `gcal_${instance.id}_`, options = { dataDir: f.home, instance };
    for (const operation of ['create', 'reschedule']) {
      const fetchImpl = async (url, init) => { f.checkRequest(operation, url, init, instance); return { ok: true, json: async () => ({ ...receipt(operation), start: { dateTime: '2026-09-26T14:00:00+02:00' }, end: { dateTime: '2026-09-26T15:00:00+02:00' } }) }; };
      const result = operation === 'create' ? await createEvent(proposed, { ...options, fetchImpl }) : await rescheduleEvent(`${prefix}source_event`, { newStartAt: proposed.startAt, newEndAt: proposed.endAt }, { ...options, fetchImpl });
      const after = operation === 'create' ? result : result.after; assert.equal(after.id, `${prefix}${receipt(operation).id}`); assert.equal(after.start_at, '2026-09-26T14:00:00+02:00');
      if (operation === 'reschedule') assert.equal(result.before.start_at, original.start.dateTime);
    }
  }
  assert.equal(f.rows().length, 6);
}));
test('Calendar reschedule cannot substitute a different event identity', () => fixture(async (f) => {
  await assert.rejects(f.run('reschedule', async () => ({ ok: true, json: async () => ({ ...receipt('reschedule'), id: 'other_event' }) })), uncertain); assert.deepEqual(f.rows(), f.before);
}));
test('Calendar missing local reschedule source is not attempted', () => fixture(async (f) => {
  assert.equal(await rescheduleEvent('missing_fixture_event', { newStartAt: proposed.startAt, newEndAt: proposed.endAt }, { ...f.options, fetchImpl() { throw new Error('Must not attempt authentication or write'); } }), null); assert.deepEqual(f.rows(), f.before);
}));
