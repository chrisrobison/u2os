import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPackageFixture, packageManifest } from './helpers/package-fixture.js';
import { WorkflowEngine } from '../server/packages/workflow-engine.js';
import { AutomationRuntime } from '../server/packages/automation-runtime.js';
import { ensureAutomationInstance, listRuns, getInstanceByAutomation, getRun } from '../server/packages/workflow-store.js';
import { revokePermissions, setPackageEnabled } from '../server/packages/store.js';
import { getDb } from '../server/db/connection.js';

function install(fx, automation, { grant = 'all' } = {}) {
  fx.install({
    manifest: packageManifest('com.example.watch', {
      exports: {
        capabilities: [{ id: 'watch.note', file: 'c.yaml' }, { id: 'watch.ask', file: 'ask.yaml' }],
        automations: [{ id: 'watcher', file: 'a.yaml' }],
      },
      permissions: { notifications: { send: true } },
      policies: { askFirst: { approval: 'required' } },
      events: { emits: ['watch.noticed'] },
    }),
    capabilities: {
      'watch.note': { id: 'watch.note', effect: 'read', permissions: ['notifications.send'], implementation: { type: 'static', output: { noted: '{{ input.text }}' } } },
      'watch.ask': { id: 'watch.ask', effect: 'write', permissions: ['notifications.send'], implementation: { type: 'static', output: { asked: true } } },
    },
    automations: { watcher: { id: 'watcher', ...automation } },
    grant,
  });
  const definition = fx.registries.automations.get('watcher');
  ensureAutomationInstance({ packageId: 'com.example.watch', automationId: 'watcher', initialState: definition.state.initial });
}

function runtimeFor(fx, clock) {
  const engine = new WorkflowEngine({ registries: fx.registries, invoker: fx.invoker, eventBus: fx.eventBus, clock });
  return new AutomationRuntime({ registries: fx.registries, engine, eventBus: fx.eventBus, clock });
}

const rootRuns = () => listRuns({ kind: 'automation', limit: 100 }).filter((run) => !run.parentRunId);

test('scheduled automations run once per slot', async () => {
  const fx = createPackageFixture();
  let now = new Date('2026-09-28T07:30:00Z');
  const runtime = runtimeFor(fx, () => now);
  try {
    install(fx, { triggers: [{ type: 'schedule', every: '1h' }], steps: [{ id: 'note', use: 'capability:watch.note', with: { text: 'tick {{ trigger.slot }}' } }] });
    runtime.enable('watcher');
    assert.equal(getInstanceByAutomation('watcher').nextRunAt, '2026-09-28T08:00:00.000Z');
    await runtime.tick(now);
    assert.equal(rootRuns().length, 0);
    now = new Date('2026-09-28T08:00:30Z');
    await runtime.tick(now);
    await runtime.tick(now);
    const runs = rootRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.deepEqual(runs[0].outputs, { noted: 'tick 2026-09-28T08:00:00.000Z' });
    assert.equal(getInstanceByAutomation('watcher').nextRunAt, '2026-09-28T09:00:00.000Z');
    assert.equal(runtime.inspect('watcher').lastRun.status, 'completed');
  } finally { await runtime.stop(); await fx.cleanup(); }
});

test('a schedule missed during long downtime is recorded, not replayed', async () => {
  const fx = createPackageFixture();
  let now = new Date('2026-09-28T07:30:00Z');
  const runtime = runtimeFor(fx, () => now);
  try {
    install(fx, { triggers: [{ type: 'schedule', cron: '0 8 * * *' }], steps: [{ id: 'note', use: 'capability:watch.note', with: { text: 'x' } }] });
    runtime.enable('watcher');
    now = new Date('2026-09-28T13:00:00Z');
    await runtime.tick(now);
    const runs = rootRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'skipped');
    assert.equal(runs[0].error, 'missed_schedule');
    assert.ok(Date.parse(getInstanceByAutomation('watcher').nextRunAt) > now.getTime());
  } finally { await runtime.stop(); await fx.cleanup(); }
});

test('event triggers start runs, match conditions, and deduplicate deliveries', async () => {
  const fx = createPackageFixture();
  const runtime = runtimeFor(fx);
  try {
    install(fx, {
      triggers: [{ type: 'event', event: 'recruiter.replied', where: 'event.data.company == "Acme"', with: { company: '{{ trigger.event.data.company }}' } }],
      inputs: { company: { type: 'string' } },
      steps: [{ id: 'note', use: 'capability:watch.note', with: { text: 'Reply from {{ inputs.company }}' } }],
    });
    runtime.enable('watcher');
    runtime.start({ tickMs: 3_600_000 });
    fx.eventBus.publish({ type: 'recruiter.replied', data: { company: 'Beta' } });
    const event = fx.eventBus.publish({ type: 'recruiter.replied', data: { company: 'Acme' } });
    await runtime.drain();
    let runs = rootRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.deepEqual(runs[0].outputs, { noted: 'Reply from Acme' });
    assert.equal(runs[0].trigger.event.id, event.id);
    // Redelivery of the same event (e.g. catch-up after restart) is a no-op.
    runtime.handleEvent(event);
    getDb().prepare('DELETE FROM automation_event_cursor').run();
    getDb().prepare('INSERT INTO automation_event_cursor (id, last_rowid, updated_at) VALUES (1, 0, ?)').run(new Date().toISOString());
    runtime.catchUpEvents();
    await runtime.drain();
    runs = rootRuns();
    assert.equal(runs.length, 1);
  } finally { await runtime.stop(); await fx.cleanup(); }
});

test('events published while stopped are delivered once after restart', async () => {
  const fx = createPackageFixture();
  const first = runtimeFor(fx);
  let second;
  try {
    install(fx, { triggers: [{ type: 'event', event: 'recruiter.replied' }], steps: [{ id: 'note', use: 'capability:watch.note', with: { text: 'x' } }] });
    first.enable('watcher');
    first.start({ tickMs: 3_600_000 });
    await first.stop();
    fx.eventBus.publish({ type: 'recruiter.replied', data: {} });
    assert.equal(rootRuns().length, 0);
    second = runtimeFor(fx);
    second.start({ tickMs: 3_600_000 });
    await second.drain();
    assert.equal(rootRuns().length, 1);
    assert.equal(rootRuns()[0].status, 'completed');
  } finally { await second?.stop(); await fx.cleanup(); }
});

test('an automation never re-triggers on events its own runs emitted', async () => {
  const fx = createPackageFixture();
  const runtime = runtimeFor(fx);
  try {
    install(fx, { triggers: [{ type: 'event', event: 'watch.noticed' }, { type: 'manual' }], concurrency: 'parallel',
      steps: [{ id: 'echo', use: 'emit', with: { type: 'watch.noticed', data: {} } }] });
    runtime.enable('watcher');
    runtime.start({ tickMs: 3_600_000 });
    await runtime.runNow('watcher');
    await runtime.drain();
    assert.equal(rootRuns().length, 1);
  } finally { await runtime.stop(); await fx.cleanup(); }
});

test('waiting runs resume after approval, and single concurrency skips overlapping triggers', async () => {
  const fx = createPackageFixture();
  const runtime = runtimeFor(fx);
  try {
    install(fx, { triggers: [{ type: 'manual' }], steps: [{ id: 'ask', use: 'capability:watch.ask', policy: 'askFirst' }] });
    runtime.enable('watcher');
    runtime.start({ tickMs: 3_600_000 });
    const waiting = await runtime.runNow('watcher');
    assert.equal(waiting.status, 'waiting');
    const skipped = await runtime.runNow('watcher');
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.error, 'already_running');
    await fx.agent.approveAction(waiting.wait.actionId, 'owner');
    await runtime.drain();
    assert.equal(getRun(waiting.id).status, 'completed');
    assert.deepEqual(getRun(waiting.id).outputs, { asked: true });
  } finally { await runtime.stop(); await fx.cleanup(); }
});

test('enable requires grants; disable, pause and package disable stop triggers', async () => {
  const fx = createPackageFixture();
  const runtime = runtimeFor(fx);
  try {
    install(fx, { triggers: [{ type: 'event', event: 'recruiter.replied' }, { type: 'manual' }], steps: [{ id: 'note', use: 'capability:watch.note', with: { text: 'x' } }] }, { grant: [] });
    assert.throws(() => runtime.enable('watcher'), /Grant com.example.watch these permissions before enabling watcher: notifications.send/);
    const { grantPermissions } = await import('../server/packages/store.js');
    grantPermissions('com.example.watch', ['notifications.send']);
    runtime.enable('watcher');
    runtime.start({ tickMs: 3_600_000 });

    runtime.disable('watcher');
    fx.eventBus.publish({ type: 'recruiter.replied', data: {} });
    await runtime.drain();
    assert.equal(rootRuns().length, 0);
    // A manual run is the owner's explicit request and works while disabled.
    assert.equal((await runtime.runNow('watcher')).status, 'completed');

    runtime.enable('watcher');
    runtime.pause('watcher');
    fx.eventBus.publish({ type: 'recruiter.replied', data: {} });
    await assert.rejects(() => runtime.runNow('watcher'), /paused/);
    runtime.resume('watcher');

    setPackageEnabled('com.example.watch', false);
    fx.registries.packages.get('com.example.watch').enabled = false;
    fx.eventBus.publish({ type: 'recruiter.replied', data: {} });
    await runtime.drain();
    assert.equal(rootRuns().length, 1);

    fx.registries.packages.get('com.example.watch').enabled = true;
    revokePermissions('com.example.watch');
    fx.eventBus.publish({ type: 'recruiter.replied', data: {} });
    await runtime.drain();
    const failed = rootRuns()[0];
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /not granted: notifications.send/);
  } finally { await runtime.stop(); await fx.cleanup(); }
});

test('runaway triggers are throttled per automation per hour', async () => {
  const fx = createPackageFixture();
  const engine = new WorkflowEngine({ registries: fx.registries, invoker: fx.invoker, eventBus: fx.eventBus });
  const runtime = new AutomationRuntime({ registries: fx.registries, engine, eventBus: fx.eventBus, maxRunsPerHour: 2 });
  try {
    install(fx, { triggers: [{ type: 'event', event: 'recruiter.replied' }], concurrency: 'parallel', steps: [{ id: 'note', use: 'capability:watch.note', with: { text: 'x' } }] });
    runtime.enable('watcher');
    runtime.start({ tickMs: 3_600_000 });
    for (let i = 0; i < 4; i++) fx.eventBus.publish({ type: 'recruiter.replied', data: { i } });
    await runtime.drain();
    const statuses = rootRuns().map((run) => run.status).sort();
    assert.deepEqual(statuses, ['completed', 'completed', 'throttled', 'throttled']);
  } finally { await runtime.stop(); await fx.cleanup(); }
});

test('inspect reports triggers, requirements, policies and run history', async () => {
  const fx = createPackageFixture();
  const runtime = runtimeFor(fx);
  try {
    install(fx, { triggers: [{ type: 'schedule', cron: '0 8 * * 1-5' }, { type: 'manual' }], steps: [{ id: 'ask', use: 'capability:watch.ask', policy: 'askFirst' }] });
    runtime.enable('watcher');
    const detail = runtime.inspect('watcher');
    assert.equal(detail.enabled, true);
    assert.deepEqual(detail.triggers.map((t) => t.description), ['cron 0 8 * * 1-5', 'run on request']);
    assert.ok(detail.nextRunAt);
    assert.deepEqual(detail.requirements, { capabilities: ['watch.ask'], permissions: ['notifications.send'], missing: [] });
    assert.deepEqual(detail.policies.map((p) => [p.name, p.approval]), [['askFirst', 'required']]);
    const run = await runtime.runNow('watcher');
    const runDetail = runtime.runDetail(run.id);
    assert.equal(runDetail.steps[0].stepId, 'ask');
    assert.equal(runDetail.steps[0].status, 'waiting');
    assert.equal(runtime.stopRuns('watcher').length, 1);
    assert.equal(getRun(run.id).status, 'cancelled');
  } finally { await runtime.stop(); await fx.cleanup(); }
});
