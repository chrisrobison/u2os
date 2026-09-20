import { getRecommendation } from './recommendation-store.js';
import { listEvents } from '../events/log.js';
import { getDb } from '../db/connection.js';

// Recommendation explanations use only persisted deterministic metadata:
// the evaluator's concise summary, source event reference, selected tool,
// dashboard title, and correlated event trail. No model chain-of-thought is
// stored or reconstructed here.
export function explainRecommendation(id) {
  const recommendation = getRecommendation(id);
  if (!recommendation) return null;

  const relatedEvents = recommendation.correlation_id
    ? listEvents(getDb(), { correlationId: recommendation.correlation_id, limit: 200 })
      .map((event) => ({ id: event.id, type: event.type, timestamp: event.timestamp }))
      .reverse()
    : [];

  return {
    id: recommendation.id,
    decision: recommendation.decision,
    reasoningSummary: recommendation.reasoning_summary,
    sourceEvent: recommendation.event_type
      ? { type: recommendation.event_type, id: recommendation.event_id || null }
      : null,
    tool: recommendation.tool,
    status: recommendation.status,
    dashboardTitle: recommendation.dashboard?.title || null,
    correlationId: recommendation.correlation_id,
    relatedEvents,
  };
}
