import { getDb } from '../db/connection.js';
import { getGoalDraft } from './goal-store.js';
import { presentPriorReadArtifacts } from './conversation-store.js';

/** No provider calls. Scope/owner checks precede bounded artifact parsing;
 * the planner still applies destination-specific historical privacy. */
export function getGoalPriorReadArtifacts(goalId, ownerId, currentRunId) {
  const goal = getGoalDraft(goalId, ownerId);
  const current = getDb().prepare('SELECT goal_id, actor_id, goal_revision FROM agent_runs WHERE id = ?').get(currentRunId);
  if (!current || current.goal_id !== goalId || current.actor_id !== ownerId) {
    const error = new Error('Goal run not found'); error.status = 404; throw error;
  }
  if (goal.status !== 'active' || current.goal_revision !== goal.revision || !goal.permittedScope.domains.length) return [];
  const domains = goal.permittedScope.domains;
  const rows = getDb().prepare(`SELECT r.id AS runId, r.goal_id AS goalId, r.goal_revision AS goalRevision,
    s.step_index AS stepIndex, s.tool, a.id AS actionId, a.updated_at AS observedAt,
    substr(a.result, 1, 50000) AS result, length(a.result) > 50000 AS truncated, a.account_binding AS accountBinding
    FROM agent_runs r JOIN agent_run_steps s ON s.run_id = r.id JOIN agent_actions a ON a.id = s.action_id
    WHERE r.goal_id = ? AND r.actor_id = ? AND r.id != ? AND a.status = 'executed' AND a.tool = s.tool
      AND s.tool IN ('email.search', 'email.read', 'calendar.list', 'contacts.search', 'tasks.list', 'web.search')
      AND substr(s.tool, 1, instr(s.tool, '.') - 1) IN (${domains.map(() => '?').join(',')})
      AND (s.tool = 'tasks.list' OR a.account_binding IS NOT NULL)
    ORDER BY r.created_at DESC, r.id DESC, s.step_index DESC LIMIT 4`).all(goalId, ownerId, currentRunId, ...domains);
  return presentPriorReadArtifacts(rows).map((artifact) => {
    if (artifact.tool !== 'web.search' || !artifact.result || typeof artifact.result !== 'object' || Array.isArray(artifact.result)) return artifact;
    // Reviews are working choices, not facts or instructions. Tie each one
    // to this exact action; do not dump an unrelated/full finding ledger.
    const reviews = getDb().prepare(`SELECT f.id, f.url, f.review_status, f.review_goal_revision,
      CASE WHEN EXISTS (SELECT 1 FROM goal_finding_sources history WHERE history.finding_id = f.id
        AND history.classification != 'private') THEN 'sensitive' ELSE 'private' END AS classification
      FROM goal_findings f JOIN goal_finding_sources source ON source.finding_id = f.id
      WHERE f.goal_id = ? AND source.action_id = ? AND f.review_status IN ('relevant', 'dismissed')
      ORDER BY f.id LIMIT 13`).all(goal.id, artifact.actionId);
    // Keep raw source classifications intact. Runtime review metadata is
    // separate from any provider-supplied lookalike inside result data.
    return { ...artifact, ownerReviewContext: {
      reviews: reviews.slice(0, 12).map((review) => ({ findingId: review.id, url: review.url,
        reviewStatus: review.review_status, reviewGoalRevision: review.review_goal_revision, classification: review.classification,
        appliesToCurrentRevision: review.review_goal_revision === goal.revision })),
      currentGoalRevision: goal.revision, truncated: reviews.length > 12,
    } };
  });
}
