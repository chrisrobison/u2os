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
  return getDb().prepare(`SELECT c.id, c.created_at AS createdAt, c.updated_at AS updatedAt,
    (SELECT substr(m.content, 1, 80) FROM conversation_messages m
      WHERE m.session_id = c.id AND m.role = 'user' ORDER BY m.created_at, m.rowid LIMIT 1) AS label
    FROM conversations c WHERE c.owner_id = ? ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`)
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

/** Planning input only: bounded prior authored turns, never the current run
 * or orphaned legacy rows. Classification is enforced again by Planner for
 * each actual model destination. */
export function getPriorTurnsForModel(id, ownerId, currentRunId, limit = 6) {
  requireConversation(id, ownerId);
  const bounded = Math.min(Math.max(Number(limit) || 6, 1), 6);
  return getDb().prepare(`SELECT m.id AS turnId, m.role, substr(m.content, 1, 500) AS content,
    length(m.content) > 500 AS truncated, m.classification, m.run_id AS runId,
    r.status AS runStatus, r.objective_status AS objectiveStatus
    FROM conversation_messages m LEFT JOIN agent_runs r ON r.id = m.run_id
    WHERE m.session_id = ? AND m.role IN ('user', 'assistant')
    AND m.run_id IS NOT NULL AND m.run_id != ?
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`)
    .all(id, currentRunId, bounded).reverse().map((turn) => ({ ...turn, truncated: Boolean(turn.truncated) }));
}

/** Read-only historical data for a follow-up, never an executable result-ref
 * source. Account-backed legacy reads without a captured binding are omitted. */
export function getPriorReadArtifacts(id, ownerId, currentRunId) {
  requireConversation(id, ownerId);
  const rows = getDb().prepare(`SELECT r.id AS runId, s.step_index AS stepIndex, s.tool,
    a.id AS actionId, a.updated_at AS observedAt, substr(a.result, 1, 50000) AS result,
    length(a.result) > 50000 AS truncated, a.account_binding AS accountBinding
    FROM agent_runs r JOIN agent_run_steps s ON s.run_id = r.id
    JOIN agent_actions a ON a.id = s.action_id
    WHERE r.conversation_id = ? AND r.actor_id = ? AND r.id != ?
      AND a.status = 'executed' AND s.tool IN
      ('email.search', 'email.read', 'calendar.list', 'contacts.search', 'tasks.list', 'web.search')
      AND (s.tool = 'tasks.list' OR a.account_binding IS NOT NULL)
    ORDER BY r.created_at DESC, s.step_index DESC LIMIT 4`)
    .all(id, ownerId, currentRunId);
  return presentPriorReadArtifacts(rows);
}

/** Shared parsing boundary for owner/conversation or exact-goal queries. */
export function presentPriorReadArtifacts(rows) {
  return rows.flatMap((row) => {
    try {
      if (row.truncated) return [];
      const binding = row.accountBinding ? JSON.parse(row.accountBinding) : null;
      if (row.tool !== 'tasks.list' && (!binding || typeof binding.providerId !== 'string'
        || (binding.instanceId !== null && typeof binding.instanceId !== 'string'))) return [];
      const account = binding ? { providerId: binding.providerId, instanceId: binding.instanceId, label: binding.label } : null;
      return [{ runId: row.runId, stepIndex: row.stepIndex, tool: row.tool, actionId: row.actionId, observedAt: row.observedAt,
        ...(row.goalId ? { goalId: row.goalId, goalRevision: row.goalRevision } : {}),
        status: 'executed', result: JSON.parse(row.result), account, accountBinding: binding }];
    } catch { return []; }
  });
}
