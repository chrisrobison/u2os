import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { controlGoal, createGoalDraft, getGoalDraft, getGoalRunEvidence } from '../server/agent/goal-store.js';
import { beginModelCall, beginRunStep, createRun, failRun, getRun, recordRunPlan } from '../server/agent/run-store.js';
import { startServer } from './helpers/authed-server.js';

const nativeFetch = globalThis.fetch;
const draft = { objective: 'Find suitable roles', completionCriteria: ['Report relevant roles with links'], constraints: [],
  permittedScope: { domains: ['web'], consequentialActions: false }, budgets: { maxRuns: 4, maxModelCalls: 8, maxTokens: 5000 } };

async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-goal-lifecycle-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('goal lifecycle is owner scoped, revision safe, terminal on cancel, and durable', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  const runId = createRun({ correlationId: 'lifecycle_fixture', actorId: 'owner', objective: goal.objective, goalId: goal.id });
  failRun(runId, 'provider offline');
  assert.throws(() => controlGoal(goal.id, 'other', { operation: 'pause', expectedRevision: 1 }), { status: 404 });
  assert.throws(() => controlGoal(goal.id, 'owner', { operation: 'start', expectedRevision: 1 }), { status: 400 });
  assert.throws(() => controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 2 }), { status: 409 });
  let current = controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 1 });
  assert.equal(current.status, 'paused');
  assert.equal(current.revision, 2);
  assert.throws(() => controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 1 }), { status: 409 });
  assert.equal(controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 1 }).revision, 2);
  assert.throws(() => createRun({ correlationId: 'paused_run', actorId: 'owner', objective: 'x', goalId: goal.id }), { status: 409 });
  closeAllForTests(); getDb();
  assert.equal(getGoalDraft(goal.id, 'owner').status, 'paused');
  current = controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 2 });
  assert.equal(current.status, 'active');
  assert.equal(current.spent.runs, 1);
  assert.equal(current.relatedRuns[0].id, runId);
  current = controlGoal(goal.id, 'owner', { operation: 'cancel', expectedRevision: 3 });
  assert.equal(current.status, 'cancelled');
  assert.equal(controlGoal(goal.id, 'owner', { operation: 'cancel', expectedRevision: 3 }).revision, 4);
  assert.throws(() => controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 4 }), { status: 409 });
  assert.throws(() => createRun({ correlationId: 'cancelled_run', actorId: 'owner', objective: 'x', goalId: goal.id }), { status: 409 });
  assert.equal(getGoalDraft(goal.id, 'owner').spent.runs, 1);
}));

test('paused goal state blocks new planning and steps on an existing run', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  const runId = createRun({ correlationId: 'paused_boundaries', actorId: 'owner', objective: goal.objective, goalId: goal.id });
  recordRunPlan(runId, { reasoning_summary: 'search', actions: [{ tool: 'web.search', arguments: { query: 'never' } }] });
  controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 1 });
  assert.throws(() => beginModelCall(runId), { code: 'RUN_BUDGET_EXHAUSTED', reason: 'goal_unavailable' });
  assert.throws(() => beginRunStep(runId, 0), { code: 'RUN_BUDGET_EXHAUSTED', reason: 'goal_unavailable' });
  controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 2 });
  assert.throws(() => beginModelCall(runId), { code: 'RUN_BUDGET_EXHAUSTED', reason: 'goal_unavailable' });
  assert.throws(() => beginRunStep(runId, 0), { code: 'RUN_BUDGET_EXHAUSTED', reason: 'goal_unavailable' });
  assert.equal(getRun(runId).modelCalls, 0);
  assert.equal(getRun(runId).budget.stepsUsed, 0);
}));

test('old immutable goal runs receive a one-time revision snapshot without rebinding later', () => withHome(async () => {
  const goal = createGoalDraft('owner', draft);
  const runId = createRun({ correlationId: 'old_goal_revision', actorId: 'owner', objective: goal.objective, goalId: goal.id });
  getDb().exec('ALTER TABLE agent_runs DROP COLUMN goal_revision');
  closeAllForTests(); getDb();
  assert.equal(getDb().prepare('SELECT goal_revision FROM agent_runs WHERE id = ?').get(runId).goal_revision, 1);
  controlGoal(goal.id, 'owner', { operation: 'pause', expectedRevision: 1 });
  controlGoal(goal.id, 'owner', { operation: 'resume', expectedRevision: 2 });
  closeAllForTests(); getDb();
  assert.equal(getDb().prepare('SELECT goal_revision FROM agent_runs WHERE id = ?').get(runId).goal_revision, 1);
  assert.throws(() => beginModelCall(runId), { code: 'RUN_BUDGET_EXHAUSTED', reason: 'goal_unavailable' });
  getDb().prepare('UPDATE agent_runs SET goal_revision = NULL WHERE id = ?').run(runId);
  closeAllForTests(); getDb();
  assert.equal(getDb().prepare('SELECT goal_revision FROM agent_runs WHERE id = ?').get(runId).goal_revision, null);
  assert.throws(() => beginModelCall(runId), { code: 'RUN_BUDGET_EXHAUSTED', reason: 'goal_unavailable' });
}));

test('owner pause API preserves an in-flight read outcome and prevents dependent work', () => withHome(async () => {
  const handle = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${handle.port}`;
  let began;
  let release;
  const started = new Promise((resolve) => { began = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const effects = [];
  handle.agent.planner.modelRouter = null;
  handle.agent.planner.modelProvider = { id: 'fixture', destination: 'local_model', plan: async () => ({ reasoning_summary: 'two reads', actions: [
    { tool: 'web.search', arguments: { query: 'first' } },
    { tool: 'web.search', arguments: { query: 'second' }, dependsOn: [0] },
  ] }) };
  handle.toolRegistry.get('web.search').execute = async ({ query }) => { effects.push(query); began(); await gate; return { title: 'confirmed read' }; };
  try {
    const goal = await (await fetch(`${base}/api/goals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })).json();
    assert.equal((await nativeFetch(`${base}/api/goals/${goal.id}/control`, { method: 'POST' })).status, 401);
    const running = fetch(`${base}/api/goals/${goal.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await started;
    const pause = await fetch(`${base}/api/goals/${goal.id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'pause', expectedRevision: 1 }) });
    assert.equal(pause.status, 200);
    const paused = await pause.json();
    assert.equal(paused.status, 'paused');
    assert.equal(paused.manualRunAvailable, false);
    assert.equal((await fetch(`${base}/api/goals/${goal.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
    release();
    const result = await (await running).json();
    assert.deepEqual(effects, ['first']);
    assert.equal(getRun(result.runId).status, 'cancelled');
    const ownerId = getDb().prepare('SELECT owner_id FROM goals WHERE id = ?').get(goal.id).owner_id;
    const evidence = getGoalRunEvidence(goal.id, ownerId, result.runId);
    assert.equal(evidence.steps[0].status, 'executed');
    assert.equal(evidence.steps[1].status, 'cancelled');
    const resumed = await (await fetch(`${base}/api/goals/${goal.id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'resume', expectedRevision: paused.revision }) })).json();
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.spent.runs, 1);
    assert.equal(resumed.manualRunAvailable, true);
    assert.deepEqual(effects, ['first'], 'resume never starts another run');
  } finally { release(); handle.server.closeAllConnections(); await new Promise((resolve) => handle.server.close(resolve)); }
}));
