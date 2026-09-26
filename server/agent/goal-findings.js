import { getDb, withTransaction } from '../db/connection.js';
import { newId } from '../db/ids.js';
import { getGoalDraft } from './goal-store.js';

const MAX_ACTIONS = 20;
const MAX_RESULTS = 30;
const SUCCESSFUL_SEARCHES = `FROM agent_runs r JOIN agent_run_steps s ON s.run_id = r.id
  JOIN agent_actions a ON a.id = s.action_id WHERE r.goal_id = ? AND r.actor_id = ?
  AND s.tool = 'web.search' AND a.tool = 'web.search' AND a.status = 'executed'`;

/** Bounded, idempotent local projection. No provider/model is invoked. Old
 * persisted successful actions can be indexed safely after an interruption. */
export function listGoalFindings(goalId, ownerId, limit = 20, offset = 0) {
  getGoalDraft(goalId, ownerId);
  const db = getDb();
  withTransaction(db, () => {
    const rows = db.prepare(`SELECT DISTINCT a.id, r.id AS run_id, r.goal_revision, a.updated_at,
      substr(a.result, 1, 100001) AS result, a.account_binding ${SUCCESSFUL_SEARCHES}
      AND NOT EXISTS (SELECT 1 FROM goal_finding_index i WHERE i.action_id = a.id)
      ORDER BY a.updated_at, a.id LIMIT ?`).all(goalId, ownerId, MAX_ACTIONS);
    for (const row of rows) indexAction(goalId, row);
  });
  const bounded = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  const start = Math.min(50000, Math.max(0, Math.floor(Number(offset) || 0)));
  const rows = db.prepare('SELECT * FROM goal_findings WHERE goal_id = ? ORDER BY first_seen_at DESC, id DESC LIMIT ? OFFSET ?').all(goalId, bounded, start);
  const total = db.prepare(`SELECT COUNT(DISTINCT a.id) AS count ${SUCCESSFUL_SEARCHES}`).get(goalId, ownerId).count;
  const coverage = db.prepare(`SELECT COUNT(*) AS indexed, COALESCE(SUM(status != 'indexed'), 0) AS limited
    FROM goal_finding_index WHERE goal_id = ?`).get(goalId);
  return { goalId, findings: rows.map((row) => present(row)),
    coverage: { successfulSearches: total, indexedActions: coverage.indexed, pendingActions: total - coverage.indexed,
      limitedActions: coverage.limited, maxResultsPerAction: MAX_RESULTS, maxActionsPerRefresh: MAX_ACTIONS,
      offset: start, totalFindings: db.prepare('SELECT COUNT(*) AS count FROM goal_findings WHERE goal_id = ?').get(goalId).count } };
}

/** Owner-only, deterministic change report. "New" means first sighting in
 * indexed evidence, not a verified new job or completion of the objective. */
export function getGoalResearchUpdate(goalId, ownerId, runId) {
  getGoalDraft(goalId, ownerId);
  const db = getDb();
  const run = db.prepare('SELECT goal_revision FROM agent_runs WHERE id = ? AND goal_id = ? AND actor_id = ?')
    .get(runId, goalId, ownerId);
  if (!run) throw error(404, 'Goal run not found');
  const { coverage } = listGoalFindings(goalId, ownerId, 1);
  // Keep the existing successful-action predicate, with the additional run
  // restriction. Derived rows never turn a failed/uncertain action into proof.
  const actions = db.prepare(`SELECT COUNT(DISTINCT a.id) AS successful,
    COUNT(DISTINCT i.action_id) AS indexed, COUNT(DISTINCT CASE WHEN i.status != 'indexed' THEN i.action_id END) AS limited
    FROM agent_runs r JOIN agent_run_steps s ON s.run_id = r.id JOIN agent_actions a ON a.id = s.action_id
    LEFT JOIN goal_finding_index i ON i.action_id = a.id AND i.goal_id = r.goal_id
    WHERE r.id = ? AND r.goal_id = ? AND r.actor_id = ? AND s.tool = 'web.search' AND a.tool = s.tool AND a.status = 'executed'`)
    .get(runId, goalId, ownerId);
  const matched = `WITH matched AS (SELECT DISTINCT f.*, (SELECT first.run_id FROM goal_finding_sources first
      JOIN agent_actions original ON original.id = first.action_id AND original.tool = 'web.search' AND original.status = 'executed'
      WHERE first.finding_id = f.id ORDER BY first.observed_at, first.action_id LIMIT 1) = ? AS is_new
    FROM goal_findings f JOIN goal_finding_sources source ON source.finding_id = f.id
      JOIN agent_actions a ON a.id = source.action_id AND a.tool = 'web.search' AND a.status = 'executed'
    WHERE f.goal_id = ? AND source.run_id = ?)`;
  const counts = db.prepare(`${matched} SELECT COUNT(*) AS total, COALESCE(SUM(is_new), 0) AS fresh FROM matched`)
    .get(runId, goalId, runId);
  const rows = db.prepare(`${matched} SELECT * FROM matched WHERE is_new = 1 ORDER BY first_seen_at, id LIMIT 20`)
    .all(runId, goalId, runId);
  return { goalId, runId, goalRevision: run.goal_revision, newCount: counts.fresh, repeatedCount: counts.total - counts.fresh,
    newFindings: rows.map(present), findingsTruncated: counts.fresh > rows.length,
    coverage: { successfulSearches: actions.successful, indexedSearches: actions.indexed,
      pendingSearches: actions.successful - actions.indexed, limitedSearches: actions.limited,
      pendingGoalActions: coverage.pendingActions, limitedGoalActions: coverage.limitedActions } };
}

export function reviewGoalFinding(goalId, ownerId, findingId, input) {
  const goal = getGoalDraft(goalId, ownerId);
  if (!input || Object.keys(input).some((key) => !['reviewStatus', 'expectedRevision', 'expectedGoalRevision'].includes(key)) ||
      !['unreviewed', 'relevant', 'dismissed'].includes(input.reviewStatus) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !Number.isSafeInteger(input.expectedGoalRevision) || input.expectedGoalRevision < 1) {
    throw error(400, 'reviewStatus and positive finding/goal revisions are required');
  }
  if (goal.revision !== input.expectedGoalRevision) throw error(409, 'Goal changed; reload before reviewing');
  const row = getDb().prepare('SELECT * FROM goal_findings WHERE id = ? AND goal_id = ?').get(findingId, goalId);
  if (!row) throw error(404, 'Finding not found');
  const changed = getDb().prepare(`UPDATE goal_findings SET review_status = ?, review_goal_revision = ?, revision = revision + 1
    WHERE id = ? AND goal_id = ? AND revision = ? AND EXISTS
      (SELECT 1 FROM goals WHERE id = ? AND owner_id = ? AND revision = ?)`)
    .run(input.reviewStatus, goal.revision, findingId, goalId, input.expectedRevision, goalId, ownerId, input.expectedGoalRevision);
  if (changed.changes !== 1) throw error(409, 'Finding changed; reload before reviewing');
  return present(getDb().prepare('SELECT * FROM goal_findings WHERE id = ?').get(findingId));
}

function indexAction(goalId, row) {
  let result;
  try {
    if (!row.result || row.result.length > 100000) throw new Error('Result too large');
    result = JSON.parse(row.result);
    if (!Array.isArray(result.results)) throw new Error('Not a search result');
  } catch {
    getDb().prepare("INSERT INTO goal_finding_index (action_id, goal_id, status) VALUES (?, ?, 'omitted')").run(row.id, goalId);
    return;
  }
  let status = result.results.length > MAX_RESULTS ? 'limited' : 'indexed';
  const account = accountPreview(row.account_binding);
  for (const item of result.results.slice(0, MAX_RESULTS)) {
    const url = safeUrl(item?.url);
    if (!url) { status = 'limited'; continue; }
    const title = typeof item.title === 'string' ? item.title.slice(0, 300) : url.slice(0, 300);
    const snippet = typeof item.snippet === 'string' ? item.snippet.slice(0, 2000) : '';
    if (item.title?.length > 300 || item.snippet?.length > 2000) status = 'limited';
    const id = newId('finding');
    getDb().prepare(`INSERT INTO goal_findings (id, goal_id, url, title, snippet, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(goal_id, url) DO NOTHING`)
      .run(id, goalId, url, title, snippet, row.updated_at, row.updated_at);
    const finding = getDb().prepare('SELECT id FROM goal_findings WHERE goal_id = ? AND url = ?').get(goalId, url);
    getDb().prepare(`INSERT OR IGNORE INTO goal_finding_sources
      (finding_id, action_id, run_id, goal_revision, observed_at, account, mock) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(finding.id, row.id, row.run_id, row.goal_revision, row.updated_at, account ? JSON.stringify(account) : null,
        result.mock === true || item.mock === true || account?.providerId.startsWith('mock-') ? 1 : 0);
    getDb().prepare('UPDATE goal_findings SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?').run(row.updated_at, finding.id);
  }
  getDb().prepare('INSERT INTO goal_finding_index (action_id, goal_id, status) VALUES (?, ?, ?)').run(row.id, goalId, status);
}

function accountPreview(raw) {
  try {
    const binding = JSON.parse(raw);
    if (typeof binding?.providerId !== 'string') return null;
    return { providerId: binding.providerId.slice(0, 80), instanceId: typeof binding.instanceId === 'string' ? binding.instanceId.slice(0, 80) : null,
      label: String(binding.label || '').slice(0, 80) };
  } catch { return null; }
}

function safeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (/(?:token|password|secret|authorization|api[_-]?key|credential)[^=&#]*=/i.test(decodeURIComponent(url.hash))) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|password|secret|authorization|api[_-]?key|credential)/i.test(key)) return null;
      if (/^utm_/i.test(key) || ['gclid', 'fbclid'].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function present(row) {
  const sources = getDb().prepare(`SELECT * FROM goal_finding_sources WHERE finding_id = ?
    ORDER BY observed_at DESC, action_id DESC LIMIT 5`).all(row.id);
  return { id: row.id, url: row.url, title: row.title, snippet: row.snippet,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, reviewStatus: row.review_status,
    reviewGoalRevision: row.review_goal_revision, revision: row.revision,
    sourceCount: getDb().prepare('SELECT COUNT(*) AS count FROM goal_finding_sources WHERE finding_id = ?').get(row.id).count,
    sources: sources.map((source) => ({ actionId: source.action_id, runId: source.run_id, goalRevision: source.goal_revision,
      observedAt: source.observed_at, account: source.account ? JSON.parse(source.account) : null, mock: Boolean(source.mock) })) };
}
function error(status, message) { const result = new Error(message); result.status = status; return result; }
