import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine, getAgentAction, updateAgentAction } from '../server/policy/policy-engine.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { Agent } from '../server/agent/agent.js';
import { enqueueAction, leaseActionByActionId } from '../server/agent/action-queue-store.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';

async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-budgets-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}

function fixture(plan, effects, policy = 'autonomous') {
  const registry = new ToolRegistry();
  registry.register({ name: 'fixture.act', domain: 'fixture', category: 'consequential',
    schema: { properties: { label: { type: 'string' } }, required: ['label'] },
    execute: async ({ label }) => { effects.push(label); return { label }; },
  });
  const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan },
    policyEngine: new PolicyEngine({ policies: { fixture: { act: policy } } }), toolRegistry: registry, eventBus: new EventBus(getDb()) });
  agent.contextAssembler.assemble = async () => ({});
  return agent;
}

function setLimitBeforePlanning(agent, values) {
  agent.contextAssembler.assemble = async () => {
    const runId = getDb().prepare('SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT 1').get().id;
    if (values.stepLimit !== undefined) getDb().prepare('UPDATE agent_runs SET step_limit = ? WHERE id = ?').run(values.stepLimit, runId);
    if (values.deadlineAt !== undefined) getDb().prepare('UPDATE agent_runs SET deadline_at = ? WHERE id = ?').run(values.deadlineAt, runId);
    return {};
  };
}

test('total step cap stops later actions before audit or provider execution', () => withHome(async () => {
  const effects = [];
  const agent = fixture(async () => ({ reasoning_summary: 'Three actions', actions: ['one', 'two', 'three'].map((label) => (
    { tool: 'fixture.act', arguments: { label } }
  )) }), effects);
  setLimitBeforePlanning(agent, { stepLimit: 1 });
  const result = await agent.handleMessage({ text: 'Do three things' });
  assert.deepEqual(effects, ['one']);
  assert.deepEqual(getRun(result.runId).steps.map((step) => step.status), ['executed', 'budget_exhausted', 'budget_exhausted']);
  assert.equal(getRun(result.runId).status, 'budget_exhausted');
  assert.equal(getRun(result.runId).budget.stepsUsed, 1);
  assert.equal(getRun(result.runId).budget.stepLimit, 1);
  assert.equal(getRun(result.runId).budget.currentLimit, 'step_limit');
  assert.deepEqual(getRun(result.runId).budget.monetaryCost, { available: false, amount: null, currency: null });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 1);
}));

test('step cap persists through approval and restart without another model call', () => withHome(async () => {
  const effects = [];
  const plan = async () => ({ reasoning_summary: 'One approved step', continue: true, actions: [
    { tool: 'fixture.act', arguments: { label: 'one' } },
  ] });
  const first = fixture(plan, effects, 'confirm');
  setLimitBeforePlanning(first, { stepLimit: 1 });
  const result = await first.handleMessage({ text: 'Do work', actorId: 'owner' });
  closeAllForTests(); getDb(); reconcileInterruptedRuns();
  const restarted = fixture(plan, effects, 'confirm');
  await restarted.approveAction(result.actions[0].id, 'owner');
  assert.deepEqual(effects, ['one']);
  assert.equal(getRun(result.runId).modelCalls, 1);
  assert.equal(getRun(result.runId).budget.stepsUsed, 1);
  assert.equal(getRun(result.runId).budget.stopReason, 'step_limit');
  assert.equal(getRun(result.runId).status, 'budget_exhausted');
}));

test('deadline reached while a model call is in flight discards the late proposal', () => withHome(async () => {
  let began;
  let release;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const effects = [];
  const agent = fixture(async () => { began(); await held; return { reasoning_summary: 'Late', actions: [
    { tool: 'fixture.act', arguments: { label: 'late' } },
  ] }; }, effects);
  const request = agent.handleMessage({ text: 'Do work' });
  await started;
  getDb().prepare('UPDATE agent_runs SET deadline_at = ?').run('2000-01-01T00:00:00.000Z');
  release();
  const result = await request;
  assert.deepEqual(effects, []);
  assert.equal(getRun(result.runId).status, 'budget_exhausted');
  assert.equal(getRun(result.runId).modelCalls, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 0);
}));

test('an expired run cannot execute a previously pending approval', () => withHome(async () => {
  const effects = [];
  const agent = fixture(async () => ({ reasoning_summary: 'Pending', actions: [
    { tool: 'fixture.act', arguments: { label: 'one' } },
  ] }), effects, 'confirm');
  const result = await agent.handleMessage({ text: 'Do work' });
  getDb().prepare('UPDATE agent_runs SET deadline_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', result.runId);
  const outcome = await agent.approveAction(result.actions[0].id, 'owner');
  assert.equal(outcome.status, 'blocked');
  assert.equal(getAgentAction(result.actions[0].id).status, 'blocked');
  assert.deepEqual(effects, []);
  assert.equal(getRun(result.runId).status, 'budget_exhausted');
}));

test('a leased but unattempted action is stopped when the run deadline expires', () => withHome(async () => {
  const effects = [];
  const agent = fixture(async () => ({ reasoning_summary: 'Pending', actions: [
    { tool: 'fixture.act', arguments: { label: 'one' } },
  ] }), effects, 'confirm');
  const result = await agent.handleMessage({ text: 'Do work' });
  const actionId = result.actions[0].id;
  updateAgentAction(actionId, { status: 'approved' });
  enqueueAction({ actionId, correlationId: result.correlationId, tool: 'fixture.act', arguments: { label: 'one' } });
  const leased = leaseActionByActionId(actionId, { leaseOwner: agent.actionQueueWorker.workerId });
  getDb().prepare('UPDATE agent_runs SET deadline_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', result.runId);
  const outcome = await agent.actionQueueWorker._executeLeased(leased);
  assert.equal(outcome.status, 'cancelled');
  assert.deepEqual(effects, []);
  assert.equal(getRun(result.runId).budget.stopReason, 'elapsed_limit');
}));

test('a later deadline never rewrites an already-executed action on duplicate approval', () => withHome(async () => {
  const effects = [];
  const agent = fixture(async () => ({ reasoning_summary: 'Done', actions: [
    { tool: 'fixture.act', arguments: { label: 'one' } },
  ] }), effects);
  const result = await agent.handleMessage({ text: 'Do work' });
  const actionId = result.actions[0].id;
  getDb().prepare('UPDATE agent_runs SET deadline_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', result.runId);
  await assert.rejects(agent.approveAction(actionId, 'owner'), /not pending/);
  assert.equal(getAgentAction(actionId).status, 'executed');
  assert.deepEqual(effects, ['one']);
}));
