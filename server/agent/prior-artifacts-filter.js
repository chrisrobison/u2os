import { DataProcessingPolicy } from '../policy/data-processing-policy.js';
import { filterObservationsForDestination } from './observation-filter.js';
import { canonicalFindingUrl } from './goal-finding-url.js';

/** Historical reads are private conversation/goal data even when the original
 * tool (such as public web search) normally has a lower classification. */
export function filterPriorArtifactsForDestination(artifacts, destination, policy = new DataProcessingPolicy()) {
  if (!Array.isArray(artifacts) || !artifacts.length) return { artifacts: [], omitted: [] };
  const eligible = [];
  const omitted = [];
  for (const artifact of artifacts.slice(0, 4)) {
    const source = { runId: artifact.runId, actionId: artifact.actionId, destination };
    const decision = policy.evaluate({ classification: 'private', destination });
    if (decision.decision !== 'allow') {
      omitted.push({ ...source, classification: 'private', decision: decision.decision, rule: decision.rule });
    } else {
      eligible.push({ ...artifact, historical: true });
    }
  }
  for (const artifact of artifacts.slice(4)) omitted.push({ runId: artifact.runId, actionId: artifact.actionId, destination, reason: 'artifact-limit' });
  const filtered = filterObservationsForDestination(eligible, destination, policy);
  let reviewChars = 0;
  omitted.push(...filtered.omitted.map((item) => ({ ...item, runId: eligible.find((artifact) => artifact.actionId === item.actionId)?.runId })));
  const allowed = filtered.observations.flatMap((observation) => {
    const source = eligible.find((artifact) => artifact.actionId === observation.actionId);
    if (!source || (!observation.items.length && (!Array.isArray(source.result) || source.result.length))) return [];
    let ownerReviewContext;
    if (source.goalId && source.tool === 'web.search' && source.ownerReviewContext) {
      const visibleUrls = new Set(observation.items.flatMap((item) => Array.isArray(item.data?.results) ? item.data.results : [])
        .map((item) => canonicalFindingUrl(item.url)).filter(Boolean));
      const reviews = source.ownerReviewContext.reviews.slice(0, 12).flatMap((review) => {
        if (!visibleUrls.has(review.url)) return [];
        const decision = policy.evaluate({ classification: review.classification || 'sensitive', destination });
        if (decision.decision !== 'allow') {
          omitted.push({ runId: source.runId, actionId: source.actionId, findingId: review.findingId, destination,
            classification: review.classification || 'sensitive', decision: decision.decision, rule: decision.rule, reason: 'owner-review-restricted' });
          return [];
        }
        const bounded = { findingId: String(review.findingId).slice(0, 80), url: review.url,
          reviewStatus: review.reviewStatus, reviewGoalRevision: review.reviewGoalRevision, classification: review.classification,
          appliesToCurrentRevision: review.appliesToCurrentRevision };
        const size = JSON.stringify(bounded).length;
        if (reviewChars + size > 4000) return [];
        reviewChars += size; return [bounded];
      });
      ownerReviewContext = { currentGoalRevision: source.ownerReviewContext.currentGoalRevision,
        truncated: source.ownerReviewContext.truncated || reviews.length < source.ownerReviewContext.reviews.length, reviews };
      if (ownerReviewContext.truncated) omitted.push({ runId: source.runId, actionId: source.actionId, destination, reason: 'bounded-review-context' });
    }
    return [{ ...observation, runId: source.runId, observedAt: source.observedAt,
      ...(source.goalId ? { goalId: source.goalId, goalRevision: source.goalRevision } : {}),
      // Only generated goal web-search metadata, and only when its entire
      // wrapped source passed destination/classification filtering above.
      ...(ownerReviewContext ? { ownerReviewContext } : {}),
      account: source.account ? { providerId: source.account.providerId, instanceId: source.account.instanceId,
        label: String(source.account.label || '').slice(0, 80) } : null }];
  });
  return { artifacts: allowed, omitted };
}
