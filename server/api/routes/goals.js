import { sendJson } from '../router.js';
import { controlGoal, createGoalDraft, getGoalDraft, getGoalRunEvidence, goalRunObjective, listGoalDrafts, updateGoalDraft } from '../../agent/goal-store.js';
import { scheduleGoalWake } from '../../agent/goal-wakes.js';

/** Owner-scoped goals. Listing/editing never starts work; only an explicit
 * run or an owner-selected persisted wake calls the bounded agent. */
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
  router.post('/api/goals/:id/control', async (req, res) => {
    const goal = controlGoal(req.params.id, req.owner.id, req.body);
    if (['paused', 'cancelled'].includes(goal.status)) {
      for (const run of goal.relatedRuns) {
        if (!['completed', 'failed', 'cancelled'].includes(run.status)) await agent.cancelRun(run.id, req.owner.id);
      }
    }
    sendJson(res, 200, getGoalDraft(goal.id, req.owner.id));
  });
  router.post('/api/goals/:id/runs', async (req, res) => {
    if (Object.keys(req.body || {}).length) return sendJson(res, 400, { error: 'Run parameters are not supported; revise the draft before starting work' });
    const goal = getGoalDraft(req.params.id, req.owner.id);
    const text = goalRunObjective(goal);
    const result = await agent.handleMessage({ text, actorId: req.owner.id, goalId: goal.id });
    sendJson(res, 200, { ...result, goalId: goal.id });
  });
  router.post('/api/goals/:id/wake', async (req, res) => {
    sendJson(res, 201, scheduleGoalWake(req.params.id, req.owner.id, req.body));
  });
  router.get('/api/goals/:id/runs/:runId', async (req, res) => {
    sendJson(res, 200, getGoalRunEvidence(req.params.id, req.owner.id, req.params.runId), { 'Cache-Control': 'no-store' });
  });
}
