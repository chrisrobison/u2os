import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Planner } from '../server/agent/planner.js';
import { Agent } from '../server/agent/agent.js';
import { ToolRegistry } from '../server/tools/registry.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { DataProcessingPolicy } from '../server/policy/data-processing-policy.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { validatePlan } from '../server/agent/plan-validator.js';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const policy = new DataProcessingPolicy({ policies: {
  private: { local_models: 'allow', remote_models: 'never' }, sensitive: { local_models: 'allow', remote_models: 'never' },
} });

test('overlapping plans retain their exact destination/provider/provenance even with a reused provider object', async () => {
  const entered = deferred(); const release = deferred();
  const proposed = { reasoning_summary: 'fixture', actions: [] };
  const planner = new Planner({ dataProcessingPolicy: policy, modelProvider: {
    id: 'local-A', destination: 'local_model', plan: async () => { entered.resolve(); await release.promise; return proposed; },
  } });
  const context = (id) => ({ conversationHistory: [{ turnId: `turn_${id}`, role: 'user', content: `Private ${id}`, classification: 'private' }],
    priorReadArtifacts: [{ runId: `run_${id}`, actionId: `prior_${id}`, tool: 'email.read', status: 'executed', result: { id }, account: null }],
    observations: [{ stepIndex: 0, actionId: `action_${id}`, tool: 'email.read', status: 'executed', result: { id } }] });
  const first = planner.plan(context('A'), 'A');
  await entered.promise;
  planner.modelProvider.id = 'changed_after_call';
  planner.modelProvider = { id: 'remote-B', destination: 'configured_remote_model', plan: async () => proposed };
  const second = await planner.plan(context('B'), 'B');
  assert.equal(planner.getPlanContext(second).providerId, 'remote-B');
  assert.deepEqual(planner.getPlanContext(second).observations[0].items, []);
  assert.deepEqual(planner.getPlanContext(second).priorReadArtifacts, []);
  release.resolve();
  const firstPlan = await first;
  assert.notEqual(firstPlan, second);
  assert.equal(planner.getPlanContext(firstPlan).providerId, 'local-A');
  assert.equal(planner.getPlanContext(firstPlan).observations[0].items[0].data.id, 'A');
  assert.equal(planner.getPlanContext(firstPlan).priorReadArtifacts[0].actionId, 'prior_A');
  assert.deepEqual(planner.getPlanContext(firstPlan).provenanceRefs.map((ref) => ref.id), ['turn_A', 'prior_A']);
  assert.equal(planner.getPlanContext({ ...firstPlan }), undefined);
  assert.deepEqual(Object.keys(firstPlan), ['reasoning_summary', 'actions']);
});

async function overlap({ withheld = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-plan-context-'));
  process.env.U2OS_HOME = dir;
  const entered = deferred(); const release = deferred(); const effects = [];
  let first;
  try {
    const registry = new ToolRegistry();
    registry.register({ name: 'fixture.read', domain: 'fixture', category: 'read',
      schema: { properties: { label: { type: 'string' } }, required: ['label'] }, execute: async ({ label }) => ({ id: `artifact_${label}` }) });
    registry.register({ name: 'fixture.inspect', domain: 'fixture', category: 'read',
      schema: { properties: { id: { type: 'string' } }, required: ['id'] }, execute: async ({ id }) => { effects.push(id); return { id }; } });
    const local = { id: withheld ? 'remote-A' : 'local-A', destination: withheld ? 'configured_remote_model' : 'local_model', plan: async (context, objective) => {
      if (!context.observations.length) return { reasoning_summary: 'Read', continue: true, actions: [{ tool: 'fixture.read', arguments: { label: objective } }] };
      if (objective === 'A') { entered.resolve(); await release.promise; }
      return { reasoning_summary: 'Inspect', actions: [{ tool: 'fixture.inspect', arguments: { id: '' },
        resultRefs: { id: { stepIndex: 0, itemIndex: 0, path: 'id' } } }] };
    } };
    const agent = new Agent({ modelProvider: local, policyEngine: new PolicyEngine(), toolRegistry: registry,
      eventBus: new EventBus(getDb()), dataProcessingPolicy: policy });
    agent.contextAssembler.assemble = async ({ objective }) => ({ personalContext: {
      relevantFacts: [{ factId: `fact_${objective}`, classification: 'private', value: `Private ${objective}` }],
      provenanceRefs: [{ type: 'fact', id: `fact_${objective}` }],
    }, conversationHistory: [], objective });
    first = agent.handleMessage({ text: 'A', actorId: 'owner' });
    await entered.promise;
    agent.planner.modelProvider = { ...local, id: 'local-B', destination: 'local_model' };
    const second = await agent.handleMessage({ text: 'B', actorId: 'owner' });
    assert.equal(second.actions.at(-1).arguments.id, 'artifact_B');
    release.resolve();
    const result = await first;
    if (withheld) {
      assert.equal(result.actions.length, 1);
      assert.match(result.response, /cannot receive/);
      assert.deepEqual(effects, ['artifact_B']);
    } else {
      assert.equal(result.actions.at(-1).arguments.id, 'artifact_A');
      assert.deepEqual(effects, ['artifact_B', 'artifact_A']);
    }
    const audit = getDb().prepare("SELECT model, arguments, context_provenance FROM agent_actions WHERE tool = 'fixture.inspect'").all();
    assert.deepEqual(audit.map((row) => [row.model, JSON.parse(row.arguments).id]).sort(),
      withheld ? [['local-B', 'artifact_B']] : [['local-A', 'artifact_A'], ['local-B', 'artifact_B']]);
    for (const row of audit) assert.deepEqual(JSON.parse(row.context_provenance),
      [{ type: 'fact', id: `fact_${JSON.parse(row.arguments).id.at(-1)}` }]);
  } finally {
    release.resolve(); await first?.catch(() => {});
    closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('overlapping Agent continuations cannot substitute another run output or provenance', () => overlap());
test('a concurrent local call cannot make remote-withheld output a valid reference', () => overlap({ withheld: true }));

test('model-supplied context metadata is not runtime authority and remains an invalid plan field', async () => {
  const registry = new ToolRegistry();
  const planner = new Planner({ modelProvider: { id: 'fixture', plan: async () => ({ reasoning_summary: '', actions: [],
    runtimeContext: { observations: [{ id: 'invented' }], providerId: 'forged' } }) } });
  const plan = await planner.plan({}, 'fixture');
  assert.equal(planner.getPlanContext(plan).providerId, 'fixture');
  assert.deepEqual(planner.getPlanContext(plan).observations, []);
  assert.throws(() => validatePlan(plan, registry));
});
