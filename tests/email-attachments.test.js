import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { getDb, closeAllForTests } from '../server/db/connection.js';
import { createConnectionInstance, findInstance } from '../server/integrations/connection-instances.js';
import { sendEmail as smtpSend } from '../server/integrations/smtp-transport.js';
import { sendEmail as gmailSend } from '../server/integrations/gmail-provider.js';
import { storeTokens } from '../server/integrations/oauth/google-oauth.js';
import { EmailSendTool } from '../server/tools/email-tools.js';
import { assertAttachmentRefs, describeAttachments, resolveAttachment, resolveAttachments, safeFilename, stageAttachment } from '../server/tools/email-attachments.js';
import { validatePlan } from '../server/agent/plan-validator.js';
import { ToolRegistry } from '../server/tools/registry.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'u2os-att-'));
  const vault = path.join(home, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  process.env.U2OS_HOME = home;
  process.env.U2OS_VAULT = vault;
  const source = path.join(home, 'resume.pdf');
  fs.writeFileSync(source, PDF);
  return { home, vault, source, done() { closeAllForTests(); delete process.env.U2OS_HOME; delete process.env.U2OS_VAULT; fs.rmSync(home, { recursive: true, force: true }); } };
}

test('staging is content-addressed and idempotent; references verify the content', () => {
  const w = world();
  try {
    const a = stageAttachment(w.vault, w.source, { name: 'Pat Example Resume.pdf' });
    assert.match(a.ref, /^outbox\/[0-9a-f]{64}\/Pat Example Resume\.pdf$/);
    assert.equal(stageAttachment(w.vault, w.source, { name: 'Pat Example Resume.pdf' }).ref, a.ref);
    const resolved = resolveAttachment(w.vault, a.ref);
    assert.deepEqual(resolved.content, PDF);
    assert.equal(resolved.contentType, 'application/pdf');
    assert.deepEqual(Object.keys(describeAttachments([resolved])[0]).sort(), ['bytes', 'contentType', 'filename', 'sha256'], 'no content in the description');
  } finally { w.done(); }
});

test('a changed, replaced, missing, linked or traversing attachment fails closed', () => {
  const w = world();
  try {
    const { ref } = stageAttachment(w.vault, w.source);
    const file = path.join(w.vault, ref);
    fs.writeFileSync(file, 'tampered after approval');
    assert.throws(() => resolveAttachment(w.vault, ref), /changed after it was staged/);
    fs.rmSync(file);
    assert.throws(() => resolveAttachment(w.vault, ref), /not staged/);
    // A symlink to a secret, placed where a staged file should be, is refused even though the name matches.
    const secret = path.join(w.home, 'secret.pdf');
    fs.writeFileSync(secret, PDF);
    fs.symlinkSync(secret, file);
    assert.throws(() => resolveAttachment(w.vault, ref), /not a regular staged file/);
    for (const bad of ['/etc/passwd', '../../etc/passwd', 'outbox/../../etc/passwd', `outbox/${'a'.repeat(64)}/../x.pdf`, `outbox/${'a'.repeat(63)}/x.pdf`, 'resume.pdf', `outbox/${'a'.repeat(64)}/.hidden`, `outbox/${'a'.repeat(64)}/a/b.pdf`]) {
      assert.throws(() => resolveAttachment(w.vault, bad), /not a valid staged attachment reference/, bad);
    }
  } finally { w.done(); }
});

test('limits and types: only documents, at most three, no duplicates, nothing oversized', () => {
  const w = world();
  try {
    const exe = path.join(w.home, 'run.sh'); fs.writeFileSync(exe, '#!/bin/sh');
    assert.throws(() => stageAttachment(w.vault, exe), /cannot be attached/);
    const big = path.join(w.home, 'big.pdf'); fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.throws(() => stageAttachment(w.vault, big), /larger than 10 MB/);
    const ref = stageAttachment(w.vault, w.source).ref;
    assert.throws(() => assertAttachmentRefs([]), /1 to 3/);
    assert.throws(() => assertAttachmentRefs([ref, ref]), /twice/);
    assert.throws(() => assertAttachmentRefs([ref, ref + '1', ref + '2', ref + '3']), /1 to 3/);
    assert.throws(() => assertAttachmentRefs('outbox/x'), /1 to 3/);
    assert.equal(safeFilename('../../etc/pass"wd\r\n.pdf'), 'pass_wd_.pdf');
    assert.equal(resolveAttachments(w.vault, [ref]).length, 1);
  } finally { w.done(); }
});

test('Gmail: builds a real multipart message with a UTF-8 subject and body and the exact bytes', async () => {
  const w = world();
  try {
    const instance = { id: 'conn_test_gmail', vault_key: 'google__conn_test_gmail', metadata: '{}' };
    storeTokens(instance.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, w.home);
    const staged = stageAttachment(w.vault, w.source, { name: 'Resume.pdf' });
    let raw;
    const fetchImpl = async (url, options) => { raw = JSON.parse(options.body).raw; return new Response(JSON.stringify({ id: 'sent1', threadId: 't1' }), { status: 200 }); };
    await gmailSend({ to: 'dylan@example.test', subject: 'Résumé: Head of Engineering', body: 'Hi — résumé attached.\n\nChristopher', attachments: resolveAttachments(w.vault, [staged.ref]) }, { fetchImpl, dataDir: w.home, instance });
    const parsed = await simpleParser(Buffer.from(raw, 'base64url'));
    assert.equal(parsed.subject, 'Résumé: Head of Engineering');
    assert.equal(parsed.text.trim(), 'Hi — résumé attached.\n\nChristopher');
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].filename, 'Resume.pdf');
    assert.equal(parsed.attachments[0].contentType, 'application/pdf');
    assert.deepEqual(parsed.attachments[0].content, PDF);
  } finally { w.done(); }
});

test('Gmail: header injection is still refused with attachments, and plain messages are unchanged', async () => {
  const w = world();
  try {
    const instance = { id: 'conn_test_gmail', vault_key: 'google__conn_test_gmail', metadata: '{}' };
    storeTokens(instance.vault_key, 'gmail', { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, w.home);
    const attachments = resolveAttachments(w.vault, [stageAttachment(w.vault, w.source).ref]);
    const never = async () => { throw new Error('fetch must not be called'); };
    await assert.rejects(gmailSend({ to: 'a@b.test', subject: 'x\r\nBcc: evil@example.test', body: 'b', attachments }, { fetchImpl: never, dataDir: w.home, instance }), /line breaks/);
    await assert.rejects(gmailSend({ to: 'a@b.test', subject: 'x', body: 'b', attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', content: 'not a buffer' }] }, { fetchImpl: never, dataDir: w.home, instance }), /invalid attachments/);
    let raw;
    await gmailSend({ to: 'a@b.test', subject: 'Plain', body: 'Body' }, { fetchImpl: async (u, o) => { raw = JSON.parse(o.body).raw; return new Response(JSON.stringify({ id: 's', threadId: 't' }), { status: 200 }); }, dataDir: w.home, instance });
    assert.equal(Buffer.from(raw, 'base64url').toString(), 'To: a@b.test\r\nSubject: Plain\r\n\r\nBody');
  } finally { w.done(); }
});

test('SMTP: delivers the attachment to a real capture server', async () => {
  const w = world();
  const messages = [];
  const server = new SMTPServer({
    secure: false, disabledCommands: ['STARTTLS'], logger: false,
    onAuth(auth, session, callback) { callback(null, { user: auth.username }); },
    onData(stream, session, callback) { const chunks = []; stream.on('data', (c) => chunks.push(c)); stream.on('end', () => { messages.push(Buffer.concat(chunks)); callback(); }); },
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.server.address().port;
    const sender = createConnectionInstance(getDb(), { connectorId: 'smtp', label: 'S', status: 'connected', credentials: { host: 'smtp.example.test', port: 465, username: 'owner', password: 'pw', from: 'owner@example.test' }, dataDir: w.home });
    const nodemailer = (await import('nodemailer')).default;
    const attachments = resolveAttachments(w.vault, [stageAttachment(w.vault, w.source).ref]);
    await smtpSend({ to: 'alice@example.test', subject: 'Hello', body: 'With file', attachments }, {
      dataDir: w.home, instance: findInstance(getDb(), 'smtp', sender.id),
      transportFactory: (config) => nodemailer.createTransport({ ...config, host: '127.0.0.1', port, secure: false, requireTLS: false, ignoreTLS: true, tls: undefined }),
    });
    const parsed = await simpleParser(messages[0]);
    assert.equal(parsed.attachments[0].filename, 'resume.pdf');
    assert.deepEqual(parsed.attachments[0].content, PDF);
    await assert.rejects(smtpSend({ to: 'alice@example.test', subject: 'x', body: 'y', attachments: [{ filename: '../x.pdf', contentType: 'application/pdf', content: PDF }] }, { dataDir: w.home, instance: findInstance(getDb(), 'smtp', sender.id) }), /invalid attachments/);
  } finally { await new Promise((resolve) => server.close(resolve)); w.done(); }
});

test('email.send: verifies attachments before anything is sent and records only metadata', async () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.home, 'config'), { recursive: true });
    fs.writeFileSync(path.join(w.home, 'config', 'installation.json'), JSON.stringify({ mode: 'demo' }));
    const tool = new EmailSendTool();
    const events = [];
    const context = { accountBinding: { domain: 'email', providerId: 'mock', instanceId: null, connectorId: null }, eventBus: { publish: (event) => events.push(event) }, actor: { type: 'user', id: 'owner' }, correlationId: 'c1' };
    const { ref } = stageAttachment(w.vault, w.source);
    const sent = await tool.execute({ to: 'dylan@example.test', subject: 'Hi', body: 'Resume attached', attachments: [ref] }, context);
    assert.equal(sent.attachments[0].filename, 'resume.pdf');
    assert.equal(sent.attachments[0].content, undefined);
    assert.equal(events[0].type, 'email.sent');
    assert.equal(events[0].data.attachments[0].sha256, ref.split('/')[1]);

    fs.writeFileSync(path.join(w.vault, ref), 'swapped after approval');
    const before = getDb().prepare("SELECT COUNT(*) AS n FROM emails WHERE folder = 'sent'").get().n;
    await assert.rejects(tool.execute({ to: 'dylan@example.test', subject: 'Hi', body: 'x', attachments: [ref] }, context), /changed after it was staged/);
    await assert.rejects(tool.execute({ to: 'dylan@example.test', subject: 'Hi', body: 'x', attachments: ['/Users/owner/.ssh/id_rsa'] }, context), /not a valid staged attachment reference|staged reference/);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM emails WHERE folder = 'sent'").get().n, before, 'nothing was sent');
    assert.equal(events.length, 1);
    assert.equal(tool.category, 'consequential');
  } finally { w.done(); }
});

test('a planned email.send with a file path is rejected at plan time', () => {
  const registry = new ToolRegistry();
  registry.register(new EmailSendTool());
  const plan = (attachments) => ({ reasoning_summary: 'x', actions: [{ tool: 'email.send', arguments: { to: 'a@b.test', subject: 's', body: 'b', attachments } }] });
  assert.throws(() => validatePlan(plan(['/etc/passwd']), registry), /file paths are not accepted/);
  assert.throws(() => validatePlan(plan('outbox/x'), registry), /must be array/);
  assert.doesNotThrow(() => validatePlan(plan([`outbox/${'a'.repeat(64)}/resume.pdf`]), registry));
});
