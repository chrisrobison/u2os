import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { DataProcessingPolicy } from '../server/policy/data-processing-policy.js';
import { createToolRegistry } from '../server/tools/register-all.js';
import { MockModelProvider } from '../server/agent/mock-model-provider.js';
import { Agent } from '../server/agent/agent.js';
import { explainAction } from '../server/agent/explain.js';
import { runSeed } from '../server/seed/seed.js';
import { acceptMemoryCandidate, listMemoryCandidates } from '../server/memory/candidate-store.js';
import { findEntities } from '../server/memory/entity-store.js';
import { assertDemoHomeAvailable, parseDemoArgs } from '../server/seed/demo.js';

function buildAgent() {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  return {
    db,
    agent: new Agent({
      modelProvider: new MockModelProvider(),
      policyEngine: new PolicyEngine(),
      dataProcessingPolicy: new DataProcessingPolicy(),
      toolRegistry: createToolRegistry(),
      eventBus,
      ownerEntityId,
    }),
  };
}

test('daily-driver demo completes approval and memory flow, then recalls accepted memory after a real database restart', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-daily-demo-'));
  process.env.U2OS_HOME = home;
  try {
    const dayOne = buildAgent();
    const briefing = await dayOne.agent.handleMessage({
      text: "What's going on today? Handle anything routine that doesn't need me and tell me what I need to pay attention to.",
      actorId: 'owner',
    });

    const automatic = briefing.actions.find((action) => action.tool === 'notifications.send');
    const consequential = briefing.actions.find((action) => action.tool === 'email.send');
    assert.equal(automatic.status, 'executed');
    assert.equal(consequential.status, 'pending');
    const why = explainAction(consequential.id);
    assert.match(why.reasoningSummary, /needs a reply/);
    assert.match(why.policyRule, /confirm/);
    assert.ok(why.contextProvenance.some((ref) => ref.type === 'event'));

    const approved = await dayOne.agent.approveAction(consequential.id, 'owner');
    assert.equal(approved.status, 'executed');
    assert.equal(dayOne.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'email.sent' AND correlation_id = ?").get(briefing.correlationId).n, 1);

    const [candidate] = listMemoryCandidates({ status: 'pending' });
    const [jamie] = findEntities({ type: 'Person', query: 'Jamie Alvarez' });
    const accepted = acceptMemoryCandidate(candidate.id, {
      entityId: jamie.id,
      key: 'follow_up_request',
      resolvedBy: 'owner',
    });
    assert.equal(accepted.candidate.status, 'accepted');

    closeAllForTests();
    const dayTwo = buildAgent();
    const recalled = await dayTwo.agent.handleMessage({ text: 'What do you remember about Jamie?', actorId: 'owner' });
    assert.equal(recalled.actions.length, 0);
    assert.match(recalled.response, /wants to schedule a follow-up conversation this week/);
    assert.equal(dayTwo.db.prepare('SELECT status FROM memory_candidates WHERE id = ?').get(candidate.id).status, 'accepted');
  } finally {
    closeAllForTests();
    delete process.env.U2OS_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('demo launcher uses a dedicated home and never overwrites it implicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-demo-cli-'));
  try {
    const home = path.join(root, 'chosen-demo');
    const options = parseDemoArgs(['--home', home, '--port', '0']);
    assert.equal(options.home, home);
    assert.equal(options.port, 0);
    assertDemoHomeAvailable(home);
    fs.mkdirSync(path.join(home, 'db'), { recursive: true });
    fs.writeFileSync(path.join(home, 'db', 'u2os.sqlite'), 'existing owner data');
    assert.throws(() => assertDemoHomeAvailable(home), /will not erase/);
    assert.equal(assertDemoHomeAvailable(home, { reuse: true }), home);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
