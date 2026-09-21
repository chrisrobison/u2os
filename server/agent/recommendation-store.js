// Storage for agent.evaluateEvent()'s 'recommend'/'prepare' decisions --
// docs/automation.md's "new, lighter-weight recommendation concept distinct
// from a pending approval": queryable, dismissible, never auto-executed and
// never blocking on approval. Optionally carries a dashboard schema (the
// before-meeting briefing generated for calendar.event_approaching).
import { getDb } from '../db/connection.js';
import { newId } from '../db/ids.js';

export function createRecommendation({
  decision,
  eventType = null,
  eventId = null,
  tool = null,
  arguments: args = null,
  reasoningSummary = null,
  dashboard = null,
  correlationId = null,
} = {}) {
  const db = getDb();
  const id = newId('rec');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO recommendations (
      id, decision, event_type, event_id, tool, arguments, reasoning_summary, dashboard,
      status, correlation_id, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    decision,
    eventType,
    eventId,
    tool,
    args ? JSON.stringify(args) : null,
    reasoningSummary,
    dashboard ? JSON.stringify(dashboard) : null,
    'open',
    correlationId,
    now,
    now
  );
  return getRecommendation(id);
}

export function getRecommendation(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id);
  return row ? rowToRecommendation(row) : null;
}

export function listRecommendations({ status } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM recommendations ${where} ORDER BY created_at DESC`).all(...params);
  return rows.map(rowToRecommendation);
}

export function updateRecommendationStatus(id, status) {
  const existing = getRecommendation(id);
  if (!existing) return null;
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE recommendations SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  return getRecommendation(id);
}

function rowToRecommendation(row) {
  const dashboard = row.dashboard ? JSON.parse(row.dashboard) : null;
  return {
    ...row,
    arguments: row.arguments ? JSON.parse(row.arguments) : null,
    dashboard: addLegacyDashboardProvenance(dashboard, row),
  };
}

// Recommendations persisted before component-level provenance was introduced
// remain renderable after upgrade. The fallback is deliberately candid: it
// identifies the recommendation record but does not invent source evidence.
function addLegacyDashboardProvenance(dashboard, recommendation) {
  if (!dashboard?.components || !Array.isArray(dashboard.components)) return dashboard;
  return {
    ...dashboard,
    components: dashboard.components.map((component) => component?.provenance ? component : {
      ...component,
      provenance: {
        reason: 'Included in a recommendation created before card-level provenance was recorded.',
        references: [{ type: 'recommendation', id: recommendation.id, label: recommendation.decision }],
      },
    }),
  };
}
