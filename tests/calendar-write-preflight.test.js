import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';
import { listEvents, createEvent, rescheduleEvent } from '../server/integrations/google-calendar-provider.js';
import { loadConnectorsConfig, saveConnectorsConfig } from '../server/integrations/connectors-config.js';
import { Agent } from '../server/agent/agent.js';
import { PolicyEngine, getAgentAction } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { EventBus } from '../server/events/event-bus.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { getQueuedActionByActionId, listActionAttempts } from '../server/agent/action-queue-store.js';
import { classifyActionError } from '../server/agent/action-error-classifier.js';

const PRIVATE = 'fixture-private-calendar-request';
const proposal = { title: 'Fixture appointment', startAt: '2026-09-26T12:00:00Z', endAt: '2026-09-26T13:00:00Z', attendees: ['person@example.test'], location: 'Fixture room' };
const original = { id: 'source_event', summary: 'Prior fixture', start: { dateTime: '2026-09-26T10:00:00Z' }, end: { dateTime: '2026-09-26T11:00:00Z' } };
const invalid = (error) => {
  assert.equal(error.code, 'GOOGLE_CALENDAR_INVALID_REQUEST'); assert.equal(classifyActionError(error), 'non_retryable'); assert.equal(error.safeToRetry, false);
  assert.match(error.message, /explicit-offset.*resolved guest email.*no calendar change was attempted/); assert.doesNotMatch(error.message, /fixture-private/); return true;
};
async function fixture(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-calendar-preflight-')), previous = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try {
    const db = getDb(), created = createConnectionInstance(db, { connectorId: 'google', label: 'Fixture account', status: 'connected', dataDir: home });
    const instance = db.prepare('SELECT * FROM connection_instances WHERE id=?').get(created.id), options = { dataDir: home, instance }, token = (expired) =>
      storeTokens(instance.vault_key, 'calendar', { access_token: 'fixture-valid', refresh_token: 'fixture-refresh', expires_in: expired ? -1 : 3600 }, home);
    token(false); const config = loadConnectorsConfig(home); config.calendar = { ...config.calendar, active: 'google-calendar', activeInstanceId: instance.id }; saveConnectorsConfig(config, home);
    await listEvents({}, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [original] }) }) });
    const localId = `gcal_${instance.id}_source_event`, rows = () => getDb().prepare('SELECT * FROM calendar_events ORDER BY id').all(), before = rows();
    const credentials = () => fs.readFileSync(path.join(home, 'credentials', `${instance.vault_key}.enc.json`));
    const run = (name, args, fetchImpl) => name === 'create' ? createEvent(args, { ...options, fetchImpl }) : rescheduleEvent(localId, { newStartAt: args.startAt, newEndAt: args.endAt }, { ...options, fetchImpl });
    await operation({ db, instance, options, localId, rows, before, credentials, token, run });
  } finally { closeAllForTests(); if (previous === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); }
}
const timeCases = [
  ['missing start', { startAt: undefined }], ['null start', { startAt: null }], ['number start', { startAt: 42 }], ['object start', { startAt: { private: PRIVATE } }],
  ['blank start', { startAt: ' ' }], ['all-day date', { startAt: '2026-09-26' }], ['offset-less start', { startAt: '2026-09-26T12:00:00' }],
  ['nonexistent civil date', { startAt: '2026-02-30T12:00:00Z' }], ['bad month', { startAt: '2026-13-26T12:00:00Z' }], ['hour 24 rollover', { startAt: '2026-09-26T24:00:00Z' }],
  ['minute 60', { startAt: '2026-09-26T12:60:00Z' }], ['second 60', { startAt: '2026-09-26T12:00:60Z' }], ['offset hour 25', { startAt: '2026-09-26T12:00:00+25:00' }],
  ['offset minute 60', { startAt: '2026-09-26T12:00:00+01:60' }], ['compact offset', { startAt: '2026-09-26T12:00:00+0000' }], ['missing seconds', { startAt: '2026-09-26T12:00Z' }],
  ['natural language date', { startAt: 'September 26, 2026' }], ['missing end', { endAt: undefined }], ['private malformed end', { endAt: PRIVATE }],
  ['unsupported sub-millisecond precision', { startAt: '2026-09-26T12:00:00.0001Z' }],
  ['offset-less end', { endAt: '2026-09-26T13:00:00' }], ['zero duration', { endAt: proposal.startAt }], ['backwards range', { endAt: '2026-09-26T11:00:00Z' }],
  ['backwards explicit-offset range', { endAt: '2026-09-26T13:00:00+02:00' }],
];
const sparse = []; sparse.length = 1;
const createCases = [
  ['missing title', { title: undefined }], ['null title', { title: null }], ['object title', { title: { private: PRIVATE } }], ['blank title', { title: ' ' }],
  ['object location', { location: { private: PRIVATE } }], ['number location', { location: 42 }], ['null guests', { attendees: null }], ['object guests', { attendees: {} }],
  ['string guests', { attendees: 'person@example.test' }], ['sparse guests', { attendees: sparse }], ['nested guests', { attendees: [['person@example.test']] }],
  ['object guest', { attendees: [{ email: 'person@example.test' }] }], ['blank guest', { attendees: [' '] }], ['unresolved name', { attendees: ['Fixture Person'] }],
  ['display-name syntax', { attendees: ['Fixture Person <person@example.test>'] }], ['multiple addresses in one entry', { attendees: ['one@example.test,two@example.test'] }],
  ['header-injected guest', { attendees: [`${PRIVATE}@example.test\r\nBcc: other@example.test`] }], ['missing address domain', { attendees: ['person@'] }], ['control guest', { attendees: ['person\u0000@example.test'] }],
];
for (const name of ['create', 'reschedule']) {
  test(`Calendar ${name} cannot verify a different sub-millisecond receipt by rounding`, () => fixture(async (f) => {
    let calls = 0;
    await assert.rejects(f.run(name, proposal, async () => { calls++; return { ok: true, json: async () => ({ ...original, id: name === 'create' ? 'new_event' : original.id,
      start: { dateTime: '2026-09-26T12:00:00.0001Z' }, end: { dateTime: proposal.endAt } }) }; }), (error) => {
      assert.equal(error.code, 'GOOGLE_CALENDAR_WRITE_OUTCOME_UNCERTAIN'); assert.equal(error.safeToRetry, false); return true;
    }); assert.equal(calls, 1); assert.deepEqual(f.rows(), f.before);
  }));
  test(`Calendar ${name} accepts equivalent extra zero receipt precision without changing source bytes`, () => fixture(async (f) => {
    const result = await f.run(name, proposal, async () => ({ ok: true, json: async () => ({ ...original, id: name === 'create' ? 'new_event' : original.id,
      start: { dateTime: '2026-09-26T12:00:00.000000Z' }, end: { dateTime: '2026-09-26T13:00:00.000000Z' } }) }));
    assert.equal((name === 'create' ? result : result.after).start_at, '2026-09-26T12:00:00.000000Z');
  }));
  for (const [shape, fields] of [...timeCases, ...(name === 'create' ? createCases : [])]) test(`Calendar ${name} ${shape} fails before OAuth or write without altering cache/credentials`, () => fixture(async (f) => {
    f.token(true); const credentials = f.credentials(); let calls = 0;
    await assert.rejects(f.run(name, { ...proposal, ...fields }, () => { calls++; throw new Error(PRIVATE); }), invalid);
    assert.equal(calls, 0); assert.deepEqual(f.credentials(), credentials); assert.deepEqual(f.rows(), f.before);
  }));
  for (const fields of [name === 'create' ? { attendees: [`${PRIVATE} unresolved person`] } : { startAt: '2026-02-30T12:00:00Z' }, { endAt: proposal.startAt }]) {
    test(`approved Calendar ${name} invalid ${Object.keys(fields)[0]} blocks dependents/planning and cannot replay after restart`, () => fixture(async (f) => {
      f.token(true); const credentials = f.credentials(), nativeFetch = globalThis.fetch; let calls = 0, modelCalls = 0;
      globalThis.fetch = async () => { calls++; throw new Error(PRIVATE); };
      const agent = () => {
        const registry = createToolRegistry(), args = { ...proposal, ...fields }, instance = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => {
          modelCalls++; return { reasoning_summary: 'Fixture malformed approved change', continue: true, actions: [
            { tool: `calendar.${name}`, arguments: name === 'create' ? args : { eventId: f.localId, newStartAt: args.startAt, newEndAt: args.endAt } },
            { tool: 'tasks.create', arguments: { title: 'Dependent fixture task' }, dependsOn: [0] },
          ] };
        } }, toolRegistry: registry, policyEngine: new PolicyEngine({ policies: { calendar: { create: 'confirm', reschedule: { personal: 'confirm' } }, tasks: { create: 'autonomous' } } }), eventBus: new EventBus(getDb()) });
        instance.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return instance;
      };
      try {
        const first = agent(), run = await first.handleMessage({ text: 'Fixture invalid proposal', actorId: 'owner' }), actionId = run.actions[0].id;
        assert.equal(run.actions[0].status, 'pending'); const outcome = await first.approveAction(actionId, 'owner');
        assert.equal(outcome.status, 'failed'); assert.equal(outcome.errorClass, 'non_retryable'); assert.match(outcome.error, /no calendar change was attempted/);
        assert.doesNotMatch(JSON.stringify(getAgentAction(actionId).result), /fixture-private/);
        assert.deepEqual(getRun(run.runId).steps.map((step) => step.status), ['needs_attention', 'skipped']);
        const queue = getQueuedActionByActionId(actionId); assert.equal(queue.error_class, 'non_retryable');
        closeAllForTests(); getDb(); reconcileInterruptedRuns(); const restarted = agent();
        assert.equal(await restarted.actionQueueWorker.processNext(), null); await restarted.resumeRunDependents(run.runId); await restarted.resumeRunPlanning(run.runId);
        assert.equal(calls, 0); assert.equal(modelCalls, 1); assert.equal(listActionAttempts(queue.id).length, 1); assert.deepEqual(f.credentials(), credentials); assert.deepEqual(f.rows(), f.before);
        assert.equal(getDb().prepare("SELECT count(*) n FROM events WHERE type IN ('calendar.event_added','calendar.event_changed','agent.action.completed')").get().n, 0);
        assert.equal(getDb().prepare('SELECT count(*) n FROM tasks').get().n, 0); assert.equal(getRun(run.runId).objectiveStatus, 'unverified');
      } finally { globalThis.fetch = nativeFetch; }
    }));
  }
}
test('Calendar preflight preserves supported exact title/location/guest/time bytes and optional omitted fields', () => fixture(async (f) => {
  let calls = 0;
  for (const args of [proposal, { ...proposal, title: '  Fixture café appointment  ', location: '  Fixture room  ', attendees: ['one+tag@example.test', 'two@example.test'],
    startAt: '2026-09-26T14:00:00.125+02:00', endAt: '2026-09-26T15:00:00.125+02:00' },
  { title: 'Fixture optional fields', startAt: proposal.startAt, endAt: proposal.endAt }]) {
    const result = await f.run('create', args, async (_url, init) => {
      calls++; assert.equal(init.headers.Authorization, 'Bearer fixture-valid');
      assert.deepEqual(JSON.parse(init.body), { summary: args.title, start: { dateTime: args.startAt }, end: { dateTime: args.endAt }, ...(args.location ? { location: args.location } : {}), attendees: (args.attendees || []).map((email) => ({ email })) });
      return { ok: true, json: async () => ({ id: `receipt_${calls}`, summary: args.title, start: { dateTime: args.startAt }, end: { dateTime: args.endAt } }) };
    });
    assert.equal(result.title, args.title); assert.equal(result.start_at, args.startAt); assert.equal(result.end_at, args.endAt);
  }
  const result = await f.run('reschedule', { startAt: '2026-09-26T14:00:00.125+02:00', endAt: '2026-09-26T15:00:00.125+02:00' }, async (_url, init) => {
    calls++; const body = JSON.parse(init.body); assert.deepEqual(body, { start: { dateTime: '2026-09-26T14:00:00.125+02:00' }, end: { dateTime: '2026-09-26T15:00:00.125+02:00' } }); return { ok: true, json: async () => ({ ...original, ...body }) };
  });
  assert.equal(result.before.start_at, original.start.dateTime); assert.equal(result.after.start_at, '2026-09-26T14:00:00.125+02:00'); assert.equal(calls, 4);
}));
test('Calendar nonexistent reschedule source remains not attempted even with unusable proposed dates', () => fixture(async (f) => {
  f.token(true); const credentials = f.credentials(); assert.equal(await rescheduleEvent('missing_fixture', { newStartAt: PRIVATE, newEndAt: PRIVATE }, { ...f.options, fetchImpl() { throw new Error(PRIVATE); } }), null);
  assert.deepEqual(f.rows(), f.before); assert.deepEqual(f.credentials(), credentials);
}));
