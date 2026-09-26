import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { createGoalDraft, getGoalDraft, controlGoal, updateGoalDraft } from '../server/agent/goal-store.js';
import { scheduleGoalWake } from '../server/agent/goal-wakes.js';
import { createRun, failRun, getRun } from '../server/agent/run-store.js';
import { Agent } from '../server/agent/agent.js';
import { EventBus } from '../server/events/event-bus.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createTrigger, runTick } from '../server/triggers/trigger-engine.js';
import { startServer } from './helpers/authed-server.js';

const nativeFetch = globalThis.fetch;
const draft = { objective: 'Find suitable roles', completionCriteria: ['Report roles with links'], constraints: ['Remote only'],
  permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 4, maxModelCalls: 8, maxTokens: 5000 } };
const future = () => new Date(Date.now() + 3600_000).toISOString();
async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-goal-wake-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}
function makeDue(goalId) {
  const wake = getDb().prepare("SELECT * FROM goal_wakes WHERE goal_id = ? AND status = 'pending'").get(goalId);
  const past = new Date(Date.now() - 1000).toISOString();
  getDb().prepare('UPDATE goal_wakes SET fire_at = ? WHERE id = ?').run(past, wake.id);
  getDb().prepare('UPDATE triggers SET next_check_at = ? WHERE id = ?').run(past, wake.trigger_id);
  return wake;
}
function fixture(plan) {
  const eventBus = new EventBus(getDb());
  const registry = new ToolRegistry();
  registry.register({ name: 'web.search', category: 'read', domain: 'web', schema: { properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async () => ({ title: 'fixture role', url: 'https://example.test/role' }) });
  const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan }, toolRegistry: registry,
    policyEngine: new PolicyEngine({ policies: { web: { search: 'autonomous' } } }), eventBus });
  agent.contextAssembler.assemble = async () => ({});
  return { agent, eventBus };
}

test('wake scheduling validates owner/revision/time and survives additive migration/restart', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  getDb().exec('DROP TABLE goal_wakes');
  closeAllForTests(); getDb();
  assert.equal(getGoalDraft(goal.id, 'owner').objective, draft.objective);
  const input = { fireAt: future(), expectedRevision: 1 };
  assert.throws(() => scheduleGoalWake(goal.id, 'other', input), { status: 404 });
  for (const bad of [{ ...input, fireAt: 'invalid' }, { ...input, fireAt: new Date(0).toISOString() },
    { ...input, fireAt: new Date(Date.now() + 31 * 86400_000).toISOString() }, { ...input, extra: true }]) {
    assert.throws(() => scheduleGoalWake(goal.id, 'owner', bad), { status: 400 });
  }
  assert.throws(() => scheduleGoalWake(goal.id, 'owner', { ...input, expectedRevision: 2 }), { status: 409 });
  const scheduled = scheduleGoalWake(goal.id, 'owner', input);
  assert.equal(scheduled.executionEnabled, true);
  assert.equal(scheduled.nextWakeAt, input.fireAt);
  assert.equal(scheduled.spent.runs, 0);
  assert.throws(() => scheduleGoalWake(goal.id, 'owner', input), { status: 409 });
  const wake = scheduled.lastWake;
  createTrigger({ name: 'Forged wake', kind: 'timer', source: 'user', config: { fireAt: new Date(0).toISOString(), action: { kind: 'goal_run', wakeId: wake.id } } });
  await runTick(fixture(async () => { throw new Error('forged wake must not call model'); }));
  assert.equal(getGoalDraft(goal.id, 'owner').spent.runs, 0);
  assert.throws(() => createRun({ correlationId: 'not_due', actorId: 'owner', objective: 'x', goalId: goal.id, goalWakeId: wake.id }), { status: 409 });
  assert.equal(getGoalDraft(goal.id, 'owner').status, 'draft', 'consumption failure rolls back status and run count');
  closeAllForTests(); getDb();
  assert.deepEqual(getGoalDraft(goal.id, 'owner'), scheduled);
}));

test('competing ticks and restart consume one wake once, linked before model work', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  scheduleGoalWake(goal.id, 'owner', { fireAt: future(), expectedRevision: 1 });
  const wake = makeDue(goal.id);
  let release;
  let began;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { began = resolve; });
  let calls = 0;
  const context = fixture(async () => {
    calls++;
    const stored = getGoalDraft(goal.id, 'owner');
    assert.equal(stored.lastWake.status, 'started');
    assert.equal(stored.lastWake.runId, stored.relatedRuns[0].id);
    began(); await gate;
    return { reasoning_summary: 'search', actions: [{ tool: 'web.search', arguments: { query: 'roles' } }] };
  });
  const first = runTick({ ...context, leaseOwner: 'first' });
  await started;
  await runTick({ ...context, leaseOwner: 'second' });
  release(); await first;
  assert.equal(calls, 1);
  const current = getGoalDraft(goal.id, 'owner');
  assert.equal(current.spent.runs, 1);
  assert.equal(current.nextWakeAt, null);
  assert.equal(getRun(current.lastWake.runId).steps[0].status, 'executed');
  assert.equal(getRun(current.lastWake.runId).objectiveStatus, 'unverified');
  // Simulate process exit after run persisted but before timer completion.
  getDb().prepare('UPDATE triggers SET enabled = 1, next_check_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?')
    .run(new Date(0).toISOString(), wake.trigger_id);
  closeAllForTests(); getDb();
  await runTick(fixture(async () => { throw new Error('must not retry'); }));
  assert.equal(getGoalDraft(goal.id, 'owner').spent.runs, 1);
}));

test('pause cancel and draft revision invalidate pending wakes and resume never rearms', () => withHome(async () => {
  for (const operation of ['pause', 'cancel', 'revise']) {
    const goal = createGoalDraft('owner', draft);
    scheduleGoalWake(goal.id, 'owner', { fireAt: future(), expectedRevision: 1 });
    makeDue(goal.id);
    if (operation === 'revise') updateGoalDraft(goal.id, 'owner', { ...draft, constraints: ['Local only'], expectedRevision: 1 });
    else controlGoal(goal.id, 'owner', { operation, expectedRevision: 1 });
    if (operation === 'pause') controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 2 });
    await runTick(fixture(async () => { throw new Error('must not call model'); }));
    const current = getGoalDraft(goal.id, 'owner');
    assert.equal(current.lastWake.status, 'cancelled');
    assert.equal(current.nextWakeAt, null);
    assert.equal(current.spent.runs, 0);
  }
}));

test('budget and model failure persist blockers and never retry automatically', () => withHome(async () => {
  const budget = createGoalDraft('owner', { ...draft, budgets: { ...draft.budgets, maxRuns: 1 } });
  scheduleGoalWake(budget.id, 'owner', { fireAt: future(), expectedRevision: 1 });
  const manual = createRun({ correlationId: 'spent', actorId: 'owner', objective: 'x', goalId: budget.id });
  failRun(manual, 'fixture'); makeDue(budget.id);
  await runTick(fixture(async () => { throw new Error('must not call'); }));
  assert.equal(getGoalDraft(budget.id, 'owner').lastWake.blocker, 'review_goal_budget_or_run');
  assert.equal(getGoalDraft(budget.id, 'owner').lastWake.status, 'blocked');
  const failed = createGoalDraft('owner', draft);
  scheduleGoalWake(failed.id, 'owner', { fireAt: future(), expectedRevision: 1 }); makeDue(failed.id);
  let calls = 0;
  const context = fixture(async () => { calls++; throw new Error('secret provider response'); });
  await runTick(context); await runTick(context);
  closeAllForTests(); getDb();
  const current = getGoalDraft(failed.id, 'owner');
  assert.equal(calls, 1);
  assert.equal(current.lastWake.blocker, 'inspect_run_failure');
  assert.equal(current.relatedRuns[0].status, 'failed');
  assert.equal(current.spent.runs, 1);
  assert.ok(!JSON.stringify(current).includes('secret provider response'));
  const offline = createGoalDraft('owner', draft);
  scheduleGoalWake(offline.id, 'owner', { fireAt: future(), expectedRevision: 1 }); makeDue(offline.id);
  const outage = fixture(async () => ({ reasoning_summary: 'search', actions: [{ tool: 'web.search', arguments: { query: 'roles' } }] }));
  outage.agent.toolRegistry.get('web.search').execute = async () => { throw new Error('Provider offline'); };
  await runTick(outage); await runTick(outage);
  assert.equal(getGoalDraft(offline.id, 'owner').spent.runs, 1);
  assert.equal(getGoalDraft(offline.id, 'owner').lastWake.blocker, 'inspect_run_status');
  // A generic provider exception has no definitive outcome contract; keep
  // the existing cautious owner-attention state rather than claim failure.
  assert.equal(getRun(getGoalDraft(offline.id, 'owner').lastWake.runId).steps[0].status, 'needs_attention');
}));

test('wake API is authenticated and goal timers cannot be edited through generic trigger routes', () => withHome(async () => {
  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const goal = await (await fetch(`${base}/api/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })).json();
    assert.equal((await nativeFetch(`${base}/api/goals/${goal.id}/wake`, { method: 'POST' })).status, 401);
    const result = await fetch(`${base}/api/goals/${goal.id}/wake`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fireAt: future(), expectedRevision: 1 }) });
    assert.equal(result.status, 201);
    const trigger = getDb().prepare('SELECT trigger_id FROM goal_wakes WHERE goal_id = ?').get(goal.id).trigger_id;
    assert.equal((await fetch(`${base}/api/triggers/${trigger}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' })).status, 409);
    assert.equal((await fetch(`${base}/api/triggers/${trigger}`, { method: 'DELETE' })).status, 409);
  } finally { handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve)); }
}));
