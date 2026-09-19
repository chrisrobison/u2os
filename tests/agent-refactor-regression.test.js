// Regression tests written BEFORE decomposing server/agent/agent.js into
// focused services (ContextAssembler/Planner/ActionEvaluator/ActionExecutor/
// ApprovalManager/EvaluatorRegistry -- see PLAN.md's Agent-refactor phase).
//
// These lock in black-box behavior of Agent's public API
// (handleMessage/evaluateAndMaybeExecute/approveAction/rejectAction/
// evaluateEvent) that tests/vertical-slice.test.js and
// tests/proactive-agent.test.js don't already exercise: the approve-time
// policy RE-EVALUATION path, and error handling for missing/non-pending
// actions. Every test here must keep passing, unchanged, after the
// extraction -- if it doesn't, the refactor changed observable behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { ModelProvider } from '../server/agent/model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { runSeed } from '../server/seed/seed.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-agent-regression-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function confirmTasksPolicy() {
  return {
    email: { read: 'always', draft: 'always', send: { friends: 'autonomous', business: 'confirm', legal: 'never' } },
    calendar: { create: 'autonomous', reschedule: { interviews: 'confirm', default: 'confirm' } },
    contacts: { search: 'always' },
    tasks: { create: 'confirm', complete: 'autonomous' },
    notifications: { send: 'autonomous' },
    payments: { under_50: 'confirm', over_50: 'never' },
  };
}

function buildAgent(policyEngine) {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  const toolRegistry = createToolRegistry();
  const modelProvider = new MockModelProvider();
  const agent = new Agent({ modelProvider, policyEngine, toolRegistry, eventBus, ownerEntityId });
  return { db, eventBus, agent };
}

test('approveAction RE-EVALUATES policy at approval time: a policy tightened to never after the action was proposed blocks it instead of executing', async () => {
  const dir = tempHome();
  try {
    const policyEngine = new PolicyEngine({ policies: confirmTasksPolicy() });
    const { db, agent } = buildAgent(policyEngine);

    const proposed = await agent.evaluateAndMaybeExecute({
      tool: 'tasks.create',
      arguments: { title: 'Call the vendor' },
      requestedBy: 'user',
      requestText: 'remind me to call the vendor',
      correlationId: 'corr_regress_1',
      actor: { type: 'user', id: 'user' },
    });
    assert.equal(proposed.status, 'pending');

    // Policy tightens between proposal and approval (e.g. an owner edit or
    // reload) -- this must be re-checked at approval time, not trusted from
    // the original (now-stale) evaluation.
    policyEngine.policies.tasks.create = 'never';

    const approved = await agent.approveAction(proposed.id, 'user');
    assert.equal(approved.status, 'blocked');

    const row = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(proposed.id);
    assert.equal(row.status, 'blocked');

    const tasksAfter = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE title = ?').get('Call the vendor');
    assert.equal(tasksAfter.n, 0, 'a never-policy-blocked action must not execute even though it was already approved by the user');
  } finally {
    cleanup(dir);
  }
});

test('approveAction throws for an unknown action id', async () => {
  const dir = tempHome();
  try {
    const { agent } = buildAgent(new PolicyEngine({ policies: confirmTasksPolicy() }));
    await assert.rejects(agent.approveAction('act_does_not_exist', 'user'), /No such action/);
  } finally {
    cleanup(dir);
  }
});

test('approveAction throws when the action is not pending (e.g. already executed)', async () => {
  const dir = tempHome();
  try {
    const { agent } = buildAgent(new PolicyEngine({ policies: confirmTasksPolicy() }));
    const proposed = await agent.evaluateAndMaybeExecute({
      tool: 'tasks.create',
      arguments: { title: 'Autonomous-ish task' },
      requestedBy: 'user',
      requestText: 'x',
      correlationId: 'corr_regress_2',
      actor: { type: 'user', id: 'user' },
    });
    await agent.approveAction(proposed.id, 'user');
    await assert.rejects(agent.approveAction(proposed.id, 'user'), /not pending/);
  } finally {
    cleanup(dir);
  }
});

test('rejectAction throws for an unknown action id, and for a non-pending action', async () => {
  const dir = tempHome();
  try {
    const { agent } = buildAgent(new PolicyEngine({ policies: confirmTasksPolicy() }));
    await assert.rejects(agent.rejectAction('act_does_not_exist', 'user'), /No such action/);

    const proposed = await agent.evaluateAndMaybeExecute({
      tool: 'tasks.create',
      arguments: { title: 'Another task' },
      requestedBy: 'user',
      requestText: 'x',
      correlationId: 'corr_regress_3',
      actor: { type: 'user', id: 'user' },
    });
    await agent.rejectAction(proposed.id, 'user');
    await assert.rejects(agent.rejectAction(proposed.id, 'user'), /not pending/);
  } finally {
    cleanup(dir);
  }
});

class MemoryCandidateProvider extends ModelProvider {
  id = 'fake:memory-candidate-provider';
  async plan() {
    return {
      reasoning_summary: 'Noted.',
      actions: [],
      memoryCandidates: [{ content: 'Sarah prefers morning meetings', confidence: 'medium' }],
    };
  }
}

test('a plan\'s memoryCandidates are recorded as agent.memory_candidate.proposed events, NEVER written directly as facts', async () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const eventBus = new EventBus(db);
    initProjector(eventBus);
    const ownerEntityId = runSeed({ eventBus });
    const toolRegistry = createToolRegistry();
    const agent = new Agent({
      modelProvider: new MemoryCandidateProvider(),
      policyEngine: new PolicyEngine({ policies: confirmTasksPolicy() }),
      toolRegistry,
      eventBus,
      ownerEntityId,
    });

    const result = await agent.handleMessage({ text: 'Remember that Sarah prefers morning meetings.', actorId: 'user' });
    assert.deepEqual(result.memoryCandidates, [{ content: 'Sarah prefers morning meetings', confidence: 'medium' }]);

    const proposedEvents = db.prepare("SELECT * FROM events WHERE type = 'agent.memory_candidate.proposed'").all();
    assert.equal(proposedEvents.length, 1);
    const data = JSON.parse(proposedEvents[0].data);
    assert.equal(data.content, 'Sarah prefers morning meetings');
    assert.equal(data.confidence, 'medium');

    // Proposing a memory candidate must NEVER, by itself, create an
    // established fact -- promotion is a separate, explicit step nothing
    // here performs.
    const facts = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE value LIKE '%morning meetings%'").get();
    assert.equal(facts.n, 0);
  } finally {
    cleanup(dir);
  }
});

test('a blocked (never-policy) action is audited but never executed, and is not left in a pending state', async () => {
  const dir = tempHome();
  try {
    const policies = confirmTasksPolicy();
    policies.tasks.create = 'never';
    const { db, agent } = buildAgent(new PolicyEngine({ policies }));

    const result = await agent.evaluateAndMaybeExecute({
      tool: 'tasks.create',
      arguments: { title: 'Should never exist' },
      requestedBy: 'user',
      requestText: 'x',
      correlationId: 'corr_regress_4',
      actor: { type: 'user', id: 'user' },
    });

    assert.equal(result.status, 'blocked');
    const row = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(result.id);
    assert.equal(row.status, 'blocked');
    assert.equal(row.requires_approval, 1);
    const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE title = ?').get('Should never exist');
    assert.equal(tasks.n, 0);
  } finally {
    cleanup(dir);
  }
});
