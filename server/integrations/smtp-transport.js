// SMTP companion for the IMAP provider. Only an already policy-approved
// email.send reaches this module; delivery is never advertised as idempotent.
import nodemailer from 'nodemailer';
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { readEncryptedFile } from '../security/vault.js';

export function validateSettings(settings) {
  const { host, port = 465, username, password, from } = settings || {};
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) {
    throw new Error('smtp: a valid mail host is required');
  }
  if (![465, 587].includes(port)) throw new Error('smtp: port must be 465 or 587');
  if (typeof username !== 'string' || !username.trim() || username.length > 320) throw new Error('smtp: username is required');
  if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('smtp: app password is required');
  if (!validAddress(from)) throw new Error('smtp: a valid From address is required');
  return { host, port, username, password, from };
}

function validAddress(value) {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(value);
}

export function isConfigured(dataDir) {
  try { return !!validateSettings(readEncryptedFile('smtp', dataDir)); } catch { return false; }
}

function uncertainOutcome(message) {
  const error = new Error(message);
  error.ownerAttentionRequired = true;
  return error;
}

function validateMessage({ to, subject, body, inReplyTo } = {}) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length || recipients.length > 20 || !recipients.every(validAddress)) throw new Error('smtp: invalid recipients');
  if (typeof subject !== 'string' || subject.length > 1000 || /[\r\n]/.test(subject)) throw new Error('smtp: invalid subject');
  if (typeof body !== 'string' || body.length > 100000) throw new Error('smtp: invalid body');
  if (inReplyTo != null && (typeof inReplyTo !== 'string' || !/^<[A-Za-z0-9._@-]{1,300}>$/.test(inReplyTo))) {
    throw new Error('smtp: invalid In-Reply-To message id');
  }
  return { recipients, subject, body, inReplyTo: inReplyTo || undefined };
}

export async function sendEmail(message, { dataDir, transportFactory = (config) => nodemailer.createTransport(config), db = getDb() } = {}) {
  let settings;
  try { settings = validateSettings(readEncryptedFile('smtp', dataDir)); } catch { throw new Error('smtp: credentials are not configured'); }
  const { recipients, subject, body, inReplyTo } = validateMessage(message);
  let transport;
  try {
    transport = transportFactory({
      host: settings.host, port: settings.port, secure: settings.port === 465,
      requireTLS: settings.port === 587, tls: { rejectUnauthorized: true },
      auth: { user: settings.username, pass: settings.password },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      logger: false, debug: false,
    });
  } catch {
    throw new Error('smtp: transport setup failed');
  }
  let info;
  try {
    info = await transport.sendMail({ from: settings.from, to: recipients, subject, text: body, inReplyTo });
    if (info.rejected?.length || !info.accepted?.length) throw new Error('rejected');
  } catch {
    // An SMTP timeout can occur after acceptance. Do not reveal provider
    // frames or imply it is safe for a worker to replay the send.
    throw uncertainOutcome('smtp: delivery outcome is uncertain; review before retrying');
  } finally {
    transport.close?.();
  }
  const now = new Date().toISOString();
  const localId = newId('smtp');
  try {
    db.prepare(`INSERT INTO emails (id, thread_id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      localId, inReplyTo || null, settings.from, JSON.stringify(recipients), subject, body, 'sent', 1, now, now
    );
  } catch {
    throw uncertainOutcome('smtp: provider accepted the message but local recording failed; review before retrying');
  }
  return { id: localId, thread_id: inReplyTo || null, from_addr: settings.from, to_addr: recipients,
    subject, body, folder: 'sent', is_read: true, received_at: now, created_at: now };
}
