import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { writeEncryptedFile } from '../server/security/vault.js';
import { setActiveProvider } from '../server/integrations/connectors-config.js';
import { getProvider } from '../server/integrations/provider-registry.js';
import { syncChanges, listEmails, getEmail, validateSettings } from '../server/integrations/imap-provider.js';
import { EmailSendTool } from '../server/tools/email-tools.js';

function withHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-imap-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function fakeClient() {
  const calls = [];
  const client = {
    usable: true,
    mailbox: { exists: 1, uidValidity: 42n },
    async connect() { calls.push('connect'); },
    async getMailboxLock(name, options) {
      calls.push([name, options]);
      return { release() { calls.push('release'); } };
    },
    async *fetch() {
      calls.push('fetch');
      yield { uid: 9, size: 150, flags: new Set(), envelope: { date: new Date('2026-09-20T12:00:00Z') } };
    },
    async fetchOne(uid, query, options) {
      calls.push([uid, query, options]);
      return { source: Buffer.from('From: Alice <alice@example.com>\r\nTo: Owner <owner@example.com>\r\nSubject: Project update\r\nDate: Sun, 20 Sep 2026 12:00:00 +0000\r\nMessage-ID: <test@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nStatus is green.') };
    },
    async logout() { calls.push('logout'); },
  };
  return { client, calls };
}

test('IMAP settings require TLS and never accept an insecure port', () => {
  assert.throws(() => validateSettings({ host: 'mail.example.com', port: 143, username: 'owner', password: 'secret' }), /993/);
  assert.throws(() => validateSettings({ host: 'https://mail.example.com', username: 'owner', password: 'secret' }), /host/);
});

test('IMAP sync is bounded, idempotent, and mirrors parsed inbox mail without credentials in events', async () => {
  const dir = withHome();
  try {
    const settings = { host: 'mail.example.com', port: 993, username: 'owner@example.com', password: 'private-password' };
    writeEncryptedFile('imap', settings, dir);
    setActiveProvider('email', 'imap', dir);
    assert.equal(getProvider('email', { dataDir: dir }).id, 'imap');
    const db = getDb();
    const published = [];
    const eventBus = { publish(event) { published.push(event); } };
    const { client, calls } = fakeClient();
    const options = { db, eventBus, dataDir: dir, clientFactory: (config) => {
      assert.equal(config.secure, true);
      assert.equal(config.port, 993);
      assert.equal(config.auth.pass, 'private-password');
      return client;
    } };
    assert.deepEqual(await syncChanges(options), { synced: 1 });
    assert.deepEqual(await syncChanges(options), { synced: 0 });
    assert.equal(published.length, 1);
    assert.equal(published[0].source, 'imap');
    assert.doesNotMatch(JSON.stringify(published), /private-password/);
    assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === 9).length, 1);
    const rows = await listEmails({}, options);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, 'Project update');
    assert.equal(rows[0].body.trim(), 'Status is green.');
    assert.equal((await getEmail(rows[0].id, { dataDir: dir })).id, rows[0].id);
  } finally { cleanup(dir); }
});

test('IMAP-selected email.send never silently falls back to mock delivery', async () => {
  const dir = withHome();
  try {
    setActiveProvider('email', 'imap', dir);
    await assert.rejects(new EmailSendTool().execute({ to: 'a@example.com', subject: 'x', body: 'x' }), /not connected/);
    writeEncryptedFile('imap', { host: 'mail.example.com', port: 993, username: 'owner', password: 'secret' }, dir);
    await assert.rejects(new EmailSendTool().execute({ to: 'a@example.com', subject: 'x', body: 'x' }), /smtp: credentials/);
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM emails WHERE folder = 'sent'").get().n, 0);
  } finally { cleanup(dir); }
});
