import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';

const MAX_TURNS = 50;
const MAX_CONTENT_CHARS = 20_000;

export function createConversation(ownerId) {
  const id = newId('conv');
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO conversations (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, ownerId, now, now);
  return id;
}

export function requireConversation(id, ownerId) {
  const row = getDb().prepare('SELECT id FROM conversations WHERE id = ? AND owner_id = ?').get(id, ownerId);
  if (row) return row.id;
  const error = new Error('Conversation not found');
  error.status = 404;
  throw error;
}

export function appendTurn({ conversationId, ownerId, role, content, correlationId = null, runId = null }) {
  if (!['user', 'assistant', 'system'].includes(role)) throw new Error('Invalid conversation role');
  requireConversation(conversationId, ownerId);
  const id = newId('turn');
  const now = new Date().toISOString();
  withTransaction(getDb(), () => {
    getDb().prepare(`INSERT INTO conversation_messages (id, session_id, role, content, correlation_id, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, conversationId, role, content, correlationId, runId, now);
    getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND owner_id = ?').run(now, conversationId, ownerId);
  });
  return id;
}

export function listConversations(ownerId, limit = 20) {
  const bounded = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return getDb().prepare('SELECT id, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
    .all(ownerId, bounded);
}

export function getConversationTurns(id, ownerId, limit = MAX_TURNS) {
  requireConversation(id, ownerId);
  const bounded = Math.min(Math.max(Number(limit) || MAX_TURNS, 1), MAX_TURNS);
  const rows = getDb().prepare(`SELECT id, role, substr(content, 1, ?) AS content,
    length(content) > ? AS truncated, run_id AS runId, created_at AS createdAt
    FROM conversation_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(MAX_CONTENT_CHARS, MAX_CONTENT_CHARS, id, bounded);
  return rows.reverse().map((row) => ({ ...row, truncated: Boolean(row.truncated) }));
}
