import { sendJson } from '../router.js';
import { listRecommendations, getRecommendation, updateRecommendationStatus } from '../../agent/recommendation-store.js';

const VALID_STATUSES = ['open', 'accepted', 'dismissed'];

// agent.evaluateEvent()'s 'recommend'/'prepare' decisions, surfaced as
// dismissible cards -- distinct from a pending agent_actions approval, per
// docs/automation.md. Feeds Phase 7's feedback loop when accepted/dismissed.
export function registerRecommendationRoutes(router) {
  router.get('/api/recommendations', async (req, res) => {
    sendJson(res, 200, { recommendations: listRecommendations({ status: req.query.status }) });
  });

  router.get('/api/recommendations/:id', async (req, res) => {
    const recommendation = getRecommendation(req.params.id);
    if (!recommendation) return sendJson(res, 404, { error: 'Not Found' });
    sendJson(res, 200, recommendation);
  });

  // Dismiss/accept a recommendation card.
  router.patch('/api/recommendations/:id', async (req, res) => {
    const existing = getRecommendation(req.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Not Found' });
    const { status } = req.body || {};
    if (!VALID_STATUSES.includes(status)) {
      return sendJson(res, 400, { error: `status must be one of ${VALID_STATUSES.join(', ')}` });
    }
    sendJson(res, 200, updateRecommendationStatus(req.params.id, status));
  });
}
