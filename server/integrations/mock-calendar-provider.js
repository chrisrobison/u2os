// MOCK provider: real CRUD against SQLite's calendar_events table, but no
// real Google Calendar/etc connection. Kept behind this module so tools.js
// call sites never change when a real provider is swapped in later.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

export function listEvents({ from, to } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('start_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('start_at <= ?');
    params.push(to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM calendar_events ${where} ORDER BY start_at ASC`).all(...params);
  return rows.map(rowToEvent);
}

export function getEvent(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  return row ? rowToEvent(row) : null;
}

export function createEvent({ title, startAt, endAt, attendees = [], location = null, category = 'personal' }) {
  const db = getDb();
  const id = newId('cal');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO calendar_events (id, title, start_at, end_at, location, attendees, category, status, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, title, startAt, endAt, location, JSON.stringify(attendees), category, 'confirmed', 'mock-calendar', now, now);
  return getEvent(id);
}

export function rescheduleEvent(id, { newStartAt, newEndAt }) {
  const existing = getEvent(id);
  if (!existing) return null;
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE calendar_events SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ?').run(newStartAt, newEndAt, now, id);
  return { before: existing, after: getEvent(id) };
}

function rowToEvent(row) {
  return { ...row, attendees: JSON.parse(row.attendees || '[]') };
}
