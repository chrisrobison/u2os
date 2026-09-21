import { sendJson } from '../router.js';
import { getAgentAction, listPendingActions } from '../../policy/policy-engine.js';
import { recordFeedback } from '../../feedback/feedback-store.js';
import { explainAction } from '../../agent/explain.js';
import { listQueuedActions } from '../../agent/action-queue-store.js';

export function registerActionRoutes(router, { agent, eventBus } = {}) {
  router.get('/api/actions/pending', async (_req, res) => {
    sendJson(res, 200, { actions: listPendingActions() });
  });

  router.get('/api/actions/operations', async (_req, res) => {
    sendJson(res, 200, buildOperationsResponse());
  });

  router.get('/api/actions/:id', async (req, res) => {
    const action = getAgentAction(req.params.id);
    if (!action) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, action);
  });

  // PLAN.md Phase 9 (explainability): the actual data a future "Why did
  // U2OS do this?" view would read -- reasoning summary, model, policy
  // rule, retrieved-context provenance, and the full correlated event
  // chain. Concise references only, never raw model chain-of-thought.
  router.get('/api/actions/:id/explain', async (req, res) => {
    const explanation = explainAction(req.params.id);
    if (!explanation) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, explanation);
  });

  router.post('/api/actions/:id/approve', async (req, res) => {
    const approvedBy = req.owner.id;
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
    const rejectedBy = req.owner.id;
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

export function buildOperationsResponse() {
  const pending = listPendingActions().slice(0, 100);
  const waitingIds = new Set(pending.map((action) => action.id));
  const queued = listQueuedActions().filter((item) => !waitingIds.has(item.action_id)).slice(-100).reverse().map((item) => ({
    id: item.id,
    actionId: item.action_id,
    tool: item.tool,
    status: item.status,
    attemptCount: item.attempt_count,
    nextAttemptAt: item.next_attempt_at,
    errorClass: item.error_class,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));
  const waiting = pending.map((action) => ({
    id: action.id,
    actionId: action.id,
    tool: action.tool,
    status: 'waiting_approval',
    attemptCount: 0,
    createdAt: action.created_at,
    updatedAt: action.updated_at,
  }));
  const items = [...waiting, ...queued];
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return { items, counts };
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
