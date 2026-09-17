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

export function createDraft({ to, subject, body, inReplyTo = null }) {
  const db = getDb();
  const id = newId('email');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO emails (id, thread_id, from_addr, to_addr, subject, body, folder, is_read, received_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, inReplyTo, OWNER_ADDRESS, JSON.stringify(Array.isArray(to) ? to : [to]), subject, body, 'drafts', 1, null, now);
  return getEmail(id);
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
