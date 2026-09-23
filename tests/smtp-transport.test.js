import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance, findInstance } from '../server/integrations/connection-instances.js';
import { validateSettings, sendEmail } from '../server/integrations/smtp-transport.js';
import { EmailSendTool } from '../server/tools/email-tools.js';
import { PolicyEngine } from '../server/policy/policy-engine.js';
import { classifyActionError } from '../server/agent/action-error-classifier.js';
import { sendEmail as sendImapEmail } from '../server/integrations/imap-provider.js';
import { associateSmtpInstance } from '../server/integrations/connection-instances.js';

function withHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-smtp-test-'));
  process.env.U2OS_HOME = dir;
  return dir;
}
function cleanup(dir) {
  closeAllForTests();
  delete process.env.U2OS_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('SMTP settings require encrypted transport ports and safe sender', () => {
  assert.throws(() => validateSettings({ host: 'mail.example.com', port: 25, username: 'owner', password: 'x', from: 'owner@example.com' }), /port/);
  assert.throws(() => validateSettings({ host: 'mail.example.com', port: 465, username: 'owner', password: 'x', from: 'owner@example.com\r\nBcc: hidden@example.com' }), /From/);
});

test('SMTP-backed email.send remains a consequential action requiring approval', () => {
  const tool = new EmailSendTool();
  assert.equal(tool.category, 'consequential');
  const decision = new PolicyEngine({ policies: { email: { send: 'confirm' } } }).evaluate({ tool, arguments: { to: 'alice@example.test' } });
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.blocked, false);
});

test('SMTP sends one plain-text message to a local capture server and records it', async () => {
  const dir = withHome();
  const messages = [];
  const server = new SMTPServer({
    secure: false, disabledCommands: ['STARTTLS'], logger: false,
    onAuth(auth, session, callback) { callback(null, { user: auth.username }); },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => { messages.push(Buffer.concat(chunks).toString('utf8')); callback(); });
    },
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localPort = server.server.address().port;
    const sender = createConnectionInstance(getDb(), { connectorId: 'smtp', label: 'Sender', status: 'connected', credentials: { host: 'smtp.example.test', port: 465, username: 'owner', password: 'private-password', from: 'owner@example.test' }, dataDir: dir });
    const row = await sendEmail({ to: 'alice@example.test', subject: 'Project update', body: 'Status is green.' }, {
      dataDir: dir,
      instance: findInstance(getDb(), 'smtp', sender.id),
      transportFactory: (config) => {
        assert.equal(config.secure, true);
        assert.equal(config.tls.rejectUnauthorized, true);
        assert.equal(config.auth.pass, 'private-password');
        return nodemailer.createTransport({ ...config, host: '127.0.0.1', port: localPort, secure: false, requireTLS: false });
      },
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Subject: Project update/);
    assert.match(messages[0], /Status is green/);
    assert.equal(row.folder, 'sent');
    assert.equal(getDb().prepare('SELECT count(*) AS n FROM emails WHERE id = ?').get(row.id).n, 1);
    assert.doesNotMatch(JSON.stringify(row), /private-password/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup(dir);
  }
});

test('SMTP rejects header injection and sanitizes uncertain delivery errors', async () => {
  const dir = withHome();
  try {
    const sender = createConnectionInstance(getDb(), { connectorId: 'smtp', label: 'Sender', status: 'connected', credentials: { host: 'smtp.example.test', port: 587, username: 'owner', password: 'private-password', from: 'owner@example.test' }, dataDir: dir });
    let called = false;
    const transportFactory = (config) => {
      assert.equal(config.requireTLS, true);
      called = true;
      return { async sendMail() { throw new Error('private-password in provider response'); }, close() {} };
    };
    const options = { dataDir: dir, instance: findInstance(getDb(), 'smtp', sender.id), transportFactory };
    await assert.rejects(sendEmail({ to: 'a@example.test\r\nBcc: b@example.test', subject: 'x', body: 'x' }, options), /invalid recipients/);
    assert.equal(called, false);
    await assert.rejects(sendEmail({ to: 'a@example.test', subject: 'x\r\nBcc: b@example.test', body: 'x' }, options), /invalid subject/);
    assert.equal(called, false);
    await assert.rejects(sendEmail({ to: 'a@example.test', subject: 'x', body: 'x' }, options),
      (err) => !err.message.includes('private-password') && /uncertain/.test(err.message)
        && classifyActionError(err) === 'owner_attention_required');
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM emails WHERE folder = 'sent'").get().n, 0);
  } finally { cleanup(dir); }
});

test('two IMAP accounts send through their explicitly paired SMTP identities', async () => {
  const dir = withHome();
  try {
    const db = getDb();
    const sent = [];
    const transportFactory = (config) => ({
      async sendMail(message) { sent.push({ user: config.auth.user, from: message.from }); return { accepted: [message.to[0]], rejected: [] }; },
      close() {},
    });
    for (const account of ['one', 'two']) {
      const imap = createConnectionInstance(db, { connectorId: 'imap', label: account, status: 'connected', credentials: { host: 'imap.example.test', port: 993, username: `${account}@example.test`, password: 'fixture' }, dataDir: dir });
      const smtp = createConnectionInstance(db, { connectorId: 'smtp', label: account, status: 'connected', credentials: { host: 'smtp.example.test', port: 587, username: `${account}@example.test`, password: 'fixture', from: `${account}@example.test` }, dataDir: dir });
      associateSmtpInstance(db, { imapRow: findInstance(db, 'imap', imap.id), smtpInstanceId: smtp.id });
      await sendImapEmail({ to: 'fixture@example.test', subject: 'Fixture', body: 'Fixture' }, {
        instance: findInstance(db, 'imap', imap.id), smtpIdentity: { instanceId: smtp.id, credentialRevision: findInstance(db, 'smtp', smtp.id).credential_revision },
        transportFactory, dataDir: dir, db,
      });
    }
    assert.deepEqual(sent, [
      { user: 'one@example.test', from: 'one@example.test' },
      { user: 'two@example.test', from: 'two@example.test' },
    ]);
  } finally { cleanup(dir); }
});
