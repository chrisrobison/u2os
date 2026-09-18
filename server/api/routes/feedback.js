import { sendJson } from '../router.js';
import { recordFeedback, listFeedback, VALID_SUBJECT_TYPES, VALID_OUTCOMES } from '../../feedback/feedback-store.js';
import { getRecommendation, updateRecommendationStatus } from '../../agent/recommendation-store.js';

// A feedback outcome that also implies a status change on the underlying
// recommendation, kept in exactly one place so the recommendation's own
// status and this feedback log can never disagree with each other. Routes
// THROUGH recommendation-store.js's updateRecommendationStatus -- the same
// function PATCH /api/recommendations/:id calls -- rather than duplicating
// that status-update logic here.
const RECOMMENDATION_OUTCOME_TO_STATUS = { dismissed: 'dismissed', accepted: 'accepted' };

// Phase 7 / docs/feedback.md: the catch-all feedback route for everything
// that isn't already its own distinct approve/reject action (those are
// handled additively by server/api/routes/actions.js) -- dismissing a
// recommendation, marking a notification useful/not useful, postponing a
// task, dismissing a dashboard card.
export function registerFeedbackRoutes(router, { eventBus } = {}) {
  router.post('/api/feedback', async (req, res) => {
    const { subjectType, subjectId, outcome, detail } = req.body || {};

    if (!VALID_SUBJECT_TYPES.includes(subjectType)) {
      return sendJson(res, 400, { error: `subjectType must be one of ${VALID_SUBJECT_TYPES.join(', ')}` });
    }
    if (!subjectId) {
      return sendJson(res, 400, { error: 'subjectId is required' });
    }
    if (!VALID_OUTCOMES.includes(outcome)) {
      return sendJson(res, 400, { error: `outcome must be one of ${VALID_OUTCOMES.join(', ')}` });
    }
    if (detail !== undefined && (typeof detail !== 'object' || detail === null || Array.isArray(detail))) {
      return sendJson(res, 400, { error: 'detail, if given, must be a JSON object' });
    }

    let recommendation = null;
    if (subjectType === 'recommendation') {
      recommendation = getRecommendation(subjectId);
      if (!recommendation) return sendJson(res, 404, { error: 'Not Found' });
      const newStatus = RECOMMENDATION_OUTCOME_TO_STATUS[outcome];
      if (newStatus && recommendation.status !== newStatus) {
        recommendation = updateRecommendationStatus(subjectId, newStatus);
      }
    }

    // Fold in tool/domain from the recommendation record (if any) so
    // server/feedback/prioritizer.js's scoreForSuggestion() can find this
    // row later -- the domain is derived from the tool name the same way
    // policy-engine.js does (tool.split('.')[0]), never from anything the
    // request body supplied directly.
    const mergedDetail = { ...(detail || {}) };
    if (recommendation?.tool) {
      mergedDetail.tool = recommendation.tool;
      mergedDetail.domain = recommendation.tool.split('.')[0];
    }

    let row;
    try {
      row = recordFeedback({
        subjectType,
        subjectId,
        outcome,
        detail: mergedDetail,
        correlationId: recommendation?.correlation_id ?? null,
        eventBus,
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    sendJson(res, 200, { feedback: row, recommendation });
  });

  router.get('/api/feedback', async (req, res) => {
    sendJson(res, 200, {
      feedback: listFeedback({ subjectType: req.query.subjectType, subjectId: req.query.subjectId }),
    });
  });
}
