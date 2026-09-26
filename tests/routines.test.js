import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { runSeed } from '../server/seed/seed.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { getVaultDir, ensureVaultLayout } from '../server/vault/vault-dir.js';
import { parseTrigger, dueSlot, eventMatches, loadRoutines } from '../server/routines/routines.js';
import { runScheduledRoutines, runEventRoutines, runRoutineNow, listRoutineStatus, objectiveFor, MAX_RUNS_PER_HOUR } from '../server/routines/routine-runner.js';

function fixture({ demo = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-routines-'));
  process.env.U2OS_HOME = dir;
  if (demo) ensureInstallationMode('demo', dir);
  const db = getDb();
  db.prepare("INSERT INTO owners (id, entity_id, passphrase_hash, salt, scrypt_params, created_at) VALUES ('owner_1', NULL, 'x', 'x', '{}', ?)").run(new Date().toISOString());
  const vault = ensureVaultLayout(getVaultDir());
  const write = (name, text) => fs.writeFileSync(path.join(vault, 'routines', name), text);
  return { dir, db, vault, write, eventBus: new EventBus(db) };
}

function cleanup(dir) {
  closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
}

function fakeAgent({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async handleMessage(input) {
      calls.push(input);
      if (fail) throw fail;
      return { runId: `run_${calls.length}`, pendingActionIds: [], actions: [] };
    },
  };
}

const at = (iso) => new Date(iso);

test('triggers are validated strictly', () => {
  assert.deepEqual(parseTrigger({ daily: '07:30', days: ['Mon', 'friday'] }), { kind: 'daily', hour: 7, minute: 30, days: ['mon', 'fri'] });
  assert.deepEqual(parseTrigger({ every_minutes: 60 }), { kind: 'every', minutes: 60 });
  assert.deepEqual(parseTrigger({ event: 'email.received', if: { path: 'data.after.from', contains: 'Recruit' } }),
    { kind: 'event', eventType: 'email.received', condition: { path: 'data.after.from', contains: 'recruit' } });
  for (const bad of [null, {}, { daily: '25:00' }, { every_minutes: 5 }, { daily: '07:00', every_minutes: 60 },
    { event: 'routine.fired' }, { event: 'agent.message.received' }, { event: 'email.received', if: { path: 'data.x' } },
    { daily: '07:00', days: ['someday'] }]) {
    assert.throws(() => parseTrigger(bad), (error) => error.code === 'VAULT_INVALID', JSON.stringify(bad));
  }
});

test('daily routines are due only within their grace window and on listed days', () => {
  const trigger = parseTrigger({ daily: '07:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
  const monday = new Date(2026, 8, 28, 7, 5);
  assert.equal(dueSlot(trigger, monday), 'daily:2026-09-28');
  assert.equal(dueSlot(trigger, new Date(2026, 8, 28, 6, 59)), null, 'not before its time');
  assert.equal(dueSlot(trigger, new Date(2026, 8, 28, 9, 30)), null, 'a restart hours later does not replay it');
  assert.equal(dueSlot(trigger, new Date(2026, 8, 27, 7, 5)), null, 'Sunday is not listed');
  const every = parseTrigger({ every_minutes: 30 });
  assert.equal(dueSlot(every, at('2026-09-28T10:10:00Z')), dueSlot(every, at('2026-09-28T10:25:00Z')));
  assert.notEqual(dueSlot(every, at('2026-09-28T10:25:00Z')), dueSlot(every, at('2026-09-28T10:31:00Z')));
});

test('event conditions match exact or contained values only', () => {
  const trigger = parseTrigger({ event: 'email.received', if: { path: 'data.after.from', contains: 'talent' } });
  assert.equal(eventMatches(trigger, { type: 'email.received', data: { after: { from: 'jo@NorthwindTalent.example' } } }), true);
  assert.equal(eventMatches(trigger, { type: 'email.received', data: { after: { from: 'mom@example.com' } } }), false);
  assert.equal(eventMatches(trigger, { type: 'email.received', data: {} }), false);
  assert.equal(eventMatches(trigger, { type: 'calendar.event_added', data: { after: { from: 'talent' } } }), false);
  const inherited = parseTrigger({ event: 'email.received', if: { path: 'constructor', contains: 'function' } });
  assert.equal(eventMatches(inherited, { type: 'email.received' }), false, 'only plain text/number/boolean values are compared');
});

test('invalid routine files are reported and never run', async () => {
  const { dir, write, eventBus } = fixture();
  try {
    write('broken.md', '---\nwhen:\n  daily: "7am"\n---\nDo things.\n');
    write('empty.md', '---\nwhen:\n  every_minutes: 60\n---\n');
    const agent = fakeAgent();
    await runScheduledRoutines({ eventBus, agent, now: new Date() });
    assert.equal(agent.calls.length, 0);
    const status = listRoutineStatus();
    assert.equal(status.length, 2);
    assert.ok(status.every((routine) => routine.error));
  } finally { cleanup(dir); }
});

test('a scheduled routine runs once per slot, including across restarts', async () => {
  const { dir, write, eventBus } = fixture();
  try {
    write('brief.md', '---\nname: Morning brief\nwhen:\n  daily: "07:00"\n---\nBrief me on today.\n');
    write('paused.md', '---\nenabled: false\nwhen:\n  daily: "07:00"\n---\nShould not run.\n');
    const agent = fakeAgent();
    const now = new Date(2026, 8, 28, 7, 1);
    const first = await runScheduledRoutines({ eventBus, agent, now });
    assert.equal(first.length, 1);
    assert.equal(agent.calls[0].actorId, 'owner_1');
    assert.match(agent.calls[0].text, /Routine: Morning brief[\s\S]*Brief me on today\./);

    await runScheduledRoutines({ eventBus, agent, now: new Date(2026, 8, 28, 7, 30) });
    closeAllForTests();
    const restarted = new EventBus(getDb());
    await runScheduledRoutines({ eventBus: restarted, agent, now: new Date(2026, 8, 28, 7, 45) });
    assert.equal(agent.calls.length, 1, 'the same day slot never runs twice');

    await runScheduledRoutines({ eventBus: restarted, agent: fakeAgent(), now: new Date(2026, 8, 29, 7, 0) });
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM routine_runs').get().n, 2, 'the next day is a new slot');
    const types = getDb().prepare("SELECT type FROM events WHERE type LIKE 'routine.%' ORDER BY rowid").all().map((row) => row.type);
    assert.deepEqual(types, ['routine.fired', 'routine.completed', 'routine.fired', 'routine.completed']);
  } finally { cleanup(dir); }
});

test('an event routine fires once per matching event and passes identifiers, not content', async () => {
  const { dir, write, eventBus } = fixture();
  try {
    write('recruiters.md', '---\nwhen:\n  event: email.received\n  if:\n    path: data.after.from\n    contains: talent\n---\nDraft a polite reply using my job preferences.\n');
    const agent = fakeAgent();
    const event = { id: 'evt_1', type: 'email.received', subject: { type: 'email', id: 'em_42' }, data: { after: { from: 'jo@northwindtalent.example', body: 'SECRET salary details' } } };
    await runEventRoutines({ eventBus, agent, event });
    await runEventRoutines({ eventBus, agent, event });
    await runEventRoutines({ eventBus, agent, event: { ...event, id: 'evt_2', data: { after: { from: 'mom@example.com' } } } });
    assert.equal(agent.calls.length, 1);
    assert.match(agent.calls[0].text, /email\.received \(event id evt_1, email id em_42\)/);
    assert.doesNotMatch(agent.calls[0].text, /SECRET|northwindtalent/, 'event content never enters the objective');
  } finally { cleanup(dir); }
});

test('failures record a sanitized reason and the runaway guard throttles routine storms', async () => {
  const { dir, db, write, eventBus } = fixture();
  try {
    write('flaky.md', '---\nwhen:\n  event: email.received\n---\nDo it.\n');
    const failing = fakeAgent({ fail: Object.assign(new Error('provider said: private text'), { code: 'MODEL_UNAVAILABLE' }) });
    const [result] = await runEventRoutines({ eventBus, agent: failing, event: { id: 'evt_f', type: 'email.received' } });
    assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'failed', reason: 'MODEL_UNAVAILABLE' });
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM routine_runs').all()), /private text/);

    const agent = fakeAgent();
    for (let i = 0; i < MAX_RUNS_PER_HOUR + 3; i++) await runEventRoutines({ eventBus, agent, event: { id: `evt_${i}`, type: 'email.received' } });
    assert.equal(agent.calls.length, MAX_RUNS_PER_HOUR - 1, 'the failed run counts toward the hourly limit');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM routine_runs WHERE status = 'throttled'").get().n, 4);
  } finally { cleanup(dir); }
});

test('without an owner account no routine runs', async () => {
  const { dir, db, write, eventBus } = fixture();
  try {
    db.prepare('DELETE FROM owners').run();
    write('any.md', '---\nwhen:\n  every_minutes: 15\n---\nDo it.\n');
    const agent = fakeAgent();
    await runScheduledRoutines({ eventBus, agent });
    assert.equal(agent.calls.length, 0);
  } finally { cleanup(dir); }
});

function realAgent(policies) {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  const agent = new Agent({ modelProvider: new MockModelProvider(), policyEngine: new PolicyEngine(policies ? { policies } : {}), toolRegistry: createToolRegistry(), eventBus, ownerEntityId });
  return { db, eventBus, agent };
}

test('a routine acts through the real agent and policy, and consequential actions still wait for approval', async () => {
  const { dir, write } = fixture({ demo: true });
  try {
    write('water.md', '---\nwhen:\n  every_minutes: 60\n---\nremind me to water the plants\n');
    const allowed = realAgent();
    const autonomous = await runRoutineNow({ eventBus: allowed.eventBus, agent: allowed.agent, routinePath: 'routines/water.md' });
    assert.equal(autonomous.status, 'completed');
    assert.equal(autonomous.pendingApprovals, 0);
    const executed = allowed.db.prepare("SELECT status FROM agent_actions WHERE tool = 'tasks.create' ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(executed.status, 'executed');

    const guarded = realAgent({
      email: { read: 'always', draft: 'always', send: { default: 'confirm' } },
      tasks: { create: 'confirm', complete: 'confirm' },
      notifications: { send: 'confirm' },
    });
    const pending = await runRoutineNow({ eventBus: guarded.eventBus, agent: guarded.agent, routinePath: 'routines/water.md' });
    assert.equal(pending.status, 'completed');
    assert.equal(pending.pendingApprovals, 1, 'the routine cannot act beyond delegated authority');
    const [status] = listRoutineStatus();
    assert.equal(status.lastRun.reason, 'awaiting_approval');
  } finally { cleanup(dir); }
});

test('the objective names the routine and its trigger', () => {
  const routine = { name: 'Brief', trigger: parseTrigger({ daily: '07:00' }), instruction: 'Brief me.' };
  assert.equal(objectiveFor(routine, 'daily', null), 'Carry out this standing routine from my vault on my behalf.\nRoutine: Brief\nTrigger: daily at 07:00\n\nBrief me.');
  assert.equal(loadRoutines(fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-empty-vault-'))).length, 0);
});
