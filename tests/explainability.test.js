// Explainability / provenance (PLAN.md Phase 9): agent_actions rows and
// explainAction() must let a later view answer "why did U2OS do this" --
// which model, which policy rule, which retrieved memory, which events --
// using concise references, never hidden chain-of-thought.
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
import { ModelProvider } from '../server/agent/model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { runSeed } from '../server/seed/seed.js';
import { explainAction } from '../server/agent/explain.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-explain-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

class ScriptedProvider extends ModelProvider {
  id = 'fake:scripted-provider';
  destination = 'local_model';
  async plan() {
    return { reasoning_summary: 'Reminding you about the recruiter follow-up.', actions: [{ tool: 'tasks.create', arguments: { title: 'Follow up with recruiter' } }] };
  }
}

function buildAgent() {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  const toolRegistry = createToolRegistry();
  const policyEngine = new PolicyEngine();
  const agent = new Agent({ modelProvider: new ScriptedProvider(), policyEngine, toolRegistry, eventBus, ownerEntityId });
  return { db, agent };
}

test('an agent_actions row records which retrieved-memory items (contextProvenance) actually informed the plan', async () => {
  const dir = tempHome();
  try {
    const { agent } = buildAgent();
    const result = await agent.handleMessage({ text: 'Anything I should know about today?', actorId: 'user' });

    const action = result.actions[0];
    const explanation = explainAction(action.id);
    assert.ok(explanation);
    // The seed recruiter email is a context-worthy recent event, so it
    // must appear as a provenance reference on this action's audit row.
    assert.ok(explanation.contextProvenance.some((ref) => ref.type === 'event'), 'contextProvenance must reference at least one retrieved event id');
  } finally {
    cleanup(dir);
  }
});

test('explainAction() returns a concise, referenceable explanation: model, policy rule, reasoning, arguments, and the full correlated event chain', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();
    const result = await agent.handleMessage({ text: 'Anything I should know about today?', actorId: 'user' });
    const action = result.actions[0];

    const explanation = explainAction(action.id);
    assert.equal(explanation.tool, 'tasks.create');
    assert.deepEqual(explanation.arguments, { title: 'Follow up with recruiter' });
    assert.equal(explanation.reasoningSummary, 'Reminding you about the recruiter follow-up.');
    assert.equal(explanation.model, 'fake:scripted-provider');
    assert.equal(explanation.policyDomain, 'tasks');
    assert.ok(explanation.policyRule);
    assert.equal(explanation.correlationId, result.correlationId);
    assert.equal(explanation.status, 'executed');

    const relatedTypes = explanation.relatedEvents.map((e) => e.type);
    assert.ok(relatedTypes.includes('agent.message.received'));
    assert.ok(relatedTypes.includes('task.created'));
    assert.ok(relatedTypes.includes('agent.action.completed'));
    // Oldest first -- tells the causal story in order.
    const receivedIdx = relatedTypes.indexOf('agent.message.received');
    const completedIdx = relatedTypes.indexOf('agent.action.completed');
    assert.ok(receivedIdx < completedIdx);

    void db;
  } finally {
    cleanup(dir);
  }
});

test('explainAction() returns null for an unknown action id, never throws', () => {
  const dir = tempHome();
  try {
    getDb();
    assert.equal(explainAction('act_does_not_exist'), null);
  } finally {
    cleanup(dir);
  }
});

test('an action proposed with no context (e.g. a direct evaluateAndMaybeExecute call, not from a model plan) has an empty contextProvenance, not an error', async () => {
  const dir = tempHome();
  try {
    const { agent } = buildAgent();
    const outcome = await agent.evaluateAndMaybeExecute({
      tool: 'tasks.create',
      arguments: { title: 'Direct call' },
      requestedBy: 'user',
      requestText: 'x',
      correlationId: 'corr_direct',
      actor: { type: 'user', id: 'user' },
    });
    const explanation = explainAction(outcome.id);
    assert.deepEqual(explanation.contextProvenance, []);
  } finally {
    cleanup(dir);
  }
});
