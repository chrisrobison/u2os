import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createGoalDraft, getGoalDraft, controlGoal, updateGoalDraft } from '../server/agent/goal-store.js';
import { scheduleGoalResearch, scheduleGoalWake, advanceGoalResearchSchedules } from '../server/agent/goal-wakes.js';
import { Agent } from '../server/agent/agent.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { getRun } from '../server/agent/run-store.js';
import { runTick } from '../server/triggers/trigger-engine.js';
import { startServer } from './helpers/authed-server.js';

const nativeFetch = globalThis.fetch;

const draft = { objective: 'Research remote roles', completionCriteria: ['Explain source-linked fit'], constraints: ['No outreach'],
  permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 10, maxModelCalls: 20, maxTokens: 30000 } };
const input = () => ({ fireAt: new Date(Date.now() + 3600_000).toISOString(), expectedRevision: 1, intervalHours: 24, maxPasses: 2 });
async function home(fn) {
  process.env.U2OS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-research-series-'));
  const dir = process.env.U2OS_HOME;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}
function due(goal) {
  const wake = getGoalDraft(goal.id, 'owner').lastWake;
  const past = new Date(Date.now() - 1000).toISOString();
  getDb().prepare('UPDATE goal_wakes SET fire_at = ? WHERE id = ?').run(past, wake.id);
  getDb().prepare('UPDATE triggers SET next_check_at = ? WHERE id = ?').run(past, getDb().prepare('SELECT trigger_id FROM goal_wakes WHERE id = ?').get(wake.id).trigger_id);
  return wake;
}
function fixture({ plan, execute } = {}) {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'web.search', domain: 'web', category: 'read', schema: { properties: { query: { type: 'string' } }, required: ['query'] },
    execute: execute || (async () => ({ mock: true, results: [{ title: 'Fixture role', url: 'https://jobs.example.test/role' }] })) });
  const eventBus = new EventBus(getDb());
  const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async (...args) => {
    calls++; return plan ? plan(...args) : { reasoning_summary: 'search', actions: [{ tool: 'web.search', arguments: { query: 'roles' } }] };
  } }, toolRegistry: registry, eventBus, policyEngine: new PolicyEngine({ policies: { web: { search: 'autonomous' } } }) });
  agent.contextAssembler.assemble = async () => ({});
  return { agent, eventBus, calls: () => calls };
}

test('finite research validates owner, revision, web scope, timing, counts and remaining budgets without partial writes', () => home(async () => {
  const goal = createGoalDraft('owner', draft);
  assert.throws(() => scheduleGoalResearch(goal.id, 'other', input()), { status: 404 });
  for (const change of [{ intervalHours: 23 }, { intervalHours: 721 }, { intervalHours: 24.5 }, { maxPasses: 1 }, { maxPasses: 11 },
    { fireAt: 'invalid' }, { fireAt: new Date(0).toISOString() }, { extra: true }]) {
    assert.throws(() => scheduleGoalResearch(goal.id, 'owner', { ...input(), ...change }), { status: 400 });
  }
  assert.throws(() => scheduleGoalResearch(goal.id, 'owner', { ...input(), expectedRevision: 2 }), { status: 409 });
  const mixed = createGoalDraft('owner', { ...draft, permittedScope: { domains: ['web', 'email'], consequentialActions: false } });
  assert.throws(() => scheduleGoalResearch(mixed.id, 'owner', input()), { status: 409 });
  const limited = createGoalDraft('owner', { ...draft, budgets: { ...draft.budgets, maxRuns: 1 } });
  assert.throws(() => scheduleGoalResearch(limited.id, 'owner', input()), { status: 409 });
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM goal_wakes').get().n, 0);
  const saved = scheduleGoalResearch(goal.id, 'owner', input());
  assert.equal(saved.spent.runs, 0);
  assert.equal(saved.executionEnabled, true);
  assert.equal(saved.researchSchedule.scheduledPasses, 1);
  assert.equal(saved.researchSchedule.successfulPasses, 0);
  assert.throws(() => scheduleGoalResearch(goal.id, 'owner', input()), { status: 409 });
  assert.throws(() => scheduleGoalWake(goal.id, 'owner', { fireAt: input().fireAt, expectedRevision: 1 }), { status: 409 });
  closeAllForTests(); getDb();
  assert.deepEqual(getGoalDraft(goal.id, 'owner'), saved);
}));

test('finite passes checkpoint once across ticks and restart, skip missed intervals and never imply objective completion', () => home(async () => {
  const goal = createGoalDraft('owner', draft);
  scheduleGoalResearch(goal.id, 'owner', input());
  const context = fixture();
  await runTick(context); await runTick(context);
  assert.equal(context.calls(), 0, 'idle schedule never calls model');
  due(goal); await runTick(context);
  assert.equal(context.calls(), 1);
  const afterRestart = new Date(Date.now() + 7 * 86400_000);
  closeAllForTests(); getDb();
  advanceGoalResearchSchedules(afterRestart);
  const next = getGoalDraft(goal.id, 'owner');
  assert.equal(next.researchSchedule.successfulPasses, 1);
  assert.equal(next.researchSchedule.scheduledPasses, 2);
  assert.equal(next.nextWakeAt, new Date(afterRestart.getTime() + 86400_000).toISOString());
  advanceGoalResearchSchedules(afterRestart);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM goal_wakes').get().n, 2);
  assert.equal(getRun(next.relatedRuns[0].id).objectiveStatus, 'unverified');
  const restartedContext = fixture();
  due(goal); await runTick(restartedContext); advanceGoalResearchSchedules();
  const finished = getGoalDraft(goal.id, 'owner');
  assert.equal(finished.researchSchedule.status, 'completed');
  assert.equal(finished.researchSchedule.successfulPasses, 2);
  assert.equal(finished.nextWakeAt, null);
  assert.equal(finished.executionEnabled, false);
  assert.equal(finished.status, 'active', 'series completion is not goal completion');
  await runTick(restartedContext); assert.equal(context.calls() + restartedContext.calls(), 2);
}));

test('running pass cannot rearm during competing ticks and pause/revision/resume permanently invalidates its series', () => home(async () => {
  const goal = createGoalDraft('owner', draft);
  scheduleGoalResearch(goal.id, 'owner', input()); due(goal);
  let release, began;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { began = resolve; });
  const context = fixture({ plan: async () => { began(); await gate; return { reasoning_summary: 'search', actions: [{ tool: 'web.search', arguments: { query: 'roles' } }] }; } });
  const first = runTick({ ...context, leaseOwner: 'first' });
  await started;
  await runTick({ ...context, leaseOwner: 'second' });
  assert.equal(context.calls(), 1);
  assert.equal(getGoalDraft(goal.id, 'owner').researchSchedule.scheduledPasses, 1);
  controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 1 });
  updateGoalDraft(goal.id, 'owner', { ...draft, constraints: ['Changed scope'], expectedRevision: 2 });
  controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 3 });
  release(); await first; advanceGoalResearchSchedules();
  assert.equal(getGoalDraft(goal.id, 'owner').researchSchedule.status, 'cancelled');
  assert.equal(getGoalDraft(goal.id, 'owner').nextWakeAt, null);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM goal_wakes').get().n, 1);
}));

test('provider/model failure, no reads, uncertain outcomes and cumulative budgets stop research without automatic retry', () => home(async () => {
  for (const kind of ['provider', 'model', 'empty', 'uncertain', 'budget']) {
    const goal = createGoalDraft('owner', kind === 'budget' ? { ...draft, budgets: { ...draft.budgets, maxModelCalls: 2 } } : draft);
    scheduleGoalResearch(goal.id, 'owner', input()); due(goal);
    const context = fixture({
      plan: async (ctx) => {
        if (kind === 'model') throw new Error('secret model error');
        if (kind === 'empty') return { reasoning_summary: 'Need input', actions: [], response: 'Please clarify role.' };
        if (kind === 'budget') return { reasoning_summary: 'read again', continue: true, actions: [{ tool: 'web.search', arguments: { query: `roles ${ctx.observations?.length || 0}` } }] };
        return { reasoning_summary: 'search', actions: [{ tool: 'web.search', arguments: { query: 'roles' } }] };
      }, execute: async () => { if (kind === 'provider') throw new Error('secret provider error'); return { results: [] }; },
    });
    await runTick(context);
    if (kind === 'uncertain') getDb().prepare("UPDATE agent_actions SET status = 'uncertain' WHERE correlation_id = ?").run(getRun(getGoalDraft(goal.id, 'owner').lastWake.runId).correlationId);
    const calls = context.calls();
    advanceGoalResearchSchedules(); await runTick(context); advanceGoalResearchSchedules();
    const stopped = getGoalDraft(goal.id, 'owner');
    assert.equal(stopped.researchSchedule.status, 'blocked', kind);
    assert.equal(stopped.researchSchedule.scheduledPasses, 1, kind);
    assert.equal(stopped.nextWakeAt, null, kind);
    assert.equal(context.calls(), calls, kind);
    assert.ok(!JSON.stringify(stopped.researchSchedule).includes('secret'));
  }
}));

test('checkpoint and next timer roll back together on storage failure and local scans stay bounded and fair', () => home(async () => {
  const goal = createGoalDraft('owner', draft);
  scheduleGoalResearch(goal.id, 'owner', input()); due(goal);
  await runTick(fixture());
  getDb().exec("CREATE TRIGGER fixture_no_wake BEFORE INSERT ON goal_wakes BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");
  assert.equal(advanceGoalResearchSchedules().unavailable, 1);
  assert.equal(getGoalDraft(goal.id, 'owner').researchSchedule.successfulPasses, 0);
  assert.equal(getGoalDraft(goal.id, 'owner').researchSchedule.blocker, 'checkpoint_unavailable');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM goal_wakes').get().n, 1);
  getDb().exec('DROP TRIGGER fixture_no_wake');
  advanceGoalResearchSchedules(); advanceGoalResearchSchedules();
  assert.equal(getGoalDraft(goal.id, 'owner').researchSchedule.successfulPasses, 1);
  assert.equal(getGoalDraft(goal.id, 'owner').researchSchedule.blocker, null);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM goal_wakes').get().n, 2);
  for (let i = 0; i < 21; i++) scheduleGoalResearch(createGoalDraft('owner', draft).id, 'owner', input());
  const now = new Date(Date.now() + 1000);
  assert.equal(advanceGoalResearchSchedules(now).checked, 20);
  assert.equal(advanceGoalResearchSchedules(new Date(now.getTime() + 1000)).checked, 20);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM goal_research_schedules WHERE checked_at < ?').get(now.toISOString()).n, 0);
}));

test('successful pass remains counted when next-pass budget is exhausted and stopped schedules never resurrect', () => home(async () => {
  const goal = createGoalDraft('owner', draft);
  scheduleGoalResearch(goal.id, 'owner', input()); due(goal);
  await runTick(fixture());
  // Additional owner-started work consumes cumulative resources too.
  await fixture().agent.handleMessage({ text: goal.objective, actorId: 'owner', goalId: goal.id });
  getDb().prepare('UPDATE agent_runs SET model_call_count = 20 WHERE goal_id = ? AND id = ?').run(goal.id, getGoalDraft(goal.id, 'owner').relatedRuns[0].id);
  advanceGoalResearchSchedules();
  const blocked = getGoalDraft(goal.id, 'owner');
  assert.equal(blocked.researchSchedule.blocker, 'review_goal_budget_or_run');
  assert.equal(blocked.researchSchedule.successfulPasses, 1);
  assert.equal(blocked.researchSchedule.scheduledPasses, 1);
  const cancelled = createGoalDraft('owner', draft);
  scheduleGoalResearch(cancelled.id, 'owner', input());
  controlGoal(cancelled.id, 'owner', { operation: 'cancel', expectedRevision: 1 });
  advanceGoalResearchSchedules();
  assert.equal(getGoalDraft(cancelled.id, 'owner').researchSchedule.status, 'cancelled');
  assert.equal(getGoalDraft(cancelled.id, 'owner').nextWakeAt, null);
}));

test('checkpoint storage failure does not stall unrelated due goal work', () => home(async () => {
  const first = createGoalDraft('owner', draft);
  scheduleGoalResearch(first.id, 'owner', input()); due(first);
  await runTick(fixture());
  const other = createGoalDraft('owner', draft);
  scheduleGoalWake(other.id, 'owner', { fireAt: input().fireAt, expectedRevision: 1 }); due(other);
  getDb().exec("CREATE TRIGGER fixture_no_wake BEFORE INSERT ON goal_wakes BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");
  const context = fixture();
  await runTick(context);
  assert.equal(context.calls(), 1);
  assert.equal(getGoalDraft(other.id, 'owner').spent.runs, 1);
  assert.equal(getGoalDraft(first.id, 'owner').researchSchedule.successfulPasses, 0);
  assert.equal(getGoalDraft(first.id, 'owner').researchSchedule.blocker, 'checkpoint_unavailable');
}));

test('additive schedule migration preserves existing goal and one-time wake', () => home(async () => {
  const goal = createGoalDraft('owner', draft);
  scheduleGoalWake(goal.id, 'owner', { fireAt: input().fireAt, expectedRevision: 1 });
  const saved = getGoalDraft(goal.id, 'owner');
  getDb().exec('DROP TABLE goal_research_schedules');
  closeAllForTests(); getDb(); closeAllForTests(); getDb();
  assert.deepEqual(getGoalDraft(goal.id, 'owner'), saved);
}));

test('research scheduling API is owner authenticated and CSRF protected and never starts work immediately', () => home(async () => {
  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const response = await fetch(`${base}/api/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
    const goal = await response.json();
    const url = `${base}/api/goals/${goal.id}/research-schedule`;
    assert.equal((await nativeFetch(url, { method: 'POST' })).status, 401);
    const login = await nativeFetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'test-only owner passphrase' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await nativeFetch(url, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(input()) })).status, 403);
    const other = createGoalDraft('different-owner', draft);
    assert.equal((await fetch(`${base}/api/goals/${other.id}/research-schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) })).status, 404);
    const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) });
    assert.equal(result.status, 201);
    assert.equal((await result.json()).spent.runs, 0);
  } finally { handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve)); }
}));
