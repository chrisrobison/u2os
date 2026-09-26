// Real Gmail provider (REST v1, native fetch). Same function shape as
// mock-email-provider.js so email-tools.js never needs to know which one is
// active. Per docs/connectors.md's "Gmail provider" section.
import { getDb } from '../db/connection.js';
import { hasTokens, getValidAccessToken } from './oauth/google-oauth.js';
import { scopedLocalId, unscopedUpstreamId } from './connector-instance-ids.js';
import { withGoogleRead } from './google-read-deadline.js';

export const id = 'gmail';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ID_PREFIX = 'gmail_';

/** `vaultKey` identifies which `google` connection instance to check (issue
 * #163 PR 4) -- required, no default, so a caller can never silently check
 * the wrong account. */
export function isConnected(vaultKey, dataDir) {
  return hasTokens(vaultKey, 'gmail', dataDir);
}

function toLocalId(messageId, instance) {
  return scopedLocalId(ID_PREFIX, instance, messageId);
}

function toGmailId(localId, instance) {
  return unscopedUpstreamId(ID_PREFIX, instance, localId);
}

async function authHeaders(fetchImpl, dataDir, instance) {
  const token = await getValidAccessToken(instance.vault_key, 'gmail', { dataDir, fetchImpl });
  return { Authorization: `Bearer ${token}` };
}

function headerValue(payload, name) {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || null;
}

function messageRefs(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)
      || (json.messages !== undefined && !Array.isArray(json.messages))) throw new Error('gmail: invalid message list');
  return (json.messages || []).slice(0, 50).map((ref) => {
    if (!ref || typeof ref.id !== 'string' || !ref.id.trim()) throw new Error('gmail: invalid message reference');
    return ref;
  });
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

function mapGmailMessage(msg, instance, expectedId) {
  if (!msg || typeof msg.id !== 'string' || !msg.id.trim() || msg.id !== expectedId) throw new Error('gmail: invalid message identity');
  const payload = msg.payload || {};
  const from = headerValue(payload, 'From') || '';
  const to = headerValue(payload, 'To') || '';
  const subject = headerValue(payload, 'Subject') || '';
  const folder = (msg.labelIds || []).includes('INBOX') ? 'inbox' : (msg.labelIds || []).includes('SENT') ? 'sent' : 'other';
  return {
    id: toLocalId(msg.id, instance),
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

/** One bounded Gmail search page. The query is Gmail's server-side `q`
 * syntax; returned full messages are still checked against the requested
 * folder because `OR` inside user text must not broaden that constraint. */
export async function listEmails({ folder, query } = {}, { fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs, timers } = {}) {
  if (folder !== undefined && (typeof folder !== 'string' || !['inbox', 'sent', 'other'].includes(folder))) {
    throw new Error('gmail: folder must be inbox, sent, or other');
  }
  if (query !== undefined && (typeof query !== 'string' || query.length > 256 || !query.trim())) {
    throw new Error('gmail: query must be non-empty and at most 256 characters');
  }
  return withGoogleRead({ fetchImpl, timeoutMs, timers }, async ({ fetchImpl, check }) => {
    const headers = await authHeaders(fetchImpl, dataDir, instance);
    const url = new URL(`${API_BASE}/messages`);
    const search = [folder && folder !== 'other' ? `in:${folder}` : '', query?.trim() || ''].filter(Boolean).join(' ');
    if (search) url.searchParams.set('q', search);
    url.searchParams.set('maxResults', '50');
    const listRes = await fetchImpl(url.toString(), { headers });
    if (!listRes.ok) throw new Error(`gmail: list failed (status ${listRes.status})`);
    const listJson = await listRes.json();
    const rows = [];
    for (const ref of messageRefs(listJson)) {
      const msgRes = await fetchImpl(`${API_BASE}/messages/${encodeURIComponent(ref.id)}?format=full`, { headers });
      if (!msgRes.ok) throw new Error(`gmail: search message fetch failed (status ${msgRes.status})`);
      const msg = await msgRes.json();
      check();
      const mapped = mapGmailMessage(msg, instance, ref.id);
      if (folder && mapped.folder !== folder) continue;
      rows.push(upsertRow(mapped));
    }
    return rows;
  });
}

export async function getEmail(localId, { fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs, timers } = {}) {
  return withGoogleRead({ fetchImpl, timeoutMs, timers }, async ({ fetchImpl, check }) => {
    const headers = await authHeaders(fetchImpl, dataDir, instance);
    const upstreamId = toGmailId(localId, instance);
    const res = await fetchImpl(`${API_BASE}/messages/${encodeURIComponent(upstreamId)}?format=full`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gmail: getEmail failed (status ${res.status})`);
    const msg = await res.json();
    check();
    return upsertRow(mapGmailMessage(msg, instance, upstreamId));
  });
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
    throw new Error(`gmail: "${fieldName}" must not contain line breaks; no message was attempted`);
  }
}

function buildRawMessage({ to, subject, body }) {
  const toList = Array.isArray(to) ? Array.from(to) : [to];
  if (!toList.length || toList.some((addr) => typeof addr !== 'string' || !addr.trim())) {
    throw new Error('gmail: "to" must be a nonempty string or nonempty flat array of nonempty strings; no message was attempted');
  }
  if (typeof subject !== 'string' || typeof body !== 'string') {
    throw new Error('gmail: subject and body must be strings; no message was attempted');
  }
  for (const addr of toList) assertNoHeaderInjection(addr, 'to');
  assertNoHeaderInjection(subject, 'subject');
  const toHeader = toList.join(', ');
  const message = [`To: ${toHeader}`, `Subject: ${subject}`, '', body].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

export async function sendEmail({ to, subject, body }, { fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs = 30_000, timers = globalThis } = {}) {
  const raw = buildRawMessage({ to, subject, body });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error('gmail: invalid send deadline; no message was attempted');
  }
  const headers = { ...(await authHeaders(fetchImpl, dataDir, instance)), 'Content-Type': 'application/json' };
  const controller = new AbortController();
  let res, timer, timedOut = false, finished = false;
  const discard = (response) => {
    try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* Locked native body. */ }
  };
  const check = () => { if (timedOut || finished) throw new Error('Send acknowledgement no longer available'); };
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      timedOut = true; controller.abort(); discard(res);
      reject(new Error('Send acknowledgement deadline expired'));
    }, timeoutMs);
  });
  try {
    // From this handoff onward, failure is not proof that nothing was sent.
    // Never invent a receipt ID or inherit upstream retry flags/codes/text.
    const transport = Promise.resolve().then(() => {
      check();
      return fetchImpl(`${API_BASE}/messages/send`, { method: 'POST', headers, body: JSON.stringify({ raw }), signal: controller.signal });
    }).then((response) => {
      if (timedOut || finished) { discard(response); check(); }
      return response;
    });
    res = await Promise.race([transport, deadline]);
    if (!res.ok) throw new Error('No successful send acknowledgement');
    const sent = await Promise.race([Promise.resolve().then(() => { check(); return res.json(); }), deadline]);
    check();
    if (!sent || typeof sent !== 'object' || Array.isArray(sent) || typeof sent.id !== 'string' || !sent.id.trim() ||
        (sent.threadId !== undefined && (typeof sent.threadId !== 'string' || !sent.threadId.trim()))) {
      throw new Error('Invalid send acknowledgement');
    }
    const now = new Date().toISOString();
    return upsertRow({
      id: toLocalId(sent.id, instance),
      thread_id: sent.threadId ?? null,
      from_addr: 'me',
      to_addr: Array.isArray(to) ? to : [to],
      subject, body, folder: 'sent', is_read: true, received_at: now,
    });
  } catch {
    const status = Number.isInteger(res?.status) && res.status >= 100 && res.status <= 599 ? res.status : undefined;
    const error = new Error(`gmail: send outcome uncertain${timedOut ? ' (acknowledgement timed out)' : ''}${status === undefined ? '' : ` (status ${status})`}; check the selected account's Sent mail before any new send; no automatic retry`);
    error.code = 'GMAIL_SEND_OUTCOME_UNCERTAIN';
    error.actionErrorClass = 'outcome_uncertain';
    error.ownerAttentionRequired = true;
    error.safeToRetry = false;
    if (status !== undefined) error.status = status;
    throw error;
  } finally {
    finished = true; timers.clearTimeout(timer); controller.abort(); discard(res);
  }
}

/** Polled by sync-scheduler.js: fetch recent inbox messages, upsert, publish
 * email.received for any local id not previously seen. */
export async function syncChanges({ db, eventBus, correlationId, fetchImpl = globalThis.fetch, dataDir, instance, timeoutMs, timers } = {}) {
  return withGoogleRead({ fetchImpl, timeoutMs, timers }, async ({ fetchImpl, check }) => {
    const headers = await authHeaders(fetchImpl, dataDir, instance);
    const url = new URL(`${API_BASE}/messages`);
    url.searchParams.set('q', 'in:inbox newer_than:1d');
    url.searchParams.set('maxResults', '50');
    const listRes = await fetchImpl(url.toString(), { headers });
    if (!listRes.ok) throw new Error(`gmail: syncChanges failed (status ${listRes.status})`);
    const listJson = await listRes.json();
    let count = 0;
    const database = db || getDb();
    for (const ref of messageRefs(listJson)) {
      const localId = toLocalId(ref.id, instance);
      const existing = database.prepare('SELECT * FROM emails WHERE id = ?').get(localId);
      if (existing) continue;
      const msgRes = await fetchImpl(`${API_BASE}/messages/${encodeURIComponent(ref.id)}?format=full`, { headers });
      if (!msgRes.ok) continue; // Only deleted-message 404 reaches here.
      const msg = await msgRes.json();
      check();
      const mapped = mapGmailMessage(msg, instance, ref.id);
      if (mapped.folder !== 'inbox') continue; // Labels may change since listing.
      const after = upsertRow(mapped);
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
  });
}
