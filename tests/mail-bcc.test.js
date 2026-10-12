import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerBcc, parseBcc } from '../server/tools/mail-bcc.js';
import { sendEmail } from '../server/integrations/gmail-provider.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { closeAllForTests } from '../server/db/connection.js';

test('the Bcc comes from the environment, then config.json; a bad value is an error, not a silent skip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-bcc-'));
  fs.mkdirSync(path.join(dir, 'config'));
  assert.equal(ownerBcc({ env: {}, dataDir: dir }), null);
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ mailBcc: ' me@example.test ' }));
  assert.equal(ownerBcc({ env: {}, dataDir: dir }), 'me@example.test');
  assert.equal(ownerBcc({ env: { U2OS_MAIL_BCC: 'env@example.test' }, dataDir: dir }), 'env@example.test');
  assert.throws(() => ownerBcc({ env: { U2OS_MAIL_BCC: 'a@b.test, c@d.test' }, dataDir: dir }), /one valid email/);
  assert.throws(() => parseBcc('x@y.test\nBcc: z@y.test'), /one valid email/);
  assert.equal(parseBcc(''), null);
});

test('Gmail raw messages carry the Bcc header, plain and with attachments, and none when unset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-bcc-gmail-'));
  process.env.U2OS_HOME = dir;
  try {
    const instance = { id: 'conn_test_gmail', vault_key: 'google__conn_test_gmail', metadata: JSON.stringify({}) };
    storeTokens(instance.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, dir);
    const raws = [];
    const fetchImpl = async (url, init) => { raws.push(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8')); return new Response(JSON.stringify({ id: `m${raws.length}`, threadId: 't1' }), { status: 200 }); };
    const options = { fetchImpl, dataDir: dir, instance };
    await sendEmail({ to: 'a@b.test', bcc: 'me@example.test', subject: 'Hi', body: 'Body' }, options);
    await sendEmail({ to: 'a@b.test', bcc: 'me@example.test', subject: 'Hi', body: 'Body', attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') }] }, options);
    await sendEmail({ to: 'a@b.test', subject: 'Hi', body: 'Body' }, options);
    assert.match(raws[0], /^To: a@b.test\r\nBcc: me@example.test\r\nSubject: Hi/);
    assert.match(raws[1], /\r\nBcc: me@example.test\r\n/);
    assert.doesNotMatch(raws[2], /Bcc:/i);
    await assert.rejects(sendEmail({ to: 'a@b.test', bcc: 'me@example.test\r\nX: y', subject: 'Hi', body: 'Body' }, options), /line breaks/);
  } finally {
    closeAllForTests(); delete process.env.U2OS_HOME; fs.rmSync(dir, { recursive: true, force: true });
  }
});
