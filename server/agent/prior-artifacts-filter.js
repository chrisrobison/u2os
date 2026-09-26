import { DataProcessingPolicy } from '../policy/data-processing-policy.js';
import { filterObservationsForDestination } from './observation-filter.js';

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
  omitted.push(...filtered.omitted.map((item) => ({ ...item, runId: eligible.find((artifact) => artifact.actionId === item.actionId)?.runId })));
  const allowed = filtered.observations.flatMap((observation) => {
    const source = eligible.find((artifact) => artifact.actionId === observation.actionId);
    if (!source || (!observation.items.length && (!Array.isArray(source.result) || source.result.length))) return [];
    return [{ ...observation, runId: source.runId, observedAt: source.observedAt,
      ...(source.goalId ? { goalId: source.goalId, goalRevision: source.goalRevision } : {}),
      account: source.account ? { providerId: source.account.providerId, instanceId: source.account.instanceId,
        label: String(source.account.label || '').slice(0, 80) } : null }];
  });
  return { artifacts: allowed, omitted };
}
