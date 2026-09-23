// TLS-only IMAP inbox mirror. The local emails table remains the read model;
// no IMAP operation sends mail or silently falls back to mock delivery.
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb } from '../db/connection.js';
import { readEncryptedFile } from '../security/vault.js';
import { sendEmail as sendViaSmtp } from './smtp-transport.js';

export const id = 'imap';
const MAX_RECENT = 50;
const MAX_SOURCE_BYTES = 512 * 1024;

export function validateSettings(settings) {
  const { host, port = 993, username, password } = settings || {};
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) {
    throw new Error('imap: a valid mail host is required');
  }
  if (port !== 993) throw new Error('imap: only TLS port 993 is supported');
  if (typeof username !== 'string' || !username.trim() || username.length > 320) throw new Error('imap: username is required');
  if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('imap: app password is required');
  return { host, port, username, password };
}

/** `vaultKey` identifies which `imap` connection instance to check (issue
 * #163 PR 4) -- required, no default, so a caller can never silently check
 * the wrong account. */
export function isConnected(vaultKey, dataDir) {
  try { return !!validateSettings(readEncryptedFile(vaultKey, dataDir)); } catch { return false; }
}

function accountPrefix(settings) {
  const key = crypto.createHash('sha256').update(`${settings.host}\0${settings.username}`).digest('hex').slice(0, 12);
  return `imap_${key}_`;
}

function storedRow(row, db = getDb()) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO emails (id, thread_id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET is_read=excluded.is_read`).run(
    row.id, row.thread_id, row.from_addr, JSON.stringify(row.to_addr), row.subject, row.body,
    'inbox', row.is_read ? 1 : 0, row.received_at, now
  );
  return getRow(row.id, db);
}

function getRow(localId, db = getDb()) {
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(localId);
  return row ? { ...row, to_addr: JSON.parse(row.to_addr || '[]'), is_read: !!row.is_read } : null;
}

export async function syncChanges({ db = getDb(), eventBus, correlationId, dataDir, instance, clientFactory = (config) => new ImapFlow(config) } = {}) {
  let settings;
  try { settings = validateSettings(readEncryptedFile(instance.vault_key, dataDir)); } catch { throw new Error('imap: credentials are not configured'); }
  const client = clientFactory({
    host: settings.host, port: 993, secure: true,
    auth: { user: settings.username, pass: settings.password },
    logger: false, socketTimeout: 10000, greetingTimeout: 10000,
  });
  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const exists = Number(client.mailbox?.exists || 0);
    if (!exists) return { synced: 0 };
    if (!client.mailbox?.uidValidity) throw new Error('missing IMAP UIDVALIDITY');
    const uidValidity = String(client.mailbox.uidValidity);
    const prefix = accountPrefix(settings);
    let synced = 0;
    const start = Math.max(1, exists - MAX_RECENT + 1);
    // Finish the fetch iterator before issuing fetchOne commands: ImapFlow
    // serializes commands on one connection and nested fetches can deadlock.
    const recent = [];
    for await (const message of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true, size: true })) {
      recent.push(message);
    }
    for (const message of recent.slice(0, MAX_RECENT)) {
      const localId = `${prefix}${uidValidity}_${message.uid}`;
      const existing = getRow(localId, db);
      if (existing) {
        db.prepare('UPDATE emails SET is_read = ? WHERE id = ?').run(message.flags?.has('\\Seen') ? 1 : 0, localId);
        continue;
      }
      if (!Number.isSafeInteger(message.size) || message.size > MAX_SOURCE_BYTES) continue;
      const full = await client.fetchOne(message.uid, { source: true }, { uid: true });
      if (!full?.source || full.source.length > MAX_SOURCE_BYTES) continue;
      const parsed = await simpleParser(full.source);
      const row = storedRow({
        id: localId,
        thread_id: parsed.messageId || null,
        from_addr: parsed.from?.value?.[0]?.address || '',
        to_addr: (parsed.to?.value || []).slice(0, 20).map((recipient) => recipient.address).filter(Boolean),
        subject: String(parsed.subject || '').slice(0, 1000),
        body: String(parsed.text || '').slice(0, 100000),
        is_read: message.flags?.has('\\Seen') || false,
        received_at: (parsed.date || message.envelope?.date || new Date()).toISOString(),
      }, db);
      eventBus?.publish({
        type: 'email.received', source: id, subject: { type: 'email', id: row.id },
        data: { after: row }, metadata: { correlationId, provenance: 'sync:imap' },
      });
      synced += 1;
    }
    return { synced };
  } catch {
    // Provider/network errors can include command frames or account names.
    throw new Error('imap: inbox sync failed; check host, TLS, credentials, and mailbox access');
  } finally {
    lock?.release();
    if (client.usable) await client.logout().catch(() => {});
  }
}

export async function listEmails({ folder = 'inbox', query } = {}, options = {}) {
  if (folder !== 'inbox') return [];
  await syncChanges(options);
  const settings = validateSettings(readEncryptedFile(options.instance?.vault_key, options.dataDir));
  const prefix = accountPrefix(settings);
  const rows = getDb().prepare(`SELECT * FROM emails WHERE substr(id, 1, ?) = ? AND folder = 'inbox'
    AND (? IS NULL OR subject LIKE ? OR body LIKE ? OR from_addr LIKE ?)
    ORDER BY received_at DESC LIMIT 50`).all(prefix.length, prefix, query || null, `%${query || ''}%`, `%${query || ''}%`, `%${query || ''}%`);
  return rows.map((row) => ({ ...row, to_addr: JSON.parse(row.to_addr || '[]'), is_read: !!row.is_read }));
}

export async function getEmail(localId, { dataDir, instance } = {}) {
  const settings = validateSettings(readEncryptedFile(instance?.vault_key, dataDir));
  if (!String(localId).startsWith(accountPrefix(settings))) return null;
  return getRow(localId);
}

export async function sendEmail(message) {
  return sendViaSmtp(message);
}
