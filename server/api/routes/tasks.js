import { sendJson } from '../router.js';
import * as tasksProvider from '../../integrations/mock-tasks-provider.js';
import { newId } from '../../db/ids.js';

const STATUSES = ['open', 'completed'];

export function registerTaskRoutes(router, { agent, eventBus }) {
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

  // The owner editing their own task. Like owner edits to memory and vault
  // files it is applied directly and recorded as an event, rather than going
  // through the agent's consequential-action pipeline: nothing leaves U2OS.
  router.patch('/api/tasks/:id', async (req, res) => {
    const { title, dueAt, status } = req.body || {};
    const changes = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) return sendJson(res, 400, { error: 'title must be 1 to 200 characters' });
      changes.title = title.trim();
    }
    if (dueAt !== undefined) {
      if (dueAt !== null && (typeof dueAt !== 'string' || Number.isNaN(Date.parse(dueAt)))) return sendJson(res, 400, { error: 'dueAt must be an ISO date or null' });
      changes.dueAt = dueAt;
    }
    if (status !== undefined) {
      if (!STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of: ${STATUSES.join(', ')}` });
      changes.status = status;
    }
    if (!Object.keys(changes).length) return sendJson(res, 400, { error: 'Nothing to change' });

    const result = tasksProvider.updateTask(req.params.id, changes);
    if (!result) return sendJson(res, 404, { error: 'No such task' });
    eventBus?.publish({
      type: 'task.updated',
      source: 'user',
      actor: { type: 'user', id: req.owner?.id || 'user' },
      subject: { type: 'task', id: req.params.id },
      data: { changed: Object.keys(changes) },
      metadata: { provenance: 'user:task-edit' },
    });
    sendJson(res, 200, { task: result.after });
  });
}
