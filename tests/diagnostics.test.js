import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { closeAllForTests, getDb } from '../server/db/connection.js';
import { log, clearRecentLogEntriesForTests } from '../server/logging/logger.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';

const unauthenticatedFetch = globalThis.fetch;

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-diagnostics-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

async function cleanup(dir, handle) {
  syncScheduler.stopAll();
  await triggerEngine.stopAll();
  if (handle?.server) await new Promise((resolve) => handle.server.close(resolve));
  closeAllForTests();
  clearRecentLogEntriesForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('authenticated diagnostics exposes bounded operational metadata without private content', async () => {
  const dir = tempHome();
  let handle;
  try {
    clearRecentLogEntriesForTests();
    handle = await startServer({ port: 0 });
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_actions (id, requested_by, tool, arguments, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)")
      .run('action_diag', 'diagnostics-test', 'email.send', JSON.stringify({ body: 'PRIVATE EMAIL BODY' }), now, now);
    db.prepare("INSERT INTO action_queue (id, action_id, correlation_id, tool, arguments, idempotency_key, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'dead_letter', 3, ?, ?, ?)")
      .run('queue_diag', 'action_diag', 'corr_diag', 'email.send', JSON.stringify({ body: 'PRIVATE EMAIL BODY' }), 'secret-idempotency-key', now, now, now);
    log.error('diagnostics-test', 'A delivery dependency failed', { error: 'PRIVATE PROVIDER ERROR https://secret.example/token' });

    const response = await fetch(`http://127.0.0.1:${handle.port}/api/diagnostics`);
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const forbidden of ['PRIVATE EMAIL BODY', 'secret-idempotency-key', 'PRIVATE PROVIDER ERROR', 'secret.example', 'A delivery dependency failed']) {
      assert.doesNotMatch(text, new RegExp(forbidden));
    }
    const body = JSON.parse(text);
    assert.equal(body.status, 'degraded');
    assert.ok(body.server.uptimeSeconds >= 0);
    assert.equal(body.server.sseClientCount, 0);
    assert.ok(body.database.sizeBytes > 0);
    assert.ok(body.database.eventCount > 0);
    assert.equal(body.actions.deadLetters, 1);
    assert.ok(body.memory.entities > 0);
    assert.ok(body.memory.facts > 0);
    assert.equal(body.connectors.length, 5);
    assert.equal(body.model.mode, 'mock');
    assert.equal(body.embeddings.configured, false);
    assert.deepEqual(body.recentErrors.at(-1), {
      timestamp: body.recentErrors.at(-1).timestamp,
      level: 'error',
      component: 'diagnostics-test',
      message: 'An error was reported',
    });
  } finally { await cleanup(dir, handle); }
});

test('diagnostics is owner-only while public health remains minimal and redacted', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const origin = `http://127.0.0.1:${handle.port}`;
    const unauthenticated = await unauthenticatedFetch(`${origin}/api/diagnostics`);
    assert.equal(unauthenticated.status, 401);
    const health = await unauthenticatedFetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.deepEqual(Object.keys(body).sort(), ['status', 'uptimeSeconds', 'version']);
    assert.equal(body.status, 'ok');
  } finally { await cleanup(dir, handle); }
});
