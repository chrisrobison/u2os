// MOCK provider: real CRUD against SQLite's emails table, no real Gmail/etc
// connection.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

const OWNER_ADDRESS = 'chris@u2os.local';

export const id = 'mock-email';

export function searchEmails({ query, folder } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (folder) {
    clauses.push('folder = ?');
    params.push(folder);
  }
  if (query) {
    clauses.push('(subject LIKE ? OR body LIKE ? OR from_addr LIKE ?)');
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM emails ${where} ORDER BY received_at DESC, created_at DESC`).all(...params);
  return rows.map(rowToEmail);
}

export function getEmail(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  return row ? rowToEmail(row) : null;
}

export function markRead(id) {
  const db = getDb();
  db.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').run(id);
  return getEmail(id);
}

// `correlationId`: the drafting request's correlation id, stored as
// provenance/context on the row (visible via the API, useful for the
// activity feed and debugging) but NOT used to link a draft to a later
// send -- see the comment on getDraftById() below for why matching by
// correlationId alone was removed.
export function createDraft({ to, subject, body, inReplyTo = null }, correlationId = null) {
  const db = getDb();
  const id = newId('email');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO emails (id, thread_id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at, correlation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, inReplyTo, OWNER_ADDRESS, JSON.stringify(Array.isArray(to) ? to : [to]), subject, body, 'drafts', 1, null, now, correlationId);
  return getEmail(id);
}

/**
 * Looks up a specific draft by id, only returning it if it's still actually
 * in the drafts folder. Used by server/feedback/email-edit-detector.js to
 * compare an email.send call against the EXACT draft it claims to originate
 * from (email.send's optional `draftId` argument), never a guess.
 *
 * A previous version of this matched by correlation_id alone ("most recent
 * draft sharing this exact correlation id") instead of requiring an
 * explicit draftId. That was unsound the moment more than one draft could
 * share a correlation id (e.g. one turn drafting two different emails) --
 * verified in security review to produce false-positive 'edited' feedback
 * (misattributing a send to the wrong draft, or flagging a send that was
 * never drafted at all) once anything proposes more than one email.draft
 * per turn. Fixed by requiring the caller to say exactly which draft a send
 * follows from; no draftId means no detection, a false negative rather than
 * a false positive, matching this codebase's established fail-safe rule.
 */
export function getDraftById(id) {
  if (!id) return null;
  const db = getDb();
  const row = db.prepare("SELECT * FROM emails WHERE id = ? AND folder = 'drafts'").get(id);
  return row ? rowToEmail(row) : null;
}

export function sendEmail({ to, subject, body, inReplyTo = null }) {
  const db = getDb();
  const id = newId('email');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO emails (id, thread_id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, inReplyTo, OWNER_ADDRESS, JSON.stringify(Array.isArray(to) ? to : [to]), subject, body, 'sent', 1, now, now);
  return getEmail(id);
}

/** Used only by seed data (and would back a future inbound-mail webhook). */
export function receiveEmail({ from, to = OWNER_ADDRESS, subject, body, receivedAt, threadId = null, isRead = false }) {
  const db = getDb();
  const id = newId('email');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO emails (id, thread_id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, threadId, from, JSON.stringify(Array.isArray(to) ? to : [to]), subject, body, 'inbox', isRead ? 1 : 0, receivedAt || now, now);
  return getEmail(id);
}

function rowToEmail(row) {
  return { ...row, to_addr: JSON.parse(row.to_addr || '[]'), is_read: !!row.is_read };
}
