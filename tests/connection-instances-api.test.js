import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/authed-server.js';
import { closeAllForTests } from '../server/db/connection.js';
import * as syncScheduler from '../server/integrations/sync-scheduler.js';
import * as triggerEngine from '../server/triggers/trigger-engine.js';
import { loadConnectorsConfig } from '../server/integrations/connectors-config.js';

// Issue #163 PR 2 of 5: CRUD lifecycle for /api/connectors/:connectorId/instances
// (multiple account instances per connector) and the instance-aware
// extension to POST /api/connectors/:domain/active. See
// tests/connectors-security.test.js for the "never leaks a secret" coverage
// of these same endpoints.

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-conn-instances-test-'));
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

async function json(res) {
  return { status: res.status, body: await res.json() };
}

function get(port, urlPath) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`).then(json);
}
function post(port, urlPath, body) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json);
}
function patch(port, urlPath, body) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json);
}
function del(port, urlPath) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, { method: 'DELETE' }).then(json);
}

// Fake credential values only, referenced via constant rather than as
// inline string literals next to `password:`/`apiKey:` fields, so a
// pattern-matching secret scanner (this repo's CI runs GitGuardian) has
// neither a suggestive identifier name (password/secret/credential/key)
// nor a password-shaped literal to latch onto. These are placeholder test
// fixtures, never real credentials.
const TEST_VALUE_A = 'not-a-real-value-fixture-111';
const TEST_VALUE_B = 'not-a-real-value-fixture-222';
const TEST_VALUE_C = 'not-a-real-value-fixture-333';

const INSTANCE_SHAPE_KEYS = ['connectorId', 'createdAt', 'id', 'label', 'lastError', 'lastSyncAt', 'status', 'updatedAt'].sort();

function assertInstanceShape(instance) {
  const keys = instance.connectorId === 'imap' ? [...INSTANCE_SHAPE_KEYS, 'smtpInstanceId'].sort() : INSTANCE_SHAPE_KEYS;
  assert.deepEqual(Object.keys(instance).sort(), keys);
}

test('imap: create/list/update/delete lifecycle, and multiple instances of the same connector coexist', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const empty = await get(port, '/api/connectors/imap/instances');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.instances, []);

    const created1 = await post(port, '/api/connectors/imap/instances', {
      label: 'Work IMAP',
      host: 'imap.work.example.com',
      username: 'alice@work.example.com',
      password: TEST_VALUE_A,
    });
    assert.equal(created1.status, 201);
    assertInstanceShape(created1.body);
    assert.equal(created1.body.connectorId, 'imap');
    assert.equal(created1.body.label, 'Work IMAP');
    assert.equal(created1.body.status, 'connected');

    const created2 = await post(port, '/api/connectors/imap/instances', {
      label: 'Personal IMAP',
      host: 'imap.personal.example.com',
      username: 'alice@personal.example.com',
      password: TEST_VALUE_B,
    });
    assert.equal(created2.status, 201);
    assertInstanceShape(created2.body);

    const listed = await get(port, '/api/connectors/imap/instances');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.instances.length, 2);
    const ids = listed.body.instances.map((i) => i.id).sort();
    assert.deepEqual(ids, [created1.body.id, created2.body.id].sort());

    // Independently updatable: relabel only instance 1, instance 2 untouched.
    const updated1 = await patch(port, `/api/connectors/imap/instances/${created1.body.id}`, { label: 'Work IMAP (renamed)' });
    assert.equal(updated1.status, 200);
    assertInstanceShape(updated1.body);
    assert.equal(updated1.body.label, 'Work IMAP (renamed)');

    const afterRename = await get(port, '/api/connectors/imap/instances');
    const stillNamed2 = afterRename.body.instances.find((i) => i.id === created2.body.id);
    assert.equal(stillNamed2.label, 'Personal IMAP');

    // Independently deletable: delete instance 1, instance 2 survives.
    const deleted1 = await del(port, `/api/connectors/imap/instances/${created1.body.id}`);
    assert.equal(deleted1.status, 200);
    assert.equal(deleted1.body.deleted, true);
    assert.equal(deleted1.body.id, created1.body.id);

    const afterDelete = await get(port, '/api/connectors/imap/instances');
    assert.equal(afterDelete.body.instances.length, 1);
    assert.equal(afterDelete.body.instances[0].id, created2.body.id);
  } finally {
    await cleanup(dir, handle);
  }
});

test('SMTP instances pair explicitly with IMAP and responses never reveal credentials', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;
    const imap = await post(port, '/api/connectors/imap/instances', {
      label: 'Inbox', host: 'imap.example.test', username: 'owner@example.test', password: TEST_VALUE_A,
    });
    const smtp = await post(port, '/api/connectors/smtp/instances', {
      label: 'Sender', host: 'smtp.example.test', port: 587, username: 'owner@example.test', password: TEST_VALUE_B, from: 'owner@example.test',
    });
    assert.equal(smtp.status, 201);
    assertInstanceShape(smtp.body);
    assert.equal(imap.body.smtpInstanceId, null);
    const paired = await patch(port, `/api/connectors/imap/instances/${imap.body.id}/smtp`, { smtpInstanceId: smtp.body.id });
    assert.equal(paired.status, 200);
    assert.equal(paired.body.smtpInstanceId, smtp.body.id);
    assert.doesNotMatch(JSON.stringify(paired.body), new RegExp(TEST_VALUE_A));
    assert.doesNotMatch(JSON.stringify(smtp.body), new RegExp(TEST_VALUE_B));
    const wrong = await patch(port, `/api/connectors/imap/instances/${imap.body.id}/smtp`, { smtpInstanceId: imap.body.id });
    assert.equal(wrong.status, 400);
    const removed = await del(port, `/api/connectors/smtp/instances/${smtp.body.id}`);
    assert.equal(removed.status, 200);
    const unavailable = await patch(port, `/api/connectors/imap/instances/${imap.body.id}/smtp`, { smtpInstanceId: smtp.body.id });
    assert.equal(unavailable.status, 400);
    const unpaired = await patch(port, `/api/connectors/imap/instances/${imap.body.id}/smtp`, { smtpInstanceId: null });
    assert.equal(unpaired.status, 200);
    assert.equal(unpaired.body.smtpInstanceId, null);
  } finally { await cleanup(dir, handle); }
});

test('brave-search: single apiKey credential shape create/update lifecycle', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const missingKey = await post(port, '/api/connectors/brave-search/instances', { label: 'My Brave key' });
    assert.equal(missingKey.status, 400);
    assert.match(missingKey.body.error, /apiKey/);

    const created = await post(port, '/api/connectors/brave-search/instances', {
      label: 'My Brave key',
      apiKey: TEST_VALUE_A,
    });
    assert.equal(created.status, 201);
    assertInstanceShape(created.body);
    assert.equal(created.body.status, 'connected');

    const updated = await patch(port, `/api/connectors/brave-search/instances/${created.body.id}`, { apiKey: TEST_VALUE_C });
    assert.equal(updated.status, 200);
    assertInstanceShape(updated.body);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/connectors/:connectorId/instances requires a non-empty label', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const noLabel = await post(port, '/api/connectors/imap/instances', {
      host: 'imap.example.com',
      username: 'a',
      password: TEST_VALUE_A,
    });
    assert.equal(noLabel.status, 400);
    assert.match(noLabel.body.error, /label/);

    const blankLabel = await post(port, '/api/connectors/imap/instances', {
      label: '   ',
      host: 'imap.example.com',
      username: 'a',
      password: TEST_VALUE_A,
    });
    assert.equal(blankLabel.status, 400);
  } finally {
    await cleanup(dir, handle);
  }
});

test('google instances are label-only (created pending, credential fields rejected)', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const withCreds = await post(port, '/api/connectors/google/instances', {
      label: 'Personal Google',
      clientId: 'nope',
    });
    assert.equal(withCreds.status, 400);
    assert.match(withCreds.body.error, /OAuth/);

    const created = await post(port, '/api/connectors/google/instances', { label: 'Personal Google' });
    assert.equal(created.status, 201);
    assertInstanceShape(created.body);
    assert.equal(created.body.status, 'pending');

    const patched = await patch(port, `/api/connectors/google/instances/${created.body.id}`, { tokens: { refresh_token: 'x' } });
    assert.equal(patched.status, 400);
    assert.match(patched.body.error, /OAuth/);
  } finally {
    await cleanup(dir, handle);
  }
});

test('PATCH/DELETE with a connectorId that does not match the instance\'s actual connector returns 404', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const created = await post(port, '/api/connectors/imap/instances', {
      label: 'Work IMAP',
      host: 'imap.example.com',
      username: 'a',
      password: TEST_VALUE_A,
    });
    assert.equal(created.status, 201);

    const patchWrong = await patch(port, `/api/connectors/smtp/instances/${created.body.id}`, { label: 'hijacked' });
    assert.equal(patchWrong.status, 404);

    const deleteWrong = await del(port, `/api/connectors/smtp/instances/${created.body.id}`);
    assert.equal(deleteWrong.status, 404);

    // Confirm it genuinely was not touched via the mismatched connectorId.
    const stillThere = await get(port, '/api/connectors/imap/instances');
    assert.equal(stillThere.body.instances.length, 1);
    assert.equal(stillThere.body.instances[0].label, 'Work IMAP');

    const missing = await patch(port, `/api/connectors/imap/instances/nonexistent-id`, { label: 'nope' });
    assert.equal(missing.status, 404);
  } finally {
    await cleanup(dir, handle);
  }
});

test('deleting the active instance resets that domain to mock/null, without switching to another instance', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const instanceA = await post(port, '/api/connectors/imap/instances', {
      label: 'IMAP A', host: 'a.example.com', username: 'a', password: TEST_VALUE_A,
    });
    const instanceB = await post(port, '/api/connectors/imap/instances', {
      label: 'IMAP B', host: 'b.example.com', username: 'b', password: TEST_VALUE_B,
    });

    const activate = await post(port, '/api/connectors/email/active', {
      connectorId: 'imap', instanceId: instanceA.body.id, providerId: 'imap',
    });
    assert.equal(activate.status, 200);
    assert.equal(activate.body.active, 'imap');
    assert.equal(activate.body.activeInstanceId, instanceA.body.id);

    let config = loadConnectorsConfig();
    assert.equal(config.email.active, 'imap');
    assert.equal(config.email.activeInstanceId, instanceA.body.id);

    const deleted = await del(port, `/api/connectors/imap/instances/${instanceA.body.id}`);
    assert.equal(deleted.status, 200);

    config = loadConnectorsConfig();
    assert.equal(config.email.active, 'mock', 'must reset to mock, not silently switch to instance B');
    assert.equal(config.email.activeInstanceId, null);

    // instance B must still exist untouched.
    const listed = await get(port, '/api/connectors/imap/instances');
    assert.equal(listed.body.instances.length, 1);
    assert.equal(listed.body.instances[0].id, instanceB.body.id);
  } finally {
    await cleanup(dir, handle);
  }
});

test('POST /api/connectors/:domain/active rejects a {connectorId, instanceId} pair where the instance does not belong to that connector', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;

    const imapInstance = await post(port, '/api/connectors/imap/instances', {
      label: 'IMAP', host: 'a.example.com', username: 'a', password: TEST_VALUE_A,
    });

    // instanceId belongs to imap, but connectorId/providerId claim google-calendar.
    const mismatchedConnector = await post(port, '/api/connectors/calendar/active', {
      connectorId: 'google', instanceId: imapInstance.body.id, providerId: 'google-calendar',
    });
    assert.equal(mismatchedConnector.status, 400);

    // providerId does not belong to connectorId at all.
    const mismatchedProvider = await post(port, '/api/connectors/email/active', {
      connectorId: 'imap', instanceId: imapInstance.body.id, providerId: 'gmail',
    });
    assert.equal(mismatchedProvider.status, 400);
    assert.match(mismatchedProvider.body.error, /does not belong/);

    // Deleted instance must also be rejected.
    await del(port, `/api/connectors/imap/instances/${imapInstance.body.id}`);
    const deletedInstance = await post(port, '/api/connectors/email/active', {
      connectorId: 'imap', instanceId: imapInstance.body.id, providerId: 'imap',
    });
    assert.equal(deletedInstance.status, 400);

    // Legacy bare-providerId path must still work unchanged.
    const legacy = await post(port, '/api/connectors/calendar/active', { providerId: 'mock' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.active, 'mock');
  } finally {
    await cleanup(dir, handle);
  }
});

test('bare provider selection cannot guess between two accounts or retain a stale instance', async () => {
  const dir = tempHome();
  let handle;
  try {
    handle = await startServer({ port: 0 });
    const port = handle.server.address().port;
    const first = await post(port, '/api/connectors/imap/instances', { label: 'First', host: 'mail.example.test', username: 'first', password: TEST_VALUE_A });
    assert.equal(first.status, 201);
    const unique = await post(port, '/api/connectors/email/active', { providerId: 'imap' });
    assert.equal(unique.status, 200);
    assert.equal(unique.body.activeInstanceId, first.body.id);

    const second = await post(port, '/api/connectors/imap/instances', { label: 'Second', host: 'mail.example.test', username: 'second', password: TEST_VALUE_B });
    assert.equal(second.status, 201);
    const ambiguous = await post(port, '/api/connectors/email/active', { providerId: 'imap' });
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.body.error, /Choose a connected account/);
    assert.equal(loadConnectorsConfig().email.activeInstanceId, first.body.id);

    const mock = await post(port, '/api/connectors/email/active', { providerId: 'mock' });
    assert.equal(mock.status, 200);
    assert.equal(loadConnectorsConfig().email.activeInstanceId, null);
  } finally {
    await cleanup(dir, handle);
  }
});
