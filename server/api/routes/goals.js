import { sendJson } from '../router.js';
import { createGoalDraft, getGoalDraft, listGoalDrafts, updateGoalDraft } from '../../agent/goal-store.js';

/** Draft-only API. These routes record owner intent; they never start a run,
 * enqueue an action, or schedule an automatic wake-up. */
export function registerGoalRoutes(router) {
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
}
