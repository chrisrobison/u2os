import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { EventBus } from '../server/events/event-bus.js';
import { initProjector } from '../server/memory/projector.js';
import { runSeed } from '../server/seed/seed.js';
import { findEntities } from '../server/memory/entity-store.js';
import { validateDashboard } from '../server/api/dashboard-schema.js';
import {
  generateDashboard,
  DashboardNotFoundError,
  InvalidDashboardContextError,
} from '../server/agent/dashboard-planner.js';
import { startServer } from '../server/index.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-dashboard-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedDemoData() {
  const db = getDb();
  const eventBus = new EventBus(db);
  initProjector(eventBus);
  runSeed({ eventBus });
  return db;
}

async function cleanupServer(dir, handle) {
  syncScheduler.stopAll();
  await triggerEngine.stopAll();
  if (handle?.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
  cleanup(dir);
}

test('generateDashboard({context: "morning"}) returns a schema that passes validateDashboard', () => {
  const dir = tempHome();
  try {
    seedDemoData();
    const schema = generateDashboard({ context: 'morning' });
    assert.doesNotThrow(() => validateDashboard(schema));
    assert.equal(schema.title, 'Morning Briefing');
    assert.equal(schema.layout, 'dashboard');
    const types = schema.components.map((c) => c.type);
    assert.ok(types.includes('schedule'));
    assert.ok(types.includes('task-list'));
    assert.ok(types.includes('approval'));
  } finally {
    cleanup(dir);
  }
});

test('generateDashboard({context: "before-meeting"}) for a real seeded person (Sarah) reflects her real data and validates', () => {
  const dir = tempHome();
  try {
    seedDemoData();
    const [sarah] = findEntities({ type: 'Person', query: 'Sarah' });
    assert.ok(sarah, 'Sarah must be seeded');

    const schema = generateDashboard({ context: 'before-meeting', params: { personId: sarah.id } });
    assert.doesNotThrow(() => validateDashboard(schema));
    assert.match(schema.title, /Sarah/);

    // Sarah is seeded with an upcoming "Sync with Sarah" event and an open
    // task ("Send proposal draft to Sarah") -- the generated schema must
    // actually surface that real, person-specific data, not a generic shell.
    const scheduleComponent = schema.components.find((c) => c.type === 'schedule');
    assert.ok(scheduleComponent, 'expected a schedule component for Sarah\'s upcoming meeting');
    assert.ok(scheduleComponent.data.events.some((e) => e.title === 'Sync with Sarah'));

    const taskListComponent = schema.components.find((c) => c.type === 'task-list');
    assert.ok(taskListComponent);
    assert.ok(taskListComponent.data.tasks.some((t) => t.title === 'Send proposal draft to Sarah'));

    // The fact/relationship summary alert should mention something real
    // about Sarah, not be generic boilerplate.
    const alertComponent = schema.components.find((c) => c.type === 'alert');
    assert.ok(alertComponent);
    assert.ok(alertComponent.data.message.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('generateDashboard({context: "before-meeting"}) for a person with no upcoming meetings/tasks degrades gracefully', () => {
  const dir = tempHome();
  try {
    seedDemoData();
    const [dana] = findEntities({ type: 'Person', query: 'Dana' });
    assert.ok(dana, 'Dana must be seeded');

    const schema = generateDashboard({ context: 'before-meeting', params: { personId: dana.id } });
    assert.doesNotThrow(() => validateDashboard(schema));
    // No calendar event mentions Dana in seed data, so the schedule slot
    // must fall back to an informative alert rather than an empty/broken
    // schedule component.
    assert.ok(schema.components.length > 0);
    assert.ok(schema.components.some((c) => c.type === 'alert'));
  } finally {
    cleanup(dir);
  }
});

test('generateDashboard({context: "project"}) for the seeded U2OS project reflects real linked data and validates', () => {
  const dir = tempHome();
  try {
    seedDemoData();
    const [project] = findEntities({ type: 'Project', query: 'U2OS' });
    assert.ok(project, 'U2OS project must be seeded');

    const schema = generateDashboard({ context: 'project', params: { projectId: project.id } });
    assert.doesNotThrow(() => validateDashboard(schema));
    assert.match(schema.title, /U2OS/);

    const taskListComponent = schema.components.find((c) => c.type === 'task-list');
    assert.ok(taskListComponent);
    assert.ok(taskListComponent.data.tasks.some((t) => t.title === 'Review U2OS architecture doc'));
  } finally {
    cleanup(dir);
  }
});

test('an unknown personId is handled cleanly (no crash, clear 404-style error)', () => {
  const dir = tempHome();
  try {
    seedDemoData();
    assert.throws(
      () => generateDashboard({ context: 'before-meeting', params: { personId: 'ent_does_not_exist' } }),
      DashboardNotFoundError
    );
  } finally {
    cleanup(dir);
  }
});

test('an unknown projectId is handled cleanly (no crash, clear 404-style error)', () => {
  const dir = tempHome();
  try {
    seedDemoData();
    assert.throws(
      () => generateDashboard({ context: 'project', params: { projectId: 'ent_does_not_exist' } }),
      DashboardNotFoundError
    );
  } finally {
    cleanup(dir);
  }
});

test('an invalid context value is rejected with a clear error, not silently returning something', () => {
  const dir = tempHome();
  try {
    seedDemoData();
    assert.throws(() => generateDashboard({ context: 'travel' }), InvalidDashboardContextError);
    assert.throws(() => generateDashboard({}), InvalidDashboardContextError);
  } finally {
    cleanup(dir);
  }
});

test('GET /api/dashboard/morning still works identically after the provider-registry fix, and reflects the live calendar provider', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0, disableAuthForTests: true });
    const port = handle.server.address().port;

    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/morning`);
    assert.equal(res.status, 200);
    const schema = await res.json();

    assert.doesNotThrow(() => validateDashboard(schema));
    assert.equal(schema.title, 'Morning Briefing');
    assert.equal(schema.layout, 'dashboard');
    const types = schema.components.map((c) => c.type);
    assert.deepEqual(types, ['schedule', 'task-list', 'approval']);
  } finally {
    await cleanupServer(dir, handle);
  }
});

test('POST /api/dashboard/generate returns schemas that differ meaningfully across morning/before-meeting/project contexts', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0, disableAuthForTests: true });
    const port = handle.server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const entitiesRes = await fetch(`${base}/api/memory/entities?type=Person`);
    const { entities: people } = await entitiesRes.json();
    const sarah = people.find((p) => p.name === 'Sarah');
    assert.ok(sarah, 'Sarah must be discoverable via GET /api/memory/entities?type=Person');

    const projectsRes = await fetch(`${base}/api/memory/entities?type=Project`);
    const { entities: projects } = await projectsRes.json();
    const project = projects.find((p) => p.name === 'U2OS');
    assert.ok(project, 'U2OS project must be discoverable via GET /api/memory/entities?type=Project');

    async function generate(context, params) {
      const res = await fetch(`${base}/api/dashboard/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, params }),
      });
      assert.equal(res.status, 200, `expected 200 for context=${context}`);
      const schema = await res.json();
      assert.doesNotThrow(() => validateDashboard(schema));
      return schema;
    }

    const morning = await generate('morning');
    const beforeMeeting = await generate('before-meeting', { personId: sarah.id });
    const projectDashboard = await generate('project', { projectId: project.id });

    // Titles and payloads must genuinely differ by context/params -- not
    // the same static object returned every time.
    assert.notEqual(morning.title, beforeMeeting.title);
    assert.notEqual(beforeMeeting.title, projectDashboard.title);
    assert.notDeepEqual(JSON.stringify(morning), JSON.stringify(beforeMeeting));
    assert.notDeepEqual(JSON.stringify(beforeMeeting), JSON.stringify(projectDashboard));

    // Unknown ids -> clean 404, not a crash.
    const notFoundRes = await fetch(`${base}/api/dashboard/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'before-meeting', params: { personId: 'ent_nope' } }),
    });
    assert.equal(notFoundRes.status, 404);

    // Invalid context -> clean 400, not a crash.
    const badContextRes = await fetch(`${base}/api/dashboard/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'travel' }),
    });
    assert.equal(badContextRes.status, 400);
  } finally {
    await cleanupServer(dir, handle);
  }
});
