import { DataProcessingPolicy } from '../policy/data-processing-policy.js';

const CLASSIFICATIONS = ['public', 'personal', 'private', 'sensitive'];
const MAX_OBSERVATIONS = 8;
const MAX_ITEMS = 12;
const MAX_STRING = 1_024;
const MAX_DEPTH = 4;
const MAX_TOTAL_CHARS = 24_000;
const SECRET_KEY = /(?:api[-_]?key|secret|password|authorization|cookie|credential|access[-_]?token|refresh[-_]?token)/i;

/** Tool output is untrusted data. A provider-supplied classification may tighten,
 * but never lower, the server's conservative floor for that tool. */
export function filterObservationsForDestination(observations, destination, policy = new DataProcessingPolicy()) {
  if (!Array.isArray(observations) || !observations.length) return { observations: [], omitted: [] };
  const allowed = [];
  const omitted = [];
  let remainingChars = MAX_TOTAL_CHARS;
  for (const [position, observation] of observations.entries()) {
    const stepIndex = Number.isInteger(observation?.stepIndex) && observation.stepIndex >= 0 ? observation.stepIndex : position;
    const tool = typeof observation?.tool === 'string' ? observation.tool : 'unknown';
    const source = { stepIndex, tool, actionId: typeof observation?.actionId === 'string' ? observation.actionId : null };
    if (position >= MAX_OBSERVATIONS) {
      omitted.push({ ...source, reason: 'observation-limit', destination });
      continue;
    }
    if (observation?.status !== 'executed') {
      allowed.push({ ...source, status: observation?.status || 'unknown', items: [] });
      continue;
    }
    const rawItems = Array.isArray(observation.result) ? observation.result : [observation.result];
    const items = [];
    for (const [index, item] of rawItems.entries()) {
      if (index >= MAX_ITEMS) {
        omitted.push({ ...source, index, reason: 'item-limit', destination });
        continue;
      }
      const classification = classifyObservation(tool, item, observation.historical === true);
      const decision = policy.evaluate({ classification, destination });
      if (decision.decision !== 'allow') {
        omitted.push({ ...source, index, classification, destination, decision: decision.decision, rule: decision.rule });
        continue;
      }
      const data = boundedClone(item);
      const size = JSON.stringify(data).length;
      if (size > remainingChars) {
        omitted.push({ ...source, index, classification, destination, reason: 'payload-limit' });
        continue;
      }
      remainingChars -= size;
      items.push({ index, classification, data });
    }
    allowed.push({ ...source, status: 'executed', items });
  }
  return { observations: allowed, omitted };
}

function classifyObservation(tool, item, historical = false) {
  // Only public web search gets a permissive floor; account-backed or
  // unknown results default private if the source does not classify them.
  const floor = tool === 'web.search' && !historical ? 'public' : 'private';
  // Wrapped results (e.g. web.search.results[]) may classify individual
  // entries. Conservatively tighten the entire item for any nested label;
  // nesting must never erase a more restrictive classification.
  let rank = CLASSIFICATIONS.indexOf(floor);
  const pending = [item];
  const seen = new WeakSet();
  let inspected = 0;
  while (pending.length) {
    if (++inspected > 5000) return 'sensitive';
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    rank = Math.max(rank, CLASSIFICATIONS.indexOf(value.classification));
    if (rank === 3) return 'sensitive';
    const children = Object.values(value).slice(0, 5001);
    if (pending.length + children.length + inspected > 5000) return 'sensitive';
    pending.push(...children);
  }
  return CLASSIFICATIONS[rank];
}

function boundedClone(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (value === null || typeof value !== 'object') return typeof value === 'number' || typeof value === 'boolean' ? value : null;
  if (depth >= MAX_DEPTH || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((entry) => boundedClone(entry, depth + 1, seen));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .slice(0, MAX_ITEMS)
    .map(([key, entry]) => [key.slice(0, 80), boundedClone(entry, depth + 1, seen)]));
}
