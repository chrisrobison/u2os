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
import { createEntity } from '../server/memory/entity-store.js';
import * as tasksProvider from '../server/integrations/mock-tasks-provider.js';
import * as calendarProvider from '../server/integrations/mock-calendar-provider.js';
import { listRecommendations } from '../server/agent/recommendation-store.js';
import { explainRecommendation } from '../server/agent/explain-recommendation.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-proactive-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildAgent({ policyEngine } = {}) {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  const ownerEntityId = runSeed({ eventBus });
  const toolRegistry = createToolRegistry();
  const modelProvider = new MockModelProvider();
  const agent = new Agent({
    modelProvider,
    policyEngine: policyEngine || new PolicyEngine(),
    toolRegistry,
    eventBus,
    ownerEntityId,
  });
  return { db, eventBus, agent, ownerEntityId };
}

// The exact seed policy shape (server/policy/policies-loader.js's
// DEFAULT_POLICIES_YAML), but with tasks.create forced to `never` --
// used ONLY by the "cannot bypass policy" test below. Constructing a custom
// PolicyEngine is the test's way of making a normally-autonomous tool
// policy-blocked, WITHOUT touching policy-engine.js or letting the event's
// own data/arguments influence the policy outcome.
function neverCreateTasksPolicy() {
  return {
    email: { read: 'always', draft: 'always', send: { friends: 'autonomous', business: 'confirm', legal: 'never' } },
    calendar: { create: 'autonomous', reschedule: { interviews: 'confirm', default: 'confirm' } },
    contacts: { search: 'always' },
    tasks: { create: 'never', complete: 'autonomous' },
    notifications: { send: 'autonomous' },
    payments: { under_50: 'confirm', over_50: 'never' },
  };
}

test('email.received from a recruiter/talent sender -> decision "notify", policy-gated notification sent', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();

    const result = await agent.evaluateEvent({
      type: 'email.received',
      data: { from: 'jamie.alvarez@northwindtalent.example', subject: 'Following up' },
      subject: { type: 'email', id: 'em_test' },
    });

    assert.equal(result.decision, 'notify');
    assert.equal(result.outcome.status, 'executed');
    assert.equal(result.outcome.tool, 'notifications.send');

    const sent = db.prepare("SELECT * FROM events WHERE type = 'notification.sent'").all();
    assert.equal(sent.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('email.received from a non-recruiter sender -> decision "ignore", no side effect', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();

    const result = await agent.evaluateEvent({
      type: 'email.received',
      data: { from: 'newsletter@example.com', subject: 'This week in tech' },
      subject: { type: 'email', id: 'em_test2' },
    });

    assert.equal(result.decision, 'ignore');
    const sent = db.prepare("SELECT * FROM events WHERE type = 'notification.sent'").all();
    assert.equal(sent.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('calendar.event_approaching -> decision "prepare", generates a before-meeting dashboard attached to a dismissible recommendation', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();

    const syncWithSarah = db.prepare("SELECT * FROM calendar_events WHERE title = 'Sync with Sarah'").get();
    assert.ok(syncWithSarah, 'seed data must include the "Sync with Sarah" event');

    const result = await agent.evaluateEvent({
      type: 'calendar.event_approaching',
      data: { eventId: syncWithSarah.id, minutesUntil: 45 },
      subject: { type: 'calendar_event', id: syncWithSarah.id },
    });

    assert.equal(result.decision, 'prepare');
    assert.ok(result.recommendation);
    assert.equal(result.recommendation.decision, 'prepare');
    assert.ok(result.recommendation.dashboard, 'the recommendation must carry a generated before-meeting dashboard');
    assert.match(result.recommendation.dashboard.title, /Sarah/);

    const explanation = explainRecommendation(result.recommendation.id);
    assert.equal(explanation.decision, 'prepare');
    assert.equal(explanation.sourceEvent.type, 'calendar.event_approaching');
    assert.equal(explanation.sourceEvent.id, syncWithSarah.id);
    assert.match(explanation.reasoningSummary, /approaching/);
    assert.match(explanation.dashboardTitle, /Sarah/);
    assert.ok(explanation.relatedEvents.some((event) => event.type === 'agent.action.completed'));

    const morning = agent.generateDashboard({ context: 'morning' });
    const recommendationCard = morning.components.find((component) => component.type === 'recommendation');
    assert.equal(recommendationCard.data.recommendationId, result.recommendation.id);

    // GET /api/recommendations' backing store must surface it, dismissible.
    const open = listRecommendations({ status: 'open' });
    assert.ok(open.some((r) => r.id === result.recommendation.id));
  } finally {
    cleanup(dir);
  }
});

test('calendar.event_changed detects authoritative interval conflicts and ignores non-overlaps', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();
    const changed = calendarProvider.createEvent({ title: 'Changed meeting', startAt: '2026-10-01T10:00:00.000Z', endAt: '2026-10-01T11:00:00.000Z' });
    const overlap = calendarProvider.createEvent({ title: 'Existing focus block', startAt: '2026-10-01T05:30:00-05:00', endAt: '2026-10-01T06:30:00-05:00' });
    calendarProvider.createEvent({ title: 'Later meeting', startAt: '2026-10-01T12:00:00.000Z', endAt: '2026-10-01T13:00:00.000Z' });

    const conflict = await agent.evaluateEvent({ type: 'calendar.event_changed', subject: { type: 'calendar_event', id: changed.id }, data: { after: changed } });
    assert.equal(conflict.decision, 'notify');
    assert.deepEqual(conflict.conflicts, [overlap.id]);
    assert.equal(conflict.outcome.status, 'executed');
    assert.equal(conflict.outcome.tool, 'notifications.send');
    assert.equal(db.prepare("SELECT count(*) AS count FROM events WHERE type = 'notification.sent'").get().count, 1);

    const isolated = calendarProvider.createEvent({ title: 'Isolated event', startAt: '2026-10-02T10:00:00.000Z', endAt: '2026-10-02T11:00:00.000Z' });
    const noConflict = await agent.evaluateEvent({ type: 'calendar.event_changed', subject: { type: 'calendar_event', id: isolated.id }, data: { after: isolated } });
    assert.equal(noConflict.decision, 'ignore');
    assert.equal(db.prepare("SELECT count(*) AS count FROM events WHERE type = 'notification.sent'").get().count, 1);
  } finally {
    cleanup(dir);
  }
});

test('task.overdue -> decision "notify", policy-gated notification sent', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();

    const task = tasksProvider.createTask({ title: 'Overdue thing', dueAt: new Date(Date.now() - 3600_000).toISOString() });

    const result = await agent.evaluateEvent({
      type: 'task.overdue',
      data: { taskId: task.id, title: task.title, dueAt: task.due_at },
      subject: { type: 'task', id: task.id },
    });

    assert.equal(result.decision, 'notify');
    assert.equal(result.outcome.status, 'executed');
    const sent = db.prepare("SELECT * FROM events WHERE type = 'notification.sent'").all();
    assert.equal(sent.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('commitment.made -> decision "act", auto-creates the linked task exactly once (IF no task exists guard)', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();

    const commitment = createEntity({ type: 'Commitment', name: 'Send proposal', attributes: { description: 'send the proposal', status: 'open' } });
    const event = {
      type: 'commitment.made',
      data: { description: 'send the proposal' },
      subject: { type: 'entity', id: commitment.id },
    };

    const first = await agent.evaluateEvent(event);
    assert.equal(first.decision, 'act');
    assert.equal(first.outcome.status, 'executed');
    assert.equal(first.outcome.tool, 'tasks.create');

    const linkedTasks = db.prepare('SELECT * FROM tasks WHERE related_entity_id = ?').all(commitment.id);
    assert.equal(linkedTasks.length, 1);
    assert.equal(linkedTasks[0].title, 'send the proposal');

    // Firing the exact same commitment again must NOT create a second task.
    const second = await agent.evaluateEvent(event);
    assert.equal(second.decision, 'ignore');

    const linkedTasksAfter = db.prepare('SELECT * FROM tasks WHERE related_entity_id = ?').all(commitment.id);
    assert.equal(linkedTasksAfter.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('an unhandled event type reaching evaluateEvent returns "ignore" and does nothing -- not a crash, not undocumented behavior', async () => {
  const dir = tempHome();
  try {
    const { db, agent } = buildAgent();

    const actionsBefore = db.prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n;
    const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

    const result = await agent.evaluateEvent({ type: 'project.changed', data: {}, subject: null });

    assert.equal(result.decision, 'ignore');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_actions').get().n, actionsBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, tasksBefore);
  } finally {
    cleanup(dir);
  }
});

test('CRITICAL: evaluateEvent choosing "act" for a never-policy-blocked tool cannot bypass the policy engine', async () => {
  const dir = tempHome();
  try {
    // tasks.create is `autonomous` in the real seed policy -- to prove the
    // invariant we need a scenario where evaluateEvent's own decision logic
    // still says "act" (commitment.made always does) while policy.yaml
    // itself blocks that tool outright. This is done by configuring the
    // POLICY (never the event's own data/arguments -- that would be the
    // exact bypass PROMPT.md/docs/policies.md forbid), so nothing about
    // agent.js's context-derivation or policy-engine.js's evaluation logic
    // is touched.
    const policyEngine = new PolicyEngine({ policies: neverCreateTasksPolicy() });
    const { db, agent } = buildAgent({ policyEngine });

    const commitment = createEntity({ type: 'Commitment', name: 'Ship the report', attributes: { description: 'ship the report', status: 'open' } });
    const event = {
      type: 'commitment.made',
      data: { description: 'ship the report' },
      subject: { type: 'entity', id: commitment.id },
    };

    const result = await agent.evaluateEvent(event);

    // evaluateEvent still made its documented decision...
    assert.equal(result.decision, 'act');
    // ...but the tool categorically did NOT execute.
    assert.equal(result.outcome.status, 'blocked');
    assert.equal(result.outcome.tool, 'tasks.create');

    const linkedTasks = db.prepare('SELECT * FROM tasks WHERE related_entity_id = ?').all(commitment.id);
    assert.equal(linkedTasks.length, 0, 'no task must have been created -- policy blocked it');

    const auditRow = db.prepare("SELECT * FROM agent_actions WHERE tool = 'tasks.create' ORDER BY created_at DESC").get();
    assert.ok(auditRow, 'the blocked attempt must still be in the audit trail');
    assert.equal(auditRow.status, 'blocked');
    assert.equal(auditRow.policy_rule, 'tasks.create:never');
  } finally {
    cleanup(dir);
  }
});
