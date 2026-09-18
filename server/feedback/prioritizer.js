// Phase 7 / docs/feedback.md: `scoreForSuggestion()` is a small, explicit,
// inspectable scoring function -- NOT a black box, and NOT a training loop.
// It looks at recent feedback_events for a given tool/domain and returns a
// bounded adjustment in [-MAX_ADJUSTMENT, +MAX_ADJUSTMENT], plus the exact
// rows that produced it (`influencedBy`) and a one-line human-readable
// `reason`, so any decision it nudges is auditable the same way every other
// U2OS decision is (agent_actions' audit trail, the trigger engine's fired
// log, etc.).
//
// HARD CONSTRAINT: this module reads feedback_events ONLY. It never reads or
// writes policies.yaml, never constructs a PolicyEngine, and its return
// value is only ever used by server/agent/agent.js to choose between
// notify/recommend/ignore or to adjust surfaced urgency/order -- never to
// decide whether a tool call is authorized. That gate is
// server/policy/policy-engine.js's alone, and nothing here touches it.
import { getDb } from '../db/connection.js';

export const MAX_ADJUSTMENT = 0.2;
const WINDOW_DAYS = 30;
const WINDOW_ROWS = 200; // hard cap on rows scanned, keeps this cheap regardless of table growth

// 'edited' and 'postponed' are deliberately treated as neutral signals here:
// an edit means the substance of the suggestion was wanted but needed
// changes (not a rejection of the suggestion itself), and a postponement is
// "not now", not "no". Counting only the clearly-negative and clearly-
// positive outcomes keeps the scoring rule simple and easy to explain rather
// than guessing at intermediate weights for ambiguous signals.
const NEGATIVE_OUTCOMES = new Set(['rejected', 'dismissed', 'ignored']);
const POSITIVE_OUTCOMES = new Set(['accepted', 'marked_useful']);

/**
 * scoreForSuggestion({ tool, domain, requestedBy }) ->
 *   { adjustment: number, sampleSize: number, influencedBy: string[], reason: string }
 *
 * `tool` and/or `domain` select which feedback_events rows count (a row
 * counts if its recorded detail.tool matches `tool`, OR its detail.domain
 * matches `domain`). `requestedBy`, if given, further restricts to rows
 * whose detail.requestedBy matches -- useful once U2OS is multi-actor;
 * inert today under the single-owner assumption (docs/architecture.md).
 */
export function scoreForSuggestion({ tool, domain, requestedBy } = {}) {
  if (!tool && !domain) {
    return { adjustment: 0, sampleSize: 0, influencedBy: [], reason: 'No tool or domain given to score against.' };
  }

  const db = getDb();
  const rows = db.prepare('SELECT id, outcome, detail, created_at FROM feedback_events ORDER BY created_at DESC LIMIT ?').all(WINDOW_ROWS);
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const matched = [];
  for (const row of rows) {
    const createdAtMs = Date.parse(row.created_at);
    if (Number.isFinite(createdAtMs) && createdAtMs < cutoff) continue;

    let detail;
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch {
      detail = {};
    }

    const toolMatches = Boolean(tool) && detail.tool === tool;
    const domainMatches = Boolean(domain) && detail.domain === domain;
    if (!toolMatches && !domainMatches) continue;
    if (requestedBy && detail.requestedBy && detail.requestedBy !== requestedBy) continue;

    matched.push({ id: row.id, outcome: row.outcome });
  }

  if (matched.length === 0) {
    return {
      adjustment: 0,
      sampleSize: 0,
      influencedBy: [],
      reason: `No recent feedback found for tool=${tool || '*'} domain=${domain || '*'} within the last ${WINDOW_DAYS} days.`,
    };
  }

  const negative = matched.filter((m) => NEGATIVE_OUTCOMES.has(m.outcome)).length;
  const positive = matched.filter((m) => POSITIVE_OUTCOMES.has(m.outcome)).length;
  const raw = (positive - negative) / matched.length; // in [-1, 1]; more rejections/dismissals -> more negative
  const adjustment = clamp(raw * MAX_ADJUSTMENT, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);

  return {
    adjustment: round3(adjustment),
    sampleSize: matched.length,
    influencedBy: matched.map((m) => m.id),
    reason: `${matched.length} recent feedback row(s) for tool=${tool || '*'} domain=${domain || '*'}: ${positive} positive, ${negative} negative, ${matched.length - positive - negative} neutral.`,
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
