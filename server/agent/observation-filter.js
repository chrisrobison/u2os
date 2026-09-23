import { DataProcessingPolicy } from '../policy/data-processing-policy.js';

const CLASSIFICATIONS = ['public', 'personal', 'private', 'sensitive'];
const MAX_OBSERVATIONS = 8;
const MAX_ITEMS = 12;
const MAX_STRING = 1_024;
const MAX_DEPTH = 4;
const MAX_TOTAL_CHARS = 24_000;
const SECRET_KEY = /(?:api[-_]?key|secret|password|authorization|cookie|access[-_]?token|refresh[-_]?token)/i;

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
      const classification = classifyObservation(tool, item);
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

function classifyObservation(tool, item) {
  // Only public web search gets a permissive floor; account-backed or
  // unknown results default private if the source does not classify them.
  const floor = tool === 'web.search' ? 'public' : 'private';
  const declared = item && typeof item === 'object' ? item.classification : null;
  if (!CLASSIFICATIONS.includes(declared)) return floor;
  return CLASSIFICATIONS[Math.max(CLASSIFICATIONS.indexOf(floor), CLASSIFICATIONS.indexOf(declared))];
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
