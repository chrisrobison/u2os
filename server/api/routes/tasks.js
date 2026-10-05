import { sendJson } from '../router.js';
import * as tasksProvider from '../../integrations/mock-tasks-provider.js';
import { newId } from '../../db/ids.js';

export function registerTaskRoutes(router, { agent }) {
  router.get('/api/tasks', async (req, res) => {
    sendJson(res, 200, { tasks: tasksProvider.listTasks({ status: req.query.status }) });
  });

  router.post('/api/tasks', async (req, res) => {
    const { title, dueAt, relatedEntityId } = req.body || {};
    if (!title) return sendJson(res, 400, { error: 'title is required' });

    // Routed through the agent's policy-gated action pipeline (not a direct
    // tool call) so ad-hoc task creation from the UI gets the same audit
    // trail and approval semantics as agent-proposed actions -- "policy
    // gates everything consequential" per docs/architecture.md.
    const outcome = await agent.evaluateAndMaybeExecute({
      tool: 'tasks.create',
      arguments: { title, dueAt, relatedEntityId },
      requestedBy: 'user',
      requestText: `POST /api/tasks: ${title}`,
      reasoningSummary: 'Direct task creation via API.',
      correlationId: newId('corr'),
      actor: { type: 'user', id: 'user' },
    });

    sendJson(res, outcome.status === 'failed' ? 500 : 201, outcome);
  });

  router.post('/api/tasks/:id/complete', async (req, res) => {
    const task = tasksProvider.getTask(req.params.id);
    if (!task) return sendJson(res, 404, { error: 'No such task' });

    // Same gated pipeline as creation: audited, and subject to policy.
    const outcome = await agent.evaluateAndMaybeExecute({
      tool: 'tasks.complete',
      arguments: { id: task.id },
      requestedBy: 'user',
      requestText: `POST /api/tasks/${task.id}/complete`,
      reasoningSummary: 'Direct task completion via API.',
      correlationId: newId('corr'),
      actor: { type: 'user', id: 'user' },
    });

    sendJson(res, outcome.status === 'failed' ? 500 : 200, outcome);
  });
}
