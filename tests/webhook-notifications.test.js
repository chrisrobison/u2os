import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { send } from '../server/integrations/webhook-notify-provider.js';
import { NotificationsSendTool } from '../server/tools/notification-tools.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { setActiveProvider } from '../server/integrations/connectors-config.js';
import { closeAllForTests } from '../server/db/connection.js';

function tempHome(format = 'json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-notify-test-'));
  process.env.U2OS_HOME = dir;
  writeEncryptedFile('notify-webhook', { webhookUrl: 'https://notify.example.test/private-topic-token', format }, dir);
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('JSON webhook delivery uses the documented request contract', async () => {
  const dir = tempHome();
  try {
    let request;
    const result = await send(
      { title: 'Daily briefing', body: 'Two items need attention.', priority: 'high' },
      { dataDir: dir, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 204 }; } }
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
  const dir = tempHome('ntfy');
  try {
    let options;
    await send(
      { title: 'Urgent', body: 'Call back now', priority: 'urgent' },
      { dataDir: dir, fetchImpl: async (_url, value) => { options = value; return { ok: true, status: 200 }; } }
    );
    assert.deepEqual(options.headers, { Title: 'Urgent', Priority: '5' });
    assert.equal(options.body, 'Call back now');
  } finally { cleanup(dir); }
});

test('provider errors are bounded and never disclose the credential-bearing webhook URL', async () => {
  const dir = tempHome();
  try {
    const secretUrl = 'https://notify.example.test/private-topic-token';
    await assert.rejects(
      send({ title: 'x', body: 'y' }, { dataDir: dir, fetchImpl: async () => { throw new Error(`connect failed for ${secretUrl}`); } }),
      (error) => error.message === 'webhook-notify: delivery failed' && !error.message.includes('private-topic-token')
    );

    await assert.rejects(
      send({ title: 'x', body: 'y' }, { dataDir: dir, fetchImpl: async () => ({ ok: false, status: 503 }) }),
      (error) => error.status === 503 && error.message === 'webhook-notify: send failed (status 503)'
    );

    await assert.rejects(
      send({ title: 'x', body: 'y' }, {
        dataDir: dir,
        timeoutMs: 5,
        fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      }),
      (error) => error.code === 'ETIMEDOUT' && error.message === 'webhook-notify: delivery timed out'
    );
  } finally { cleanup(dir); }
});

test('notifications tool emits success only after real delivery succeeds', async () => {
  const dir = tempHome();
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
