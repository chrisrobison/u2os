import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

// Same boot/teardown pattern as tests/export-route.test.js: a real scratch
// U2OS_HOME, a real HTTP server on an ephemeral port, real seeded data.
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-voice-route-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir, handle) {
  syncScheduler.stopAll();
  await triggerEngine.stopAll();
  if (handle?.server) {
    await new Promise((resolve) => handle.server.close(resolve));
  }
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

async function postJson(port, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /api/agent/voice-message: a low-confidence speaker forces an otherwise-autonomous action (tasks.create) to require approval instead of executing', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/agent/voice-message', {
      text: 'Remind me to call the plumber.',
      speaker: { cluster: 0, identity: 'unknown', confidence: 0.3 },
    });

    assert.equal(status, 200);
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].tool, 'tasks.create');
    // tasks.create is `autonomous` in the shipped seed policy (would
    // normally execute immediately) -- voice confidence 0.3 is below the
    // default `standard` threshold (0.85), so it must come back pending.
    assert.equal(body.actions[0].status, 'pending');
    assert.equal(body.pendingActionIds.length, 1);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/agent/voice-message: a high-confidence speaker leaves an autonomous action executing immediately (voice only tightens)', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/agent/voice-message', {
      text: 'Remind me to call the plumber.',
      speaker: { cluster: 0, identity: 'owner', confidence: 0.98 },
    });

    assert.equal(status, 200);
    assert.equal(body.actions[0].status, 'executed');
    assert.equal(body.pendingActionIds.length, 0);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/agent/voice-message: a reschedule (already confirm-gated by the seed policy) still requires approval with a low-confidence speaker', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/agent/voice-message', {
      text: 'Move my 2 PM meeting with Sarah to tomorrow afternoon.',
      speaker: { cluster: 0, identity: 'unknown', confidence: 0.3 },
    });

    assert.equal(status, 200);
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].tool, 'calendar.reschedule');
    assert.equal(body.actions[0].status, 'pending');
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/agent/message (the pre-existing, non-voice route) is completely unaffected by this phase: the same reminder still autonomous-executes', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/agent/message', {
      text: 'Remind me to call the plumber.',
    });

    assert.equal(status, 200);
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].tool, 'tasks.create');
    assert.equal(body.actions[0].status, 'executed');
    assert.equal(body.pendingActionIds.length, 0);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/agent/voice-message with no `speaker` field at all fails safe to confidence 0 (NOT the same as /api/agent/message)', async () => {
  // Regression test for a real bug caught in security review: hitting this
  // route at all is the caller claiming "this came from voice", so it must
  // never let an omitted `speaker` field opt a request out of the voice
  // gate entirely -- that would make the whole safety layer defeatable
  // simply by leaving a field off, which is exactly the "someone else's
  // browser tab talking to my server" attacker model docs/voice.md names.
  // A previous version of the route treated a missing `speaker` as "no
  // voice context at all" (pass-through, identical to claiming confidence
  // 1.0); this version must instead default confidence to 0, same as an
  // explicitly-malformed speaker object.
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/agent/voice-message', {
      text: 'Remind me to call the plumber.',
    });

    assert.equal(status, 200);
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].tool, 'tasks.create');
    assert.equal(body.actions[0].status, 'pending');
    assert.equal(body.pendingActionIds.length, 1);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/agent/voice-message with speaker:null also fails safe to confidence 0', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const { status, body } = await postJson(port, '/api/agent/voice-message', {
      text: 'Remind me to call the plumber.',
      speaker: null,
    });

    assert.equal(status, 200);
    assert.equal(body.actions[0].status, 'pending');
  } finally {
    await cleanup(dir, handle);
  }
});
