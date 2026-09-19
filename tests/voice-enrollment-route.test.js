import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

// server/voice/enrollment-store.js + the POST/GET/DELETE
// /api/voice/enrollment route it backs -- the server-side half of Phase
// 5's voice enrollment (docs/voice.md). The client-side feature
// extraction (public/services/voiceprint.js) needs a real mic to exercise
// and can't be tested here; this covers persistence while ensuring the
// verifier vector is never disclosed back to a browser.

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-voice-enrollment-test-'));
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

test('GET /api/voice/enrollment starts out not enrolled and does not expose a verifier vector', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/enrollment`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.enrolled, false);
    assert.equal(body.enrolledAt, null);
    assert.equal(body.vector, undefined);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/voice/enrollment persists the verifier but GET never returns it', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;
    const vector = [0.1, 0.2, 0.3, 0.4];

    const postRes = await fetch(`http://127.0.0.1:${port}/api/voice/enrollment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector }),
    });
    const postBody = await postRes.json();
    assert.equal(postRes.status, 200);
    assert.equal(postBody.enrolled, true);
    assert.ok(postBody.enrolledAt);

    const getRes = await fetch(`http://127.0.0.1:${port}/api/voice/enrollment`);
    const getBody = await getRes.json();
    assert.equal(getBody.enrolled, true);
    assert.equal(getBody.vector, undefined);
    assert.equal(getBody.enrolledAt, postBody.enrolledAt);

    // Persisted into config.json itself, not just held in memory.
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'config.json'), 'utf8'));
    assert.deepEqual(config.voiceEnrollment.vector, vector);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/voice/enrollment rejects a missing/empty vector with 400', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    for (const body of [{}, { vector: [] }, { vector: 'nope' }]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/voice/enrollment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
  } finally {
    await cleanup(dir, handle);
  }
});

test('DELETE /api/voice/enrollment clears a previously-saved enrollment', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    await fetch(`http://127.0.0.1:${port}/api/voice/enrollment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector: [1, 2, 3] }),
    });

    const delRes = await fetch(`http://127.0.0.1:${port}/api/voice/enrollment`, { method: 'DELETE' });
    const delBody = await delRes.json();
    assert.equal(delRes.status, 200);
    assert.equal(delBody.enrolled, false);

    const getRes = await fetch(`http://127.0.0.1:${port}/api/voice/enrollment`);
    const getBody = await getRes.json();
    assert.equal(getBody.enrolled, false);
    assert.equal(getBody.vector, undefined);
  } finally {
    await cleanup(dir, handle);
  }
});
