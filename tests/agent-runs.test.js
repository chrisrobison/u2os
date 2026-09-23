import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { Agent } from '../server/agent/agent.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import { createRun, recordRunPlan, beginRunStep, getRun, listRuns, reconcileInterruptedRuns } from '../server/agent/run-store.js';
import { startServer } from '../server/index.js';

function tempHome() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-runs-')); process.env.U2OS_HOME = dir; return dir; }
function cleanup(dir) { closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true }); }

function fixtureAgent(createPolicy = 'autonomous') {
  const eventBus = new EventBus(getDb());
  return new Agent({
    modelProvider: { id: 'local-fixture', destination: 'local_model', plan: async () => ({
      reasoning_summary: 'Fixture task plan', actions: [{ tool: 'tasks.create', arguments: { title: 'Run fixture task' } }],
    }) },
    policyEngine: new PolicyEngine({ policies: { tasks: { create: createPolicy } } }),
    toolRegistry: createToolRegistry(), eventBus,
  });
}

test('one-pass run and action identity survive restart without replaying a completed effect', async () => {
  const dir = tempHome();
  try {
    const result = await fixtureAgent().handleMessage({ text: 'Create a task' });
    assert.equal(result.actions[0].status, 'executed');
    assert.equal(getRun(result.runId).steps[0].actionId, result.actions[0].id);
    assert.equal(getRun(result.runId).status, 'completed');
    assert.equal(getRun(result.runId).objectiveStatus, 'unverified');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Run fixture task'").get().n, 1);
    closeAllForTests();
    getDb(); reconcileInterruptedRuns();
    assert.equal(getRun(result.runId).steps[0].status, 'executed');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Run fixture task'").get().n, 1);
  } finally { cleanup(dir); }
});

test('pending approval is a durable run blocker and read reconciles the approved action outcome', async () => {
  const dir = tempHome();
  try {
    const agent = fixtureAgent('confirm');
    const result = await agent.handleMessage({ text: 'Create a task' });
    assert.deepEqual(result.pendingActionIds, [result.actions[0].id]);
    assert.equal(getRun(result.runId).status, 'waiting_for_approval');
    closeAllForTests(); getDb(); reconcileInterruptedRuns();
    assert.equal(getRun(result.runId).status, 'waiting_for_approval');
    const restartedAgent = fixtureAgent('confirm');
    const approved = await restartedAgent.approveAction(result.actions[0].id, 'owner');
    assert.equal(approved.status, 'executed');
    assert.equal(getRun(result.runId).status, 'completed');
    assert.equal(getDb().prepare('SELECT status FROM agent_run_steps WHERE run_id = ?').get(result.runId).status, 'executed');
    assert.equal(getRun(result.runId).objectiveStatus, 'unverified');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Run fixture task'").get().n, 1);
  } finally { cleanup(dir); }
});

test('planning failure persists a failed run and creates no action', async () => {
  const dir = tempHome();
  try {
    const agent = fixtureAgent();
    agent.planner.plan = async () => { throw new Error('fixture model unavailable'); };
    await assert.rejects(agent.handleMessage({ text: 'Create a task' }), /model unavailable/);
    const [run] = listRuns();
    assert.equal(run.status, 'failed');
    assert.equal(run.objectiveStatus, 'unverified');
    assert.deepEqual(run.steps, []);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 0);
  } finally { cleanup(dir); }
});

test('an expired external attempt is reported as outcome uncertain without replay', async () => {
  const dir = tempHome();
  try {
    const result = await fixtureAgent('confirm').handleMessage({ text: 'Create a task' });
    const actionId = result.actions[0].id;
    const queue = enqueueAction({ actionId, correlationId: result.correlationId, tool: 'tasks.create', arguments: { title: 'Run fixture task' } });
    const db = getDb();
    db.prepare("UPDATE action_queue SET status = 'failed', error_class = 'owner_attention_required' WHERE id = ?").run(queue.id);
    db.prepare(`INSERT INTO action_attempts (id, queue_id, attempt_number, lease_owner, status, started_at, finished_at, error, error_class)
      VALUES ('attempt_fixture', ?, 1, 'expired-worker', 'failed', ?, ?, 'lease expired', 'retryable')`)
      .run(queue.id, new Date().toISOString(), new Date().toISOString());
    closeAllForTests(); getDb(); reconcileInterruptedRuns();
    assert.equal(getRun(result.runId).steps[0].status, 'outcome_uncertain');
    assert.equal(getRun(result.runId).status, 'needs_attention');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  } finally { cleanup(dir); }
});

test('restart marks an unlinked step interrupted rather than attempting it', () => {
  const dir = tempHome();
  try {
    const runId = createRun({ correlationId: 'corr_fixture', actorId: 'owner', objective: 'Do something' });
    recordRunPlan(runId, { reasoning_summary: 'Fixture', actions: [{ tool: 'tasks.create', arguments: { title: 'Never attempted' } }] });
    beginRunStep(runId, 0);
    closeAllForTests(); getDb(); reconcileInterruptedRuns();
    assert.equal(getRun(runId).status, 'interrupted');
    assert.equal(getRun(runId).steps[0].status, 'interrupted');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  } finally { cleanup(dir); }
});

test('additive run schema opens a pre-run data directory without changing existing records', () => {
  const dir = tempHome();
  try {
    const db = getDb();
    db.prepare(`INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('task_legacy', 'Real existing task', 'open', ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
    db.exec('DROP TABLE agent_run_steps; DROP TABLE agent_runs;');
    closeAllForTests();
    const reopened = getDb();
    assert.equal(reopened.prepare("SELECT title FROM tasks WHERE id = 'task_legacy'").get().title, 'Real existing task');
    assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get());
    assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_steps'").get());
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 0);
  } finally { cleanup(dir); }
});

test('run status API is owner-only and returns metadata without objectives or payloads', async () => {
  const dir = tempHome(); let server;
  try {
    const handle = await startServer({ port: 0 }); server = handle.server;
    const runId = createRun({ correlationId: 'corr_secret', actorId: 'owner', objective: 'secret objective' });
    recordRunPlan(runId, { reasoning_summary: 'private reasoning', actions: [{ tool: 'tasks.create', arguments: { title: 'secret payload' } }] });
    const url = `http://127.0.0.1:${handle.port}/api/agent/runs/${runId}`;
    assert.equal((await fetch(url)).status, 401);
    const setup = await fetch(`http://127.0.0.1:${handle.port}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'test-only owner passphrase' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const response = await fetch(url, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(JSON.parse(body).steps[0].status, 'planned');
    assert.doesNotMatch(body, /secret objective|secret payload|private reasoning/);
    assert.equal((await fetch(`${url}_missing`, { headers: { cookie } })).status, 404);
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); cleanup(dir); }
});
