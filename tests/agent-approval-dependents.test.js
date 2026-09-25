import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { Agent } from '../server/agent/agent.js';
import { getRun, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import { updateAgentAction } from '../server/policy/policy-engine.js';

async function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-dependents-'));
  process.env.U2OS_HOME = dir;
  try { await fn(); }
  finally { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }
}

function fixture(calls, { failFirst = false } = {}) {
  const registry = new ToolRegistry();
  for (const name of ['prepare', 'finish', 'finalize']) registry.register({
    name: `fixture.${name}`, domain: 'fixture', category: 'consequential',
    schema: { properties: { value: { type: 'string' } }, required: ['value'] },
    execute: async (args) => {
      calls.push({ name, args });
      if (name === 'prepare' && failFirst) throw new Error('fixture failure');
      return { done: name };
    },
  });
  return new Agent({
    modelProvider: { id: 'fixture-model', destination: 'local_model', plan: async () => ({
      reasoning_summary: 'Prepared work before completing it', actions: [
        { tool: 'fixture.prepare', arguments: { value: 'one' } },
        { tool: 'fixture.finish', arguments: { value: 'two' }, dependsOn: [0] },
        { tool: 'fixture.finalize', arguments: { value: 'three' }, dependsOn: [1] },
      ],
    }) },
    policyEngine: new PolicyEngine({ policies: { fixture: { prepare: 'confirm', finish: 'autonomous', finalize: 'autonomous' } } }),
    toolRegistry: registry, eventBus: new EventBus(getDb()),
  });
}

test('approval after restart wakes transitive dependents exactly once', () => withHome(async () => {
  const calls = [];
  const first = fixture(calls);
  const result = await first.handleMessage({ text: 'Prepare and finish', actorId: 'owner' });
  assert.deepEqual(result.actions.map((item) => item.status), ['pending', 'waiting_dependency', 'waiting_dependency']);
  assert.equal(getRun(result.runId).status, 'waiting_for_approval');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 1);
  closeAllForTests(); getDb(); reconcileInterruptedRuns();
  const restarted = fixture(calls);
  const approval = await restarted.approveAction(result.actions[0].id, 'owner');
  assert.equal(approval.status, 'executed');
  assert.deepEqual(calls.map((item) => item.name), ['prepare', 'finish', 'finalize']);
  assert.deepEqual(getRun(result.runId).steps.map((item) => item.status), ['executed', 'executed', 'executed']);
  assert.equal(getRun(result.runId).status, 'completed');
  await restarted.resumeRunDependents(result.runId);
  assert.equal(calls.length, 3);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 3);
}));

test('rejection skips dependent steps without executing or auditing them', () => withHome(async () => {
  const calls = [];
  const agent = fixture(calls);
  const result = await agent.handleMessage({ text: 'Prepare and finish' });
  await agent.rejectAction(result.actions[0].id, 'owner');
  assert.deepEqual(getRun(result.runId).steps.map((item) => item.status), ['rejected', 'skipped', 'skipped']);
  assert.deepEqual(calls, []);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 1);
}));

test('pending prerequisite and duplicate wakes never start a dependent action', () => withHome(async () => {
  const calls = [];
  const agent = fixture(calls);
  const result = await agent.handleMessage({ text: 'Prepare and finish' });
  await Promise.all([agent.resumeRunDependents(result.runId), agent.resumeRunDependents(result.runId)]);
  assert.deepEqual(calls, []);
  assert.equal(getRun(result.runId).status, 'waiting_for_approval');
}));

test('uncertain external outcome keeps dependent work dormant for owner review', () => withHome(async () => {
  const calls = [];
  const agent = fixture(calls);
  const result = await agent.handleMessage({ text: 'Prepare and finish' });
  const actionId = result.actions[0].id;
  updateAgentAction(actionId, { status: 'approved' });
  const queue = enqueueAction({ actionId, correlationId: result.correlationId, tool: 'fixture.prepare', arguments: { value: 'one' } });
  const db = getDb();
  db.prepare("UPDATE action_queue SET status = 'failed', error_class = 'owner_attention_required' WHERE id = ?").run(queue.id);
  db.prepare(`INSERT INTO action_attempts (id, queue_id, attempt_number, lease_owner, status, started_at, finished_at, error, error_class)
    VALUES ('attempt_uncertain', ?, 1, 'expired-worker', 'failed', ?, ?, 'lease expired', 'retryable')`)
    .run(queue.id, new Date().toISOString(), new Date().toISOString());
  await agent.resumeRunDependents(result.runId);
  assert.deepEqual(getRun(result.runId).steps.map((item) => item.status), ['outcome_uncertain', 'waiting_dependency', 'waiting_dependency']);
  assert.equal(getRun(result.runId).status, 'needs_attention');
  assert.deepEqual(calls, []);
}));

test('a failed prerequisite cannot launch dependent work', () => withHome(async () => {
  const calls = [];
  const agent = fixture(calls, { failFirst: true });
  const result = await agent.handleMessage({ text: 'Prepare and finish' });
  const approval = await agent.approveAction(result.actions[0].id, 'owner');
  assert.equal(approval.status, 'failed');
  assert.deepEqual(calls.map((item) => item.name), ['prepare']);
  assert.deepEqual(getRun(result.runId).steps.map((item) => item.status), ['needs_attention', 'skipped', 'skipped']);
}));

test('voice authorization remains restrictive for a step resumed after approval', () => withHome(async () => {
  const calls = [];
  const agent = fixture(calls);
  const result = await agent.handleMessage({ text: 'Prepare and finish', voice: { confidence: 0 }, actorId: 'owner' });
  await agent.approveAction(result.actions[0].id, 'owner');
  assert.deepEqual(calls.map((item) => item.name), ['prepare']);
  assert.equal(getRun(result.runId).steps[1].status, 'pending');
  assert.equal(getRun(result.runId).steps[2].status, 'waiting_dependency');
}));
