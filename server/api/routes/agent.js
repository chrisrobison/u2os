import { sendJson } from '../router.js';

// Agent conversation entry point. Approve/reject live in routes/actions.js
// (kept in one place rather than duplicated here) since they operate on
// agent_actions rows regardless of whether they originated from chat or a
// direct API call.
export function registerAgentRoutes(router, { agent }) {
  router.post('/api/agent/message', async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string') {
      return sendJson(res, 400, { error: 'text is required' });
    }
    const actorId = req.body?.actorId || 'user';
    const result = await agent.handleMessage({ text, actorId });
    sendJson(res, 200, result);
  });
}
