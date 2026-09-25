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
import { createRun, recordRunPlan, beginModelCall, beginRunStep, getRun, listRuns, reconcileInterruptedRuns } from '../server/agent/run-store.js';
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

test('later plan rounds append steps, retain absolute dependencies, and migrate model-call count', () => {
  const dir = tempHome();
  try {
    const runId = createRun({ correlationId: 'corr_rounds', actorId: 'owner', objective: 'Research then draft' });
    const first = { reasoning_summary: 'Search', actions: [{ tool: 'email.search', arguments: { query: 'role' } }] };
    const second = { reasoning_summary: 'Check then draft', actions: [
      { tool: 'calendar.list', arguments: {} },
      { tool: 'email.draft', arguments: { to: 'a@example.test', subject: 'Re', body: 'Hi' }, dependsOn: [0] },
    ] };
    beginModelCall(runId);
    assert.equal(recordRunPlan(runId, first), 0);
    beginModelCall(runId);
    assert.equal(recordRunPlan(runId, second), 1);
    assert.deepEqual(getDb().prepare('SELECT step_index, depends_on FROM agent_run_steps WHERE run_id = ? ORDER BY step_index').all(runId).map((row) => [row.step_index, JSON.parse(row.depends_on)]), [[0, []], [1, []], [2, [1]]]);
    assert.equal(getRun(runId).modelCalls, 2);
    closeAllForTests();
    const db = getDb();
    db.exec('ALTER TABLE agent_runs DROP COLUMN model_call_count');
    db.exec('ALTER TABLE agent_runs DROP COLUMN voice_confidence');
    db.exec('ALTER TABLE agent_runs DROP COLUMN continuation_after_step');
    db.exec('ALTER TABLE agent_runs DROP COLUMN continuation_claimed');
    db.exec('ALTER TABLE agent_runs DROP COLUMN cancel_requested_at');
    db.exec('ALTER TABLE agent_runs DROP COLUMN cancelled_by');
    db.exec('ALTER TABLE agent_runs DROP COLUMN step_limit');
    db.exec('ALTER TABLE agent_runs DROP COLUMN step_count');
    db.exec('ALTER TABLE agent_runs DROP COLUMN elapsed_limit_ms');
    db.exec('ALTER TABLE agent_runs DROP COLUMN deadline_at');
    db.exec('ALTER TABLE agent_runs DROP COLUMN budget_stop_reason');
    db.exec('ALTER TABLE agent_runs DROP COLUMN token_limit');
    db.exec('ALTER TABLE agent_runs DROP COLUMN input_tokens');
    db.exec('ALTER TABLE agent_runs DROP COLUMN output_tokens');
    db.exec('ALTER TABLE agent_runs DROP COLUMN metered_model_calls');
    db.exec('ALTER TABLE agent_run_steps DROP COLUMN context_provenance');
    db.exec('ALTER TABLE agent_run_steps DROP COLUMN account_context');
    db.exec('ALTER TABLE agent_run_steps DROP COLUMN model_id');
    closeAllForTests();
    assert.equal(getDb().prepare('SELECT model_call_count FROM agent_runs WHERE id = ?').get(runId).model_call_count, 0);
    assert.equal(getDb().prepare('SELECT voice_confidence FROM agent_runs WHERE id = ?').get(runId).voice_confidence, null);
    assert.equal(getDb().prepare('SELECT continuation_after_step, continuation_claimed FROM agent_runs WHERE id = ?').get(runId).continuation_claimed, 0);
    assert.equal(getDb().prepare('SELECT cancel_requested_at, cancelled_by FROM agent_runs WHERE id = ?').get(runId).cancel_requested_at, null);
    const budget = getDb().prepare('SELECT step_limit, step_count, elapsed_limit_ms, deadline_at FROM agent_runs WHERE id = ?').get(runId);
    assert.equal(budget.step_limit, 16);
    assert.equal(budget.step_count, 0);
    assert.equal(budget.elapsed_limit_ms, 86_400_000);
    assert.ok(Number.isFinite(Date.parse(budget.deadline_at)));
    assert.deepEqual(getRun(runId).budget.tokens, { input: 0, output: 0, total: 0, limit: 20_000, meteredCalls: 0, complete: true });
    closeAllForTests(); getDb();
    assert.equal(getRun(runId).budget.tokens.limit, 20_000, 'reopening does not reset migrated token budget');
    assert.equal(getDb().prepare('SELECT context_provenance FROM agent_run_steps WHERE run_id = ? LIMIT 1').get(runId).context_provenance, null);
    assert.equal(getDb().prepare('SELECT account_context FROM agent_run_steps WHERE run_id = ? LIMIT 1').get(runId).account_context, null);
    assert.equal(getDb().prepare('SELECT model_id FROM agent_run_steps WHERE run_id = ? LIMIT 1').get(runId).model_id, null);
  } finally { cleanup(dir); }
});

test('old run budget migration counts previously linked actions without resetting records', async () => {
  const dir = tempHome();
  try {
    const result = await fixtureAgent().handleMessage({ text: 'Create a task' });
    assert.equal(getRun(result.runId).budget.stepsUsed, 1);
    closeAllForTests();
    const db = getDb();
    db.exec('ALTER TABLE agent_runs DROP COLUMN step_count');
    db.exec('ALTER TABLE agent_runs DROP COLUMN deadline_at');
    closeAllForTests();
    const reopened = getDb();
    assert.equal(reopened.prepare('SELECT step_count FROM agent_runs WHERE id = ?').get(result.runId).step_count, 1);
    assert.ok(Number.isFinite(Date.parse(reopened.prepare('SELECT deadline_at FROM agent_runs WHERE id = ?').get(result.runId).deadline_at)));
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Run fixture task'").get().n, 1);
    const deadline = reopened.prepare('SELECT deadline_at FROM agent_runs WHERE id = ?').get(result.runId).deadline_at;
    closeAllForTests();
    assert.equal(getDb().prepare('SELECT step_count, deadline_at FROM agent_runs WHERE id = ?').get(result.runId).step_count, 1);
    assert.equal(getDb().prepare('SELECT deadline_at FROM agent_runs WHERE id = ?').get(result.runId).deadline_at, deadline);
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
    assert.equal((await fetch(`${url}/resume`, { method: 'POST' })).status, 401);
    const setup = await fetch(`http://127.0.0.1:${handle.port}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'test-only owner passphrase' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const csrfToken = (await setup.json()).csrfToken;
    const response = await fetch(url, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(JSON.parse(body).steps[0].status, 'planned');
    assert.doesNotMatch(body, /secret objective|secret payload|private reasoning/);
    assert.equal((await fetch(`${url}/result`)).status, 401);
    const result = await fetch(`${url}/result`, { headers: { cookie } });
    assert.equal(result.status, 200);
    assert.doesNotMatch(await result.text(), /secret objective|secret payload|private reasoning/);
    const resumed = await fetch(`${url}/resume`, { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${handle.port}`, 'x-u2os-csrf': csrfToken } });
    assert.equal(resumed.status, 200);
    assert.doesNotMatch(await resumed.text(), /secret objective|secret payload|private reasoning/);
    assert.equal((await fetch(`${url}/cancel`, { method: 'POST' })).status, 401);
    const cancelHeaders = { cookie, origin: `http://127.0.0.1:${handle.port}`, 'x-u2os-csrf': csrfToken };
    const cancelled = await fetch(`${url}/cancel`, { method: 'POST', headers: cancelHeaders });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).status, 'cancelled');
    assert.equal((await (await fetch(`${url}/cancel`, { method: 'POST', headers: cancelHeaders })).json()).status, 'cancelled');
    assert.equal((await fetch(`${url}_missing`, { headers: { cookie } })).status, 404);
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); cleanup(dir); }
});
