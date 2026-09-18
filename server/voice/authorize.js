// Server-side voice authorization gate -- docs/voice.md's "Server-side
// enforcement" section. This is the ONLY place voice confidence is allowed
// to influence whether an action executes; the browser's own UI state is
// never trusted as the security boundary (PROMPT.md #17's "never rely on
// prompts alone as a security boundary" generalized to "never rely on the
// client's own JS as the security boundary" for voice).
//
// This sits strictly on top of the existing policy-engine.evaluate() result
// -- it never replaces it, and it never grants anything the policy engine
// itself withheld. The one invariant every branch below must preserve:
// voice can only ever TIGHTEN a resolution (turn autonomous into confirm,
// or confirm/autonomous into blocked), never loosen one. That single
// invariant is also what makes "financial/legal/destructive actions are
// never made executable by voice confidence alone" true for free -- this
// module never sets `blocked: false` or `requiresApproval: false` anywhere,
// so a `never` rule (or a `payments`-domain `confirm`) stays exactly as
// gated as the policy engine already made it, no matter how high
// `voice.confidence` is.
import { ensureVoiceConfig } from './voice-config.js';

/**
 * applyVoiceAuthorization({ evaluation, voice }) -> evaluation
 *
 * `evaluation` is whatever policyEngine.evaluate() already returned.
 * `voice` is `{ confidence: number } | undefined`.
 *
 * CRITICAL INVARIANT: when `voice` is undefined (the existing, non-voice
 * text-chat path), this returns the exact same `evaluation` reference,
 * completely untouched -- this function must be 100% opt-in additive.
 */
export function applyVoiceAuthorization({ evaluation, voice }) {
  if (voice === undefined) return evaluation;

  // Already blocked by the policy engine (a `never` rule) -- a hard
  // boundary that voice confidence, however high, can never re-negotiate.
  // Returning as-is also means it can never be "upgraded" to merely
  // requiring confirmation; it stays blocked.
  if (evaluation.blocked) return evaluation;

  // Autonomy level 0 ("Observe / always") covers read-only tools and
  // explicit `always` policies -- nothing is being executed, so there is
  // nothing for a voice-confidence gate to usefully tighten. This is also
  // what keeps Phase 4's honest stub (confidence: 0 for every unrecognized
  // speaker) from blocking ordinary read-only conversation.
  if (evaluation.autonomyLevel === 0) return evaluation;

  const { voiceThresholds, privateDomains } = ensureVoiceConfig();
  const confidence = normalizeConfidence(voice?.confidence);
  const domain = evaluation.domain;

  // Private-domain gate: confidence below the `private` threshold on a
  // domain explicitly configured as private is treated exactly like a
  // policy `never`/blocked result -- not merely "needs confirmation".
  if (Array.isArray(privateDomains) && privateDomains.includes(domain) && confidence < voiceThresholds.private) {
    return {
      ...evaluation,
      blocked: true,
      requiresApproval: true,
      rule: `${evaluation.rule}+voice:private-domain-low-confidence`,
      reason: `${evaluation.reason} Blocked by voice authorization: "${domain}" is a private domain and voice confidence ${confidence.toFixed(2)} is below the private threshold (${voiceThresholds.private}).`,
    };
  }

  // Standard gate: any resolution that would otherwise execute without
  // approval (`autonomous`/`always`-but-consequential) is forced to
  // require approval when the speaker's confidence is below the standard
  // threshold. Never touches a resolution that already requires approval
  // (nothing to tighten there) and never flips `requiresApproval` back to
  // false for any reason.
  if (!evaluation.requiresApproval && confidence < voiceThresholds.standard) {
    return {
      ...evaluation,
      requiresApproval: true,
      rule: `${evaluation.rule}+voice:low-confidence`,
      reason: `${evaluation.reason} Forced to require approval by voice authorization: confidence ${confidence.toFixed(2)} is below the standard threshold (${voiceThresholds.standard}).`,
    };
  }

  return evaluation;
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
