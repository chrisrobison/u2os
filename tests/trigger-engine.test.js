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
import * as tasksProvider from '../server/integrations/mock-tasks-provider.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-trigger-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir) {
  await triggerEngine.stopAll();
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

async function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitFor: condition never became true within timeout');
}

test('event_rule trigger fires on a matching event and produces a policy-gated, audited action', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus, agent } = buildAgent();

    triggerEngine.createTrigger({
      name: 'Test: notify on demo.ping',
      kind: 'event_rule',
      config: { eventType: 'demo.ping', action: { kind: 'notify', title: 'Ping', body: 'A demo.ping event fired.' } },
      source: 'user',
    });

    triggerEngine.startAll({ eventBus, agent, tickMs: 3_600_000 });

    eventBus.publish({ type: 'demo.ping', source: 'test', data: {} });

    // Wait for a terminal status, not just row existence -- recordAudit()
    // inserts the row as 'approved' first and only flips it to 'executed'
    // once the tool has actually run, a moment later.
    const row = await waitFor(() =>
      db
        .prepare("SELECT * FROM agent_actions WHERE tool = 'notifications.send' AND status = 'executed' ORDER BY created_at DESC")
        .get()
    );

    // notifications.send is `autonomous` per the seeded policy -> no
    // approval required, executes immediately -- but it MUST still have
    // gone through the real policy engine and audit trail, not a
    // hand-rolled shortcut.
    assert.equal(row.requires_approval, 0);
    assert.equal(row.status, 'executed');
    assert.equal(row.policy_domain, 'notifications');

    // Trigger firing bookkeeping is itself visible in the activity feed.
    const bookkeeping = db
      .prepare("SELECT * FROM events WHERE type = 'agent.action.completed' AND source = 'trigger-engine'")
      .all();
    assert.equal(bookkeeping.length, 1);
  } finally {
    await cleanup(dir);
  }
});

test('condition_watch (task_overdue) dedupes via trigger_fired_log -- firing the tick twice does not double-notify the same task', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus, agent } = buildAgent();

    const overdueTask = tasksProvider.createTask({
      title: 'Overdue demo task',
      dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const trigger = triggerEngine.createTrigger({
      name: 'Test: overdue task notify',
      kind: 'condition_watch',
      config: { check: 'task_overdue', action: { kind: 'notify', title: 'Overdue', body: 'A task is overdue.' } },
      source: 'user',
    });

    await triggerEngine.runTick({ eventBus, agent });
    await triggerEngine.runTick({ eventBus, agent });

    const overdueEvents = db.prepare("SELECT * FROM events WHERE type = 'task.overdue'").all();
    assert.equal(overdueEvents.length, 1, 'task.overdue must be published exactly once for the same task');

    const notifyRows = db.prepare("SELECT * FROM agent_actions WHERE tool = 'notifications.send'").all();
    assert.equal(notifyRows.length, 1, 'the notify action must not fire twice for the same overdue task');

    const firedLogRows = db
      .prepare('SELECT * FROM trigger_fired_log WHERE trigger_id = ? AND object_id = ?')
      .all(trigger.id, overdueTask.id);
    assert.equal(firedLogRows.length, 1);
  } finally {
    await cleanup(dir);
  }
});

test('timer trigger fires exactly once, then disables itself', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus, agent } = buildAgent();

    const trigger = triggerEngine.createTrigger({
      name: 'Test: one-shot timer',
      kind: 'timer',
      config: {
        fireAt: new Date(Date.now() - 1000).toISOString(),
        action: { kind: 'notify', title: 'Timer fired', body: 'One-shot timer.' },
      },
      source: 'user',
    });
    assert.equal(trigger.enabled, true);

    await triggerEngine.runTick({ eventBus, agent });
    await triggerEngine.runTick({ eventBus, agent }); // must be a no-op: already disabled

    const notifyRows = db.prepare("SELECT * FROM agent_actions WHERE tool = 'notifications.send'").all();
    assert.equal(notifyRows.length, 1, 'a one-shot timer must fire exactly once even across multiple ticks');

    const after = triggerEngine.getTrigger(trigger.id);
    assert.equal(after.enabled, false);
    assert.equal(after.next_check_at, null);
  } finally {
    await cleanup(dir);
  }
});

test('stopAll() clears the interval -- no dangling timer keeps firing after it is called', async () => {
  const dir = tempHome();
  try {
    const { db, eventBus, agent } = buildAgent();

    // Abuses the `everyMinutes` formula to get sub-minute rescheduling
    // (config accepts any positive number; the engine has no minimum),
    // purely so this test can observe several ticks quickly.
    triggerEngine.createTrigger({
      name: 'Test: fast repeating schedule',
      kind: 'schedule',
      config: {
        everyMinutes: 0.0005, // ~30ms
        action: { kind: 'notify', title: 'Tick', body: 'Repeating schedule fired.' },
      },
      source: 'user',
    });

    triggerEngine.startAll({ eventBus, agent, tickMs: 15 });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const countWhileRunning = db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE tool = 'notifications.send'").get().n;
    assert.ok(countWhileRunning > 0, 'the schedule trigger must have fired at least once while running');

    // await, not fire-and-forget: stopAll() now guarantees every in-flight
    // tick has fully settled before it resolves (see the `inFlight` set in
    // trigger-engine.js), so there's no longer a fixed-timeout guess involved
    // here -- by the time this line resolves, nothing from this engine is
    // still running, period.
    await triggerEngine.stopAll();
    const countAtStop = db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE tool = 'notifications.send'").get().n;

    await new Promise((resolve) => setTimeout(resolve, 300));
    const countAfterStop = db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE tool = 'notifications.send'").get().n;

    assert.equal(countAfterStop, countAtStop, 'no further firings must happen after stopAll()');
  } finally {
    // stopAll() again is a harmless no-op -- proves it's idempotent too.
    await cleanup(dir);
  }
});
