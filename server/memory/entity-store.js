import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';
import crypto from 'node:crypto';

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

export function getEntity(id, { includeDeleted = false } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!row || (!includeDeleted && row.status === 'deleted')) return null;
  return rowToEntity(row);
}

export function findEntities({ type, query } = {}) {
  const db = getDb();
  const clauses = ["COALESCE(status, 'active') != 'deleted'"];
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

export function getEntityDeletionPreview(id) {
  const entity = getEntity(id);
  if (!entity) return null;
  const db = getDb();
  const factState = db.prepare("SELECT * FROM facts WHERE entity_id = ? AND status != 'deleted' ORDER BY id").all(id);
  const relationshipState = db.prepare("SELECT * FROM relationships WHERE status != 'deleted' AND (from_entity_id = ? OR to_entity_id = ?) ORDER BY id").all(id, id);
  const taskState = db.prepare('SELECT * FROM tasks WHERE related_entity_id = ? ORDER BY id').all(id);
  const calendarState = db.prepare('SELECT * FROM calendar_events ORDER BY id').all()
    .filter((event) => JSON.parse(event.attendees || '[]').some((attendee) => attendee?.id === id || attendee?.entityId === id || attendee?.name === entity.name));
  const impact = {
    facts: factState.map(({ id: factId, key, status }) => ({ id: factId, key, status })),
    relationships: relationshipState.map(({ id: relationshipId, relation, from_entity_id, to_entity_id }) => ({ id: relationshipId, relation, from_entity_id, to_entity_id })),
    tasks: taskState.map(({ id: taskId, title, status }) => ({ id: taskId, title, status })),
    calendarEvents: calendarState.map(({ id: eventId, title }) => ({ id: eventId, title })),
  };
  const dependencyState = { facts: factState, relationships: relationshipState, tasks: taskState, calendarEvents: calendarState };
  const token = crypto.createHash('sha256').update(JSON.stringify({ entity, dependencyState })).digest('hex');
  return { entity, impact, counts: Object.fromEntries(Object.entries(impact).map(([key, value]) => [key, value.length])), token };
}

export function deleteEntity(id, previewToken) {
  const preview = getEntityDeletionPreview(id);
  if (!preview) return null;
  if (!previewToken || previewToken !== preview.token) {
    const error = new Error('Entity deletion preview is missing or stale'); error.code = 'STALE_PREVIEW'; throw error;
  }
  const now = new Date().toISOString();
  getDb().prepare("UPDATE entities SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND status != 'deleted'").run(now, now, id);
  return { entity: getEntity(id, { includeDeleted: true }), preview };
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
