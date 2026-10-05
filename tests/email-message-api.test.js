import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllForTests } from '../server/db/connection.js';
import { startServer } from './helpers/authed-server.js';
import { getDb } from '../server/db/connection.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-email-api-'));
  process.env.U2OS_HOME = path.join(dir, 'home');
  process.env.U2OS_VAULT = path.join(dir, 'vault');
  const handle = await startServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${handle.port}`;
  return { get: (url) => fetch(`${base}${url}`) };
}

function insert(id, from) {
  getDb().prepare(`INSERT INTO emails (id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, from, JSON.stringify(['chris@example.com']), 'Hello', 'private body text', 'inbox', 0, '2026-10-05T14:00:00Z', '2026-10-05T14:00:00Z');
}

test('one message is returned with a verified sender address and its provider kind', async (t) => {
  const { get } = await fixture(t);
  insert('gmail_x_1', 'Sarah Chen <sarah@example.com>');
  insert('imap_y_2', 'bob@example.com');
  insert('email_z_3', 'weird <a@b.com>, other <c@d.com>');

  const gmail = (await (await get('/api/email/gmail_x_1')).json()).email;
  assert.equal(gmail.provider, 'gmail');
  assert.equal(gmail.sender_address, 'sarah@example.com');
  assert.equal(gmail.body, 'private body text');
  assert.deepEqual(gmail.to_addr, ['chris@example.com']);

  assert.equal((await (await get('/api/email/imap_y_2')).json()).email.provider, 'imap');
  const other = (await (await get('/api/email/email_z_3')).json()).email;
  assert.equal(other.provider, 'other');
  assert.equal(other.sender_address, null, 'an ambiguous From header yields no reply address');
});

test('an unknown message is a 404', async (t) => {
  const { get } = await fixture(t);
  assert.equal((await get('/api/email/nope')).status, 404);
});
