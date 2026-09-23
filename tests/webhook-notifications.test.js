import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { send } from '../server/integrations/webhook-notify-provider.js';
import { NotificationsSendTool } from '../server/tools/notification-tools.js';
import { setActiveProvider } from '../server/integrations/connectors-config.js';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance } from '../server/integrations/connection-instances.js';

// issue #163 PR 4: webhook-notify-provider.js is instance-aware -- send()
// reads its stored webhook config from a resolved connection instance's own
// vault_key, not a hardcoded 'notify-webhook' key. tempHome() creates a REAL
// connection_instances row (via createConnectionInstance(), same as the
// instance CRUD API) and returns its raw row alongside `dir` -- direct
// send() calls pass that row as `instance`, and the NotificationsSendTool
// test (which goes through provider-registry.js's getProvider()) relies on
// its "exactly one connected instance" fallback to resolve the very same
// row with no explicit activeInstanceId needed.
function tempHome(format = 'json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-notify-test-'));
  process.env.U2OS_HOME = dir;
  const db = getDb();
  const created = createConnectionInstance(db, {
    connectorId: 'webhook',
    label: 'Test webhook',
    credentials: { webhookUrl: 'https://notify.example.test/private-topic-token', format },
    status: 'connected',
    dataDir: dir,
  });
  const instance = db.prepare('SELECT * FROM connection_instances WHERE id = ?').get(created.id);
  return { dir, instance };
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('JSON webhook delivery uses the documented request contract', async () => {
  const { dir, instance } = tempHome();
  try {
    let request;
    const result = await send(
      { title: 'Daily briefing', body: 'Two items need attention.', priority: 'high' },
      { dataDir: dir, instance, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 204 }; } }
    );

    assert.equal(request.url, 'https://notify.example.test/private-topic-token');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), { title: 'Daily briefing', body: 'Two items need attention.', priority: 'high' });
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.equal(result.title, 'Daily briefing');
    assert.ok(result.sentAt);
  } finally { cleanup(dir); }
});

test('ntfy delivery maps priority and sends the message as plain text', async () => {
  const { dir, instance } = tempHome('ntfy');
  try {
    let options;
    await send(
      { title: 'Urgent', body: 'Call back now', priority: 'urgent' },
      { dataDir: dir, instance, fetchImpl: async (_url, value) => { options = value; return { ok: true, status: 200 }; } }
    );
    assert.deepEqual(options.headers, { Title: 'Urgent', Priority: '5' });
    assert.equal(options.body, 'Call back now');
  } finally { cleanup(dir); }
});

test('provider errors are bounded and never disclose the credential-bearing webhook URL', async () => {
  const { dir, instance } = tempHome();
  try {
    const secretUrl = 'https://notify.example.test/private-topic-token';
    await assert.rejects(
      send({ title: 'x', body: 'y' }, { dataDir: dir, instance, fetchImpl: async () => { throw new Error(`connect failed for ${secretUrl}`); } }),
      (error) => error.message === 'webhook-notify: delivery failed' && !error.message.includes('private-topic-token')
    );

    await assert.rejects(
      send({ title: 'x', body: 'y' }, { dataDir: dir, instance, fetchImpl: async () => ({ ok: false, status: 503 }) }),
      (error) => error.status === 503 && error.message === 'webhook-notify: send failed (status 503)'
    );

    await assert.rejects(
      send({ title: 'x', body: 'y' }, {
        dataDir: dir,
        instance,
        timeoutMs: 5,
        fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      }),
      (error) => error.code === 'ETIMEDOUT' && error.message === 'webhook-notify: delivery timed out'
    );
  } finally { cleanup(dir); }
});

test('notifications tool emits success only after real delivery succeeds', async () => {
  const { dir } = tempHome();
  const originalFetch = globalThis.fetch;
  try {
    setActiveProvider('notifications', 'webhook');
    globalThis.fetch = async () => { throw new Error('network failed at private-topic-token'); };
    const events = [];
    const tool = new NotificationsSendTool();
    await assert.rejects(
      tool.execute({ title: 'x', body: 'y' }, { eventBus: { publish: (event) => events.push(event) }, actor: { type: 'owner' }, correlationId: 'corr_1' }),
      /delivery failed/
    );
    assert.deepEqual(events, []);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(dir);
  }
});
