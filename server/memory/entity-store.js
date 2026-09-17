import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

export function createEntity({ type, name = null, attributes = {}, status = 'active' }) {
  const db = getDb();
  const id = newId('ent');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO entities (id, type, name, attributes, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, type, name, JSON.stringify(attributes), status, now, now);
  return getEntity(id);
}

export function getEntity(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  return row ? rowToEntity(row) : null;
}

export function findEntities({ type, query } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (type) {
    clauses.push('type = ?');
    params.push(type);
  }
  if (query) {
    clauses.push('name LIKE ?');
    params.push(`%${query}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM entities ${where} ORDER BY created_at DESC`).all(...params);
  return rows.map(rowToEntity);
}

export function updateEntity(id, patch = {}) {
  const existing = getEntity(id);
  if (!existing) return null;
  const db = getDb();
  const name = patch.name !== undefined ? patch.name : existing.name;
  const attributes =
    patch.attributes !== undefined ? { ...existing.attributes, ...patch.attributes } : existing.attributes;
  const status = patch.status !== undefined ? patch.status : existing.status;
  const now = new Date().toISOString();
  db.prepare('UPDATE entities SET name = ?, attributes = ?, status = ?, updated_at = ? WHERE id = ?').run(
    name,
    JSON.stringify(attributes),
    status,
    now,
    id
  );
  return getEntity(id);
}

function rowToEntity(row) {
  return { ...row, attributes: JSON.parse(row.attributes || '{}') };
}
