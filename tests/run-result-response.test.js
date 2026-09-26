import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { PolicyEngine, updateAgentAction } from '../server/policy/policy-engine.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { Agent } from '../server/agent/agent.js';
import { getRunResult, reconcileInterruptedRuns, createRun, finishRun, markBudgetExhausted } from '../server/agent/run-store.js';
import { enqueueAction } from '../server/agent/action-queue-store.js';
import { summarizeIncompleteActions, isActionSummaryResponse } from '../server/agent/action-result-summary.js';

const PRIVATE = 'fixture-private-error-result-token';
async function withHome(operation) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-run-response-')), previousHome = process.env.U2OS_HOME;
  process.env.U2OS_HOME = home;
  try { await operation(); }
  finally { closeAllForTests(); if (previousHome === undefined) delete process.env.U2OS_HOME; else process.env.U2OS_HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }); }
}
function fixture({ failure, autonomous = false, noActions = false } = {}) {
  const calls = [], modelCalls = [], registry = new ToolRegistry();
  for (const name of ['prepare', 'finish']) registry.register({
    name: `fixture.${name}`, domain: 'fixture', category: 'consequential', schema: { properties: {}, required: [] },
    execute: async () => {
      calls.push(name);
      if (name === 'prepare' && failure) throw Object.assign(new Error(PRIVATE), { actionErrorClass: failure });
      return { evidence: `observed ${name}`, private: PRIVATE };
    },
  });
  const agent = new Agent({ modelProvider: { id: 'fixture', destination: 'local_model', plan: async () => {
    modelCalls.push('plan'); return { reasoning_summary: 'Fixture run', response: 'Grounded final fixture response.', actions: noActions ? [] : [
      { tool: 'fixture.prepare', arguments: {} }, { tool: 'fixture.finish', arguments: {}, dependsOn: [0] },
    ] };
  } }, policyEngine: new PolicyEngine({ policies: { fixture: { prepare: autonomous ? 'autonomous' : 'confirm', finish: 'autonomous' } } }),
  toolRegistry: registry, eventBus: new EventBus(getDb()) });
  agent.contextAssembler.assemble = async () => ({ toolRegistry: registry }); return { agent, calls, modelCalls };
}

test('deterministic summary separates queued, approval, not-attempted and uncertain work without private result/error text', () => {
  const steps = ['executed', 'pending', 'waiting_for_action', 'waiting_dependency', 'outcome_uncertain', 'needs_attention'].map((status) => ({ status, result: PRIVATE, error: PRIVATE }));
  const summary = summarizeIncompleteActions(steps);
  assert.match(summary, /1 action\(s\) completed; 1 awaiting approval; 1 queued or running; 1 not attempted; 2 failed or needing attention/);
  assert.match(summary, /1 action\(s\): outcome uncertain.*originally bound account\/provider.*no automatic retry/);
  assert.match(summary, /objective is not verified/); assert.doesNotMatch(summary, /fixture-private/);
  assert.equal(summarizeIncompleteActions([{ status: 'executed' }]), null);
});

test('runtime count signature recognizes old prefixed summaries but not ordinary grounded responses', () => {
  assert.equal(isActionSummaryResponse('Continuation paused. 2 action(s) completed; 1 awaiting approval; 1 not attempted.'), true);
  assert.equal(isActionSummaryResponse('Grounded observed response.'), false); assert.equal(isActionSummaryResponse(null), false);
});

for (const failure of ['outcome_uncertain', 'non_retryable']) {
  test(`approved ${failure} run result replaces stale approval counts across restart without extra work`, () => withHome(async () => {
    const f = fixture({ failure }), result = await f.agent.handleMessage({ text: 'Prepare and finish', actorId: 'owner' });
    assert.match(getRunResult(result.runId).response, /1 awaiting approval/);
    await f.agent.approveAction(result.actions[0].id, 'owner');
    const current = getRunResult(result.runId); assert.match(current.response, /0 awaiting approval/); assert.match(current.response, /1 failed or needing attention/);
    if (failure === 'outcome_uncertain') assert.match(current.response, /outcome uncertain.*no automatic retry/);
    else assert.doesNotMatch(current.response, /outcome uncertain/);
    assert.doesNotMatch(current.response, /fixture-private/); assert.equal(current.objectiveStatus, 'unverified');
    const stored = getDb().prepare('SELECT response FROM agent_runs WHERE id=?').get(result.runId).response;
    assert.match(stored, /1 awaiting approval/, 'legacy stored response is preserved, not rewritten or used as current truth');
    for (let read = 0; read < 3; read++) assert.equal(getRunResult(result.runId).response, current.response);
    closeAllForTests(); getDb(); reconcileInterruptedRuns();
    assert.equal(getRunResult(result.runId).response, current.response);
    assert.equal(getDb().prepare('SELECT response FROM agent_runs WHERE id=?').get(result.runId).response, stored);
    assert.deepEqual(f.calls, ['prepare']); assert.equal(f.modelCalls.length, 1);
  }));
}

test('rejection result describes not-attempted dependents instead of stale pending approval', () => withHome(async () => {
  const f = fixture(), result = await f.agent.handleMessage({ text: 'Prepare and finish', actorId: 'owner' });
  await f.agent.rejectAction(result.actions[0].id, 'owner'); const current = getRunResult(result.runId);
  assert.equal(current.status, 'failed'); assert.match(current.response, /0 awaiting approval; 0 queued or running; 2 not attempted; 0 failed or needing attention/);
  assert.deepEqual(f.calls, []); assert.equal(f.modelCalls.length, 1);
}));

test('queued approval explains waiting action then delayed completion without retaining obsolete pending counts', () => withHome(async () => {
  const f = fixture(), result = await f.agent.handleMessage({ text: 'Prepare and finish', actorId: 'owner' });
  const actionId = result.actions[0].id; updateAgentAction(actionId, { status: 'approved', approvedBy: 'owner', approvedAt: new Date().toISOString() });
  enqueueAction({ actionId, tool: 'fixture.prepare', arguments: {}, correlationId: result.correlationId });
  const queued = getRunResult(result.runId); assert.match(queued.response, /0 awaiting approval; 1 queued or running/); assert.match(queued.response, /0 failed or needing attention/);
  await f.agent.actionQueueWorker.processNext(); await f.agent.resumeRunDependents(result.runId);
  const completed = getRunResult(result.runId); assert.equal(completed.status, 'completed');
  assert.match(completed.response, /2 action\(s\) completed; 0 awaiting approval; 0 queued or running; 0 not attempted/);
  assert.equal(completed.objectiveStatus, 'unverified'); assert.deepEqual(f.calls, ['prepare', 'finish']); assert.equal(f.modelCalls.length, 1);
}));

test('grounded confirmed final and actionless clarification responses remain intact without a new model call', () => withHome(async () => {
  const f = fixture({ autonomous: true }), result = await f.agent.handleMessage({ text: 'Prepare and finish', actorId: 'owner' });
  assert.equal(getRunResult(result.runId).response, 'Grounded final fixture response.'); assert.equal(getRunResult(result.runId).status, 'completed');
  assert.deepEqual(f.calls, ['prepare', 'finish']); assert.equal(f.modelCalls.length, 1);
  const clarification = createRun({ correlationId: 'fixture-question', actorId: 'owner', objective: 'An ambiguous instruction' });
  finishRun(clarification, 'Which of the two fixture choices did you mean?');
  assert.equal(getRunResult(clarification).response, 'Which of the two fixture choices did you mean?');
}));

test('current counts preserve budget stop explanation rather than stale proposal-time failure counts', () => withHome(async () => {
  const f = fixture(), result = await f.agent.handleMessage({ text: 'Prepare and finish', actorId: 'owner' });
  markBudgetExhausted(result.runId, 'elapsed_limit'); const current = getRunResult(result.runId);
  assert.match(current.response, /^Run budget exhausted\./); assert.match(current.response, /objective is not verified/); assert.equal(current.budget.stopReason, 'elapsed_limit');
  assert.deepEqual(f.calls, []); assert.equal(f.modelCalls.length, 1);
  const empty = createRun({ correlationId: 'fixture-budget-empty', actorId: 'owner', objective: 'No actions' }); markBudgetExhausted(empty, 'step_limit');
  assert.match(getRunResult(empty).response, /Run budget exhausted/);
}));

test('cancellation explains current not-attempted work without suggesting remaining approval', () => withHome(async () => {
  const f = fixture(), result = await f.agent.handleMessage({ text: 'Prepare and finish', actorId: 'owner' });
  await f.agent.cancelRun(result.runId, 'owner'); const current = getRunResult(result.runId);
  assert.match(current.response, /^Run cancellation requested\./); assert.match(current.response, /0 awaiting approval/);
  assert.equal(current.cancellationRequested, true); assert.deepEqual(f.calls, []);
}));
