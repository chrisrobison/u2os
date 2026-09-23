// Real Gmail provider (REST v1, native fetch). Same function shape as
// mock-email-provider.js so email-tools.js never needs to know which one is
// active. Per docs/connectors.md's "Gmail provider" section.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { hasTokens, getValidAccessToken } from './oauth/google-oauth.js';

export const id = 'gmail';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ID_PREFIX = 'gmail_';

// Hardcodes the legacy 'google' vault key rather than resolving a specific
// connection instance -- full multi-instance-aware provider routing is
// issue #163 PR 4's job, not this one's. This keeps working unchanged for
// the single pre-migration `google` account any given installation has,
// exactly as before PR 3's google-oauth.js vaultKey change.
const LEGACY_VAULT_KEY = 'google';

export function isConnected(dataDir) {
  return hasTokens(LEGACY_VAULT_KEY, 'gmail', dataDir);
}

function toLocalId(messageId) {
  return `${ID_PREFIX}${messageId}`;
}

function toGmailId(localId) {
  return localId.startsWith(ID_PREFIX) ? localId.slice(ID_PREFIX.length) : localId;
}

async function authHeaders(fetchImpl, dataDir) {
  const token = await getValidAccessToken(LEGACY_VAULT_KEY, 'gmail', { dataDir, fetchImpl });
  return { Authorization: `Bearer ${token}` };
}

function headerValue(payload, name) {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || null;
}

// Extracts a plain-text body from Gmail's MIME part tree. Simplification
// documented per docs/connectors.md: no attachment/multipart-alternative
// preference logic beyond "first text/plain part found, else fall back to
// the top-level body".
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const found = extractBody(part);
    if (found) return found;
  }
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  return '';
}

function mapGmailMessage(msg) {
  const payload = msg.payload || {};
  const from = headerValue(payload, 'From') || '';
  const to = headerValue(payload, 'To') || '';
  const subject = headerValue(payload, 'Subject') || '';
  const folder = (msg.labelIds || []).includes('INBOX') ? 'inbox' : (msg.labelIds || []).includes('SENT') ? 'sent' : 'other';
  return {
    id: toLocalId(msg.id),
    thread_id: msg.threadId || null,
    from_addr: from,
    to_addr: to ? [to] : [],
    subject,
    body: extractBody(payload),
    folder,
    is_read: !(msg.labelIds || []).includes('UNREAD'),
    received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
  };
}

function upsertRow(row) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM emails WHERE id = ?').get(row.id);
  if (existing) {
    db.prepare(
      `UPDATE emails SET thread_id=?, from_addr=?, to_addr=?, subject=?, body=?, folder=?, is_read=?, received_at=? WHERE id=?`
    ).run(row.thread_id, row.from_addr, JSON.stringify(row.to_addr), row.subject, row.body, row.folder, row.is_read ? 1 : 0, row.received_at, row.id);
  } else {
    db.prepare(
      `INSERT INTO emails (id, thread_id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(row.id, row.thread_id, row.from_addr, JSON.stringify(row.to_addr), row.subject, row.body, row.folder, row.is_read ? 1 : 0, row.received_at, now);
  }
  return getRowById(row.id);
}

function getRowById(localId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(localId);
  return row ? { ...row, to_addr: JSON.parse(row.to_addr || '[]'), is_read: !!row.is_read } : null;
}

export async function listEmails({ folder } = {}, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const headers = await authHeaders(fetchImpl, dataDir);
  const url = new URL(`${API_BASE}/messages`);
  if (folder) url.searchParams.set('q', `in:${folder}`);
  const listRes = await fetchImpl(url.toString(), { headers });
  if (!listRes.ok) throw new Error(`gmail: list failed (status ${listRes.status})`);
  const listJson = await listRes.json();
  const rows = [];
  for (const ref of listJson.messages || []) {
    const msgRes = await fetchImpl(`${API_BASE}/messages/${ref.id}?format=metadata`, { headers });
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    rows.push(upsertRow(mapGmailMessage(msg)));
  }
  return rows;
}

export async function getEmail(localId, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const headers = await authHeaders(fetchImpl, dataDir);
  const res = await fetchImpl(`${API_BASE}/messages/${encodeURIComponent(toGmailId(localId))}?format=full`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gmail: getEmail failed (status ${res.status})`);
  const msg = await res.json();
  return upsertRow(mapGmailMessage(msg));
}

// SECURITY: `to` and `subject` become raw RFC 2822 header lines below. A CR
// or LF embedded in either would let a caller inject arbitrary extra headers
// (e.g. a hidden Bcc) into a message that Gmail actually sends -- invisible
// to whatever the policy-engine approval UI showed the user beforehand.
// Reject rather than silently strip, since embedded line breaks in a To/
// Subject value are never legitimate and stripping them could hide an
// attempted injection instead of surfacing it.
function assertNoHeaderInjection(value, fieldName) {
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    throw new Error(`gmail: "${fieldName}" must not contain line breaks`);
  }
}

function buildRawMessage({ to, subject, body }) {
  const toList = Array.isArray(to) ? to : [to];
  for (const addr of toList) assertNoHeaderInjection(addr, 'to');
  assertNoHeaderInjection(subject, 'subject');
  const toHeader = toList.join(', ');
  const message = [`To: ${toHeader}`, `Subject: ${subject}`, '', body].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

export async function sendEmail({ to, subject, body }, { fetchImpl = globalThis.fetch, dataDir } = {}) {
  const headers = { ...(await authHeaders(fetchImpl, dataDir)), 'Content-Type': 'application/json' };
  const raw = buildRawMessage({ to, subject, body });
  const res = await fetchImpl(`${API_BASE}/messages/send`, { method: 'POST', headers, body: JSON.stringify({ raw }) });
  if (!res.ok) throw new Error(`gmail: sendEmail failed (status ${res.status})`);
  const sent = await res.json();
  const now = new Date().toISOString();
  const row = {
    id: toLocalId(sent.id || newId('gmail')),
    thread_id: sent.threadId || null,
    from_addr: 'me',
    to_addr: Array.isArray(to) ? to : [to],
    subject,
    body,
    folder: 'sent',
    is_read: true,
    received_at: now,
  };
  return upsertRow(row);
}

/** Polled by sync-scheduler.js: fetch recent inbox messages, upsert, publish
 * email.received for any local id not previously seen. */
export async function syncChanges({ db, eventBus, correlationId, fetchImpl = globalThis.fetch, dataDir } = {}) {
  const headers = await authHeaders(fetchImpl, dataDir);
  const url = new URL(`${API_BASE}/messages`);
  url.searchParams.set('q', 'in:inbox newer_than:1d');
  const listRes = await fetchImpl(url.toString(), { headers });
  if (!listRes.ok) throw new Error(`gmail: syncChanges failed (status ${listRes.status})`);
  const listJson = await listRes.json();
  let count = 0;
  const database = db || getDb();
  for (const ref of listJson.messages || []) {
    const localId = toLocalId(ref.id);
    const existing = database.prepare('SELECT * FROM emails WHERE id = ?').get(localId);
    if (existing) continue;
    const msgRes = await fetchImpl(`${API_BASE}/messages/${ref.id}?format=full`, { headers });
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    const after = upsertRow(mapGmailMessage(msg));
    eventBus?.publish({
      type: 'email.received',
      source: id,
      subject: { type: 'email', id: after.id },
      data: { after },
      metadata: { correlationId, provenance: 'sync:gmail' },
    });
    count += 1;
  }
  return { synced: count };
}
