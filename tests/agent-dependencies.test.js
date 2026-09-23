import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../server/agent/agent.js';
import { validatePlan } from '../server/agent/plan-validator.js';
import { createToolRegistry } from '../server/tools/register-all.js';

const registry = createToolRegistry();

function makeAgent(statuses, actions) {
  const calls = [];
  const agent = new Agent({ modelProvider: { id: 'fixture' }, toolRegistry: registry, eventBus: { publish() {} } });
  agent.contextAssembler.assemble = async () => ({});
  agent.planner.plan = async () => validatePlan({
    reasoning_summary: 'Fixture plan',
    response: 'All work completed.',
    actions: actions.map((dependsOn, index) => ({ tool: 'tasks.create', arguments: { title: `Task ${index}` }, ...(dependsOn ? { dependsOn } : {}) })),
  }, registry);
  agent.evaluateAndMaybeExecute = async ({ arguments: args }) => {
    const index = Number(args.title.split(' ')[1]);
    calls.push(index);
    return { id: `act_${index}`, tool: 'tasks.create', status: statuses[index], arguments: args };
  };
  return { agent, calls };
}

test('successful prerequisite permits dependent action while preserving plan order', async () => {
  const { agent, calls } = makeAgent(['executed', 'executed'], [null, [0]]);
  const result = await agent.handleMessage({ text: 'Do two things' });
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(result.actions.map((action) => action.status), ['executed', 'executed']);
  assert.equal(result.response, 'All work completed.');
});

for (const status of ['pending', 'blocked', 'rejected', 'failed', 'retrying', 'uncertain']) {
  test(`${status} prerequisite prevents dependent attempt and does not claim completion`, async () => {
    const { agent, calls } = makeAgent([status, 'executed', 'executed'], [null, [0], null]);
    const result = await agent.handleMessage({ text: 'Do three things' });
    assert.deepEqual(calls, [0, 2]);
    assert.deepEqual(result.actions.map((action) => action.status), [status, 'skipped', 'executed']);
    assert.deepEqual(result.actions[1].unmetDependencies, [{ index: 0, status, actionId: 'act_0' }]);
    assert.match(result.response, /not attempted/);
    assert.doesNotMatch(result.response, /All work completed/);
    assert.deepEqual(result.pendingActionIds, status === 'pending' ? ['act_0'] : []);
  });
}

test('transitive dependencies remain skipped without auditing or enqueueing the skipped proposals', async () => {
  const { agent, calls } = makeAgent(['failed', 'executed', 'executed'], [null, [0], [1]]);
  const result = await agent.handleMessage({ text: 'Do three dependent things' });
  assert.deepEqual(calls, [0]);
  assert.deepEqual(result.actions.map((action) => action.status), ['failed', 'skipped', 'skipped']);
  assert.deepEqual(result.actions[2].unmetDependencies, [{ index: 1, status: 'skipped', actionId: null }]);
});
