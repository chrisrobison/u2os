import { sendJson } from '../router.js';
import { getAgentAction, listPendingActions } from '../../policy/policy-engine.js';

export function registerActionRoutes(router, { agent }) {
  router.get('/api/actions/pending', async (_req, res) => {
    sendJson(res, 200, { actions: listPendingActions() });
  });

  router.get('/api/actions/:id', async (req, res) => {
    const action = getAgentAction(req.params.id);
    if (!action) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, action);
  });

  router.post('/api/actions/:id/approve', async (req, res) => {
    const approvedBy = req.body?.approvedBy || 'user';
    try {
      const result = await agent.approveAction(req.params.id, approvedBy);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.post('/api/actions/:id/reject', async (req, res) => {
    const rejectedBy = req.body?.rejectedBy || 'user';
    try {
      const result = await agent.rejectAction(req.params.id, rejectedBy);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
}
