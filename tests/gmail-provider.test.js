import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendEmail } from '../server/integrations/gmail-provider.js';
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

test('sendEmail rejects a CRLF-injected header in "to" before ever calling fetch', async () => {
  const dir = tempHome();
  try {
    storeTokens('google', 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    await assert.rejects(
      () =>
        sendEmail(
          { to: 'victim@example.com\r\nBcc: attacker@evil.example', subject: 'hello', body: 'hi' },
          { fetchImpl: neverCalledFetch(), dataDir: dir }
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
    storeTokens('google', 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    await assert.rejects(
      () =>
        sendEmail(
          { to: 'victim@example.com', subject: 'hello\r\nBcc: attacker@evil.example', body: 'hi' },
          { fetchImpl: neverCalledFetch(), dataDir: dir }
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
    storeTokens('google', 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg123', threadId: 'thread123' }),
    });

    const result = await sendEmail(
      { to: 'friend@example.com', subject: 'A normal subject', body: 'Hello!' },
      { fetchImpl, dataDir: dir }
    );
    assert.equal(result.subject, 'A normal subject');
    assert.equal(result.folder, 'sent');
  } finally {
    cleanup(dir);
  }
});
