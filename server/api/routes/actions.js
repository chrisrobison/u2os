import { sendJson } from '../router.js';
import { getAgentAction, listPendingActions } from '../../policy/policy-engine.js';
import { recordFeedback } from '../../feedback/feedback-store.js';

export function registerActionRoutes(router, { agent, eventBus } = {}) {
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
    const actionBefore = getAgentAction(req.params.id);
    try {
      const result = await agent.approveAction(req.params.id, approvedBy);
      // Phase 7 / docs/feedback.md: additive-only -- record the user's
      // approval as feedback for later prioritization. Never changes the
      // response shape above, and never runs if approveAction() itself
      // threw (e.g. the action wasn't pending), so a rejected write here can
      // never mask or alter the approval outcome itself.
      recordActionFeedback({ action: actionBefore, outcome: 'accepted', eventBus });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.post('/api/actions/:id/reject', async (req, res) => {
    const rejectedBy = req.body?.rejectedBy || 'user';
    const actionBefore = getAgentAction(req.params.id);
    try {
      const result = await agent.rejectAction(req.params.id, rejectedBy);
      recordActionFeedback({ action: actionBefore, outcome: 'rejected', eventBus });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
}

// Best-effort: a failure recording feedback must never surface as a failure
// of the approve/reject route itself (the actual approval/rejection already
// succeeded by the time this is called).
function recordActionFeedback({ action, outcome, eventBus }) {
  if (!action) return;
  try {
    recordFeedback({
      subjectType: 'agent_action',
      subjectId: action.id,
      outcome,
      detail: { tool: action.tool, domain: action.policy_domain, requestedBy: action.requested_by },
      correlationId: action.correlation_id,
      eventBus,
    });
  } catch (err) {
    console.error('[actions] failed to record feedback', err);
  }
}
