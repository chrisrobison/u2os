import { DataProcessingPolicy } from '../policy/data-processing-policy.js';

const MAX_TURNS = 6;
const MAX_CONTENT = 500;
const MAX_TOTAL_CHARS = 4_000;

/** Prior turns are working context, not a fresh owner command. Every turn
 * retains a private classification floor even if stored metadata claims a
 * less restrictive class. Confirm/never both mean omission here. */
export function filterConversationHistoryForDestination(history, destination, policy = new DataProcessingPolicy()) {
  if (!Array.isArray(history) || !history.length) return { history: [], omitted: [] };
  const allowed = [];
  const omitted = [];
  let remaining = MAX_TOTAL_CHARS;
  for (const [index, turn] of history.entries()) {
    const turnId = typeof turn?.turnId === 'string' ? turn.turnId.slice(0, 100) : null;
    if (index >= MAX_TURNS) {
      omitted.push({ turnId, destination, reason: 'history-limit' });
      continue;
    }
    const classification = turn?.classification === 'sensitive' ? 'sensitive' : 'private';
    const evaluation = policy.evaluate({ classification, destination });
    if (evaluation.decision !== 'allow') {
      omitted.push({ turnId, classification, destination, decision: evaluation.decision, rule: evaluation.rule });
      continue;
    }
    const content = typeof turn?.content === 'string' ? turn.content.slice(0, MAX_CONTENT) : '';
    const item = {
      turnId,
      runId: typeof turn?.runId === 'string' ? turn.runId.slice(0, 100) : null,
      runStatus: typeof turn?.runStatus === 'string' ? turn.runStatus.slice(0, 50) : null,
      objectiveStatus: typeof turn?.objectiveStatus === 'string' ? turn.objectiveStatus.slice(0, 50) : null,
      role: turn?.role === 'assistant' ? 'assistant' : 'user',
      classification,
      content,
      truncated: Boolean(turn?.truncated) || String(turn?.content || '').length > MAX_CONTENT,
    };
    const size = JSON.stringify(item).length;
    if (size > remaining) {
      omitted.push({ turnId, classification, destination, reason: 'payload-limit' });
      continue;
    }
    remaining -= size;
    allowed.push(item);
  }
  return { history: allowed, omitted };
}

/** Deterministic extractive summary, built only from allowed source turns.
 * Never reuse a local summary for a remote fallback. Rebuild per call so
 * policy changes also apply to persisted-run continuation after restart. */
export function summarizeEarlierTurnsForDestination(sources, destination, policy) {
  const { history, omitted } = filterConversationHistoryForDestination(sources, destination, policy);
  const entries = history.filter((turn) => turn.turnId).map(({ content, truncated, ...source }) => ({
    ...source, excerpt: content.slice(0, 160), truncated: truncated || content.length > 160,
  }));
  return { summary: entries.length ? {
    kind: 'extractive',
    coverage: 'Up to six authored turns before recent history; excerpts only, not the full conversation or established facts.',
    entries,
  } : null, omitted };
}
