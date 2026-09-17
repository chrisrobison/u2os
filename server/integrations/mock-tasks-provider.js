// MOCK provider: real CRUD against SQLite's tasks table.
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

export function listTasks({ status } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY due_at IS NULL, due_at ASC, created_at DESC`).all(...params);
  return rows;
}

export function getTask(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
}

export function createTask({ title, dueAt = null, relatedEntityId = null, source = 'user' }) {
  const db = getDb();
  const id = newId('task');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, title, status, due_at, related_entity_id, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, title, 'open', dueAt, relatedEntityId, source, now, now);
  return getTask(id);
}

export function completeTask(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, id);
  return getTask(id);
}
