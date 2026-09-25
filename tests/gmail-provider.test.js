import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendEmail, listEmails } from '../server/integrations/gmail-provider.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { closeAllForTests } from '../server/db/connection.js';

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-gmail-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}

function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

function neverCalledFetch() {
  return async () => {
    throw new Error('fetch should never be called once header injection is detected');
  };
}

// issue #163 PR 4: gmail-provider.js is instance-aware -- every call needs a
// resolved connection instance (`.vault_key` for token storage, `.id`/
// `.metadata` for the local-id scoping rule in connector-instance-ids.js).
// These tests call sendEmail() directly (bypassing provider-registry.js's
// resolution), so they construct a minimal, non-grandfathered instance
// object themselves -- the same raw shape findInstance() would return.
const TEST_INSTANCE = { id: 'conn_test_gmail', vault_key: 'google__conn_test_gmail', metadata: JSON.stringify({}) };

test('selected Gmail account applies free-text query, folder, and result cap; full messages retain body', async () => {
  const dir = tempHome();
  try {
    storeTokens(TEST_INSTANCE.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, auth: options.headers.Authorization });
      if (url.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'one' }, { id: 'outside' }] }), { status: 200 });
      const inbox = url.includes('/one?');
      return new Response(JSON.stringify({ id: inbox ? 'one' : 'outside', labelIds: inbox ? ['INBOX'] : ['SENT'],
        payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Recruiter' }], body: { data: Buffer.from('Friday works').toString('base64url') } } }), { status: 200 });
    };
    const rows = await listEmails({ folder: 'inbox', query: 'recruiter' }, { fetchImpl, dataDir: dir, instance: TEST_INSTANCE });
    assert.deepEqual(rows.map((row) => row.id), [`gmail_${TEST_INSTANCE.id}_one`]);
    assert.equal(rows[0].body, 'Friday works');
    const searchUrl = new URL(calls[0].url);
    assert.equal(searchUrl.searchParams.get('q'), 'in:inbox recruiter');
    assert.equal(searchUrl.searchParams.get('maxResults'), '50');
    assert.ok(calls.every((call) => call.auth === 'Bearer AT'));
    assert.ok(calls.slice(1).every((call) => call.url.includes('format=full')));
  } finally { cleanup(dir); }
});

test('Gmail search uses only the selected instance even when upstream message ids collide', async () => {
  const dir = tempHome();
  try {
    const other = { id: 'conn_other', vault_key: 'google__conn_other', metadata: '{}' };
    storeTokens(TEST_INSTANCE.vault_key, 'gmail', { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 }, dir);
    storeTokens(other.vault_key, 'gmail', { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }, dir);
    const fetchImpl = async (url, options) => url.includes('/messages?')
      ? new Response(JSON.stringify({ messages: [{ id: 'same' }] }), { status: 200 })
      : new Response(JSON.stringify({ id: 'same', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: options.headers.Authorization === 'Bearer AT1' ? 'First account' : 'Second account' }] } }), { status: 200 });
    const first = await listEmails({ query: 'x' }, { fetchImpl, dataDir: dir, instance: TEST_INSTANCE });
    const second = await listEmails({ query: 'x' }, { fetchImpl, dataDir: dir, instance: other });
    assert.notEqual(first[0].id, second[0].id);
    assert.equal(first[0].subject, 'First account');
    assert.equal(second[0].subject, 'Second account');
  } finally { cleanup(dir); }
});

test('Gmail search rejects malformed input and fails if a result cannot be fetched', async () => {
  const dir = tempHome();
  try {
    storeTokens(TEST_INSTANCE.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    const fetchImpl = async (url) => url.includes('/messages?')
      ? new Response(JSON.stringify({ messages: [{ id: 'one' }] }), { status: 200 })
      : new Response('', { status: 503 });
    await assert.rejects(listEmails({ query: 'x'.repeat(257) }, { fetchImpl, dataDir: dir, instance: TEST_INSTANCE }), /at most 256/);
    await assert.rejects(listEmails({ folder: 'inbox OR in:sent' }, { fetchImpl, dataDir: dir, instance: TEST_INSTANCE }), /folder must/);
    await assert.rejects(listEmails({ query: 'x' }, { fetchImpl, dataDir: dir, instance: TEST_INSTANCE }), /message fetch failed/);
  } finally { cleanup(dir); }
});

test('Gmail search locally caps an oversized provider page', async () => {
  const dir = tempHome();
  try {
    storeTokens(TEST_INSTANCE.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    let details = 0;
    const fetchImpl = async (url) => {
      if (url.includes('/messages?')) return new Response(JSON.stringify({ messages: Array.from({ length: 60 }, (_, index) => ({ id: `m${index}` })) }), { status: 200 });
      details += 1;
      return new Response(JSON.stringify({ id: `m${details}`, labelIds: ['INBOX'], payload: { headers: [] } }), { status: 200 });
    };
    assert.equal((await listEmails({ query: 'x' }, { fetchImpl, dataDir: dir, instance: TEST_INSTANCE })).length, 50);
    assert.equal(details, 50);
  } finally { cleanup(dir); }
});

test('sendEmail rejects a CRLF-injected header in "to" before ever calling fetch', async () => {
  const dir = tempHome();
  try {
    storeTokens(TEST_INSTANCE.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    await assert.rejects(
      () =>
        sendEmail(
          { to: 'victim@example.com\r\nBcc: attacker@evil.example', subject: 'hello', body: 'hi' },
          { fetchImpl: neverCalledFetch(), dataDir: dir, instance: TEST_INSTANCE }
        ),
      /line breaks/
    );
  } finally {
    cleanup(dir);
  }
});

test('sendEmail rejects a CRLF-injected header in "subject" before ever calling fetch', async () => {
  const dir = tempHome();
  try {
    storeTokens(TEST_INSTANCE.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    await assert.rejects(
      () =>
        sendEmail(
          { to: 'victim@example.com', subject: 'hello\r\nBcc: attacker@evil.example', body: 'hi' },
          { fetchImpl: neverCalledFetch(), dataDir: dir, instance: TEST_INSTANCE }
        ),
      /line breaks/
    );
  } finally {
    cleanup(dir);
  }
});

test('sendEmail still sends normally when to/subject are clean', async () => {
  const dir = tempHome();
  try {
    storeTokens(TEST_INSTANCE.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg123', threadId: 'thread123' }),
    });

    const result = await sendEmail(
      { to: 'friend@example.com', subject: 'A normal subject', body: 'Hello!' },
      { fetchImpl, dataDir: dir, instance: TEST_INSTANCE }
    );
    assert.equal(result.subject, 'A normal subject');
    assert.equal(result.folder, 'sent');
    // Non-grandfathered instance -> instance-scoped local id.
    assert.equal(result.id, `gmail_${TEST_INSTANCE.id}_msg123`);
  } finally {
    cleanup(dir);
  }
});
