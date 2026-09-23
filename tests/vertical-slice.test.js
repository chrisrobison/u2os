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
import { Agent } from '../server/agent/agent.js';
import { runSeed } from '../server/seed/seed.js';
import { ensureInstallationMode } from '../server/seed/installation-mode.js';
import { listEvents } from '../server/events/log.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-test-'));
  process.env.U2OS_HOME = dir;
  ensureInstallationMode('demo', dir);
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('vertical slice: "Move my 2 PM meeting with Sarah to tomorrow afternoon" -> pending approval -> approve -> reschedule', async () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const eventBus = new EventBus(db);
    initProjector(eventBus);

    // Seeds real demo data, including the same policies.yaml the real
    // server writes on first run -- exercises the real approval boundary,
    // not a hand-picked test policy.
    const ownerEntityId = runSeed({ eventBus });

    const policyEngine = new PolicyEngine();
    const toolRegistry = createToolRegistry();
    const modelProvider = new MockModelProvider();
    const agent = new Agent({ modelProvider, policyEngine, toolRegistry, eventBus, ownerEntityId });

    const result = await agent.handleMessage({
      text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.',
      actorId: 'user',
    });

    assert.equal(result.actions.length, 1);
    const proposed = result.actions[0];
    assert.equal(proposed.status, 'pending');
    assert.equal(proposed.tool, 'calendar.reschedule');
    assert.ok(proposed.arguments.eventId);

    // agent_actions row exists with status=pending, requires_approval=1.
    const pendingRow = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(proposed.id);
    assert.ok(pendingRow);
    assert.equal(pendingRow.status, 'pending');
    assert.equal(pendingRow.requires_approval, 1);
    assert.equal(pendingRow.tool, 'calendar.reschedule');
    assert.equal(pendingRow.correlation_id, result.correlationId);

    const eventId = proposed.arguments.eventId;
    const before = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
    assert.equal(before.title, 'Sync with Sarah');

    // Approve.
    const approval = await agent.approveAction(proposed.id, 'user');
    assert.equal(approval.status, 'executed');

    // calendar_events row now has the new start/end time.
    const after = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);
    assert.notEqual(after.start_at, before.start_at);
    assert.notEqual(after.end_at, before.end_at);

    // A calendar.event_changed event exists with the right correlationId.
    const changedEvents = listEvents(db, { type: 'calendar.event_changed', correlationId: result.correlationId });
    assert.equal(changedEvents.length, 1);
    assert.equal(changedEvents[0].correlationId, result.correlationId);
    assert.equal(changedEvents[0].data.after.start_at, after.start_at);

    // The whole chain shares one correlationId end to end.
    const approvedRow = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(proposed.id);
    assert.equal(approvedRow.status, 'executed');
    assert.equal(approvedRow.correlation_id, result.correlationId);

    const proposedEvents = listEvents(db, { type: 'agent.action.proposed', correlationId: result.correlationId });
    const approvedEvents = listEvents(db, { type: 'agent.action.approved', correlationId: result.correlationId });
    const completedEvents = listEvents(db, { type: 'agent.action.completed', correlationId: result.correlationId });
    assert.equal(proposedEvents.length, 1);
    assert.equal(approvedEvents.length, 1);
    assert.equal(completedEvents.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('daily-driver mock plan uses retrieved context and preserves policy, queue, and memory boundaries', async () => {
  const dir = tempHome();
  try {
    const db = getDb();
    const eventBus = new EventBus(db);
    initProjector(eventBus);
    const ownerEntityId = runSeed({ eventBus });
    const agent = new Agent({
      modelProvider: new MockModelProvider(),
      policyEngine: new PolicyEngine(),
      toolRegistry: createToolRegistry(),
      eventBus,
      ownerEntityId,
    });

    const result = await agent.handleMessage({
      text: "What's going on today? Handle anything routine that doesn't need me and tell me what I need to pay attention to.",
      actorId: 'user',
    });

    assert.match(result.response, /northwindtalent\.example/);
    assert.equal(result.actions.length, 2);
    assert.equal(result.actions[0].tool, 'notifications.send');
    assert.equal(result.actions[0].status, 'executed');
    assert.equal(result.actions[1].tool, 'email.send');
    assert.equal(result.actions[1].status, 'pending');
    assert.equal(result.actions[1].arguments.to, 'jamie.alvarez@northwindtalent.example');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'notification.sent'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'email.sent'").get().n, 0, 'no new email is sent before approval');

    const candidate = db.prepare("SELECT * FROM memory_candidates WHERE status = 'pending' AND correlation_id = ?").get(result.correlationId);
    assert.ok(candidate);
    assert.match(candidate.content, /northwindtalent\.example/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.memory_candidate.proposed' AND correlation_id = ?").get(result.correlationId).n, 1);
  } finally {
    cleanup(dir);
  }
});
