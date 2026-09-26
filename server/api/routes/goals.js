import { sendJson } from '../router.js';
import { createGoalDraft, getGoalDraft, getGoalRunEvidence, listGoalDrafts, updateGoalDraft } from '../../agent/goal-store.js';

/** Owner-scoped goals. Only the explicit run route calls the bounded agent;
 * listing/editing never starts work and there is no background wake-up. */
export function registerGoalRoutes(router, { agent }) {
  router.get('/api/goals', async (req, res) => {
    sendJson(res, 200, { goals: listGoalDrafts(req.owner.id, req.query.limit) });
  });
  router.post('/api/goals', async (req, res) => {
    sendJson(res, 201, createGoalDraft(req.owner.id, req.body));
  });
  router.get('/api/goals/:id', async (req, res) => {
    sendJson(res, 200, getGoalDraft(req.params.id, req.owner.id));
  });
  router.put('/api/goals/:id', async (req, res) => {
    sendJson(res, 200, updateGoalDraft(req.params.id, req.owner.id, req.body));
  });
  router.post('/api/goals/:id/runs', async (req, res) => {
    if (Object.keys(req.body || {}).length) return sendJson(res, 400, { error: 'Run parameters are not supported; revise the draft before starting work' });
    const goal = getGoalDraft(req.params.id, req.owner.id);
    const text = `${goal.objective}\nCompletion criteria:\n${goal.completionCriteria.map((item) => `- ${item}`).join('\n')}\nConstraints:\n${goal.constraints.map((item) => `- ${item}`).join('\n')}\nUse read-only tools within the intended domains. Do not claim objective completion without evidence.`;
    const result = await agent.handleMessage({ text, actorId: req.owner.id, goalId: goal.id });
    sendJson(res, 200, { ...result, goalId: goal.id });
  });
  router.get('/api/goals/:id/runs/:runId', async (req, res) => {
    sendJson(res, 200, getGoalRunEvidence(req.params.id, req.owner.id, req.params.runId));
  });
}
