// Deterministic capability resolver -- Phase 2 (docs/devices.md). Answers
// "which device(s) are eligible right now for this capability, given this
// request", using ONLY explicit, testable rules: capability support,
// online state, trust, ownership, and privacy. This NEVER consults a model
// -- "Security-sensitive routing is deterministic and enforced outside the
// LLM" is a hard invariant of the whole device subsystem, the same posture
// server/policy/policy-engine.js already takes for tool authorization.
//
// A resolution request:
//   {
//     audience,   // owner id the content/action is for, e.g. "chris" (optional)
//     privacy,    // 'public' | 'personal' | 'private' | 'sensitive' (default 'public')
//     location,   // preferred location -- a scoring boost, never disqualifying
//   }

const PRIVACY_RANK = { public: 0, personal: 1, private: 2, sensitive: 3 };

// The most restrictive privacy level a device at a given trust level may
// ever receive, regardless of ownership. 'revoked' is handled separately
// (always ineligible, for any privacy level) -- see evaluateCandidate().
const TRUST_MAX_PRIVACY = { untrusted: 'public', paired: 'personal', trusted: 'sensitive' };

function normalizePrivacy(privacy) {
  return Object.prototype.hasOwnProperty.call(PRIVACY_RANK, privacy) ? privacy : 'public';
}

/**
 * explainResolution(capabilityId, request, { deviceRegistry, capabilityRegistry })
 * -> { capability, request, candidates: [{device, eligible, score, reasons}], chosen }
 *
 * `candidates` is sorted eligible-first, then by descending score -- the
 * exact shape docs/devices.md's "resolver explanation" section documents,
 * so this same function backs both resolveCapability() and any future
 * debug/inspection route ("why was this device chosen?").
 */
export function explainResolution(capabilityId, request = {}, { deviceRegistry, capabilityRegistry }) {
  if (!capabilityRegistry.has(capabilityId)) {
    throw new Error(`Unknown capability: ${capabilityId}`);
  }
  const normalizedRequest = { ...request, privacy: normalizePrivacy(request.privacy) };
  const candidates = deviceRegistry.findProvidersFor(capabilityId);

  const evaluated = candidates
    .map((device) => evaluateCandidate(device, normalizedRequest))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);

  const chosen = evaluated.find((c) => c.eligible) || null;

  return {
    capability: capabilityId,
    request: normalizedRequest,
    candidates: evaluated,
    chosen: chosen ? chosen.device : null,
  };
}

/** resolveCapability(...) -> the chosen device record, or null if none is eligible. */
export function resolveCapability(capabilityId, request, deps) {
  const explanation = explainResolution(capabilityId, request, deps);
  return explanation.chosen ? deps.deviceRegistry.getDevice(explanation.chosen) : null;
}

function evaluateCandidate(device, request) {
  // A revoked device is ineligible for anything, unconditionally -- no
  // other rule below may ever override this (docs/devices.md's trust
  // lifecycle invariant).
  if (device.trust === 'revoked') {
    return { device: device.id, eligible: false, score: 0, reasons: ['device is revoked'] };
  }

  const reasons = [];
  let eligible = true;

  if (device.status !== 'online') {
    eligible = false;
    reasons.push('device is offline');
  } else {
    reasons.push('online');
  }

  const maxPrivacy = TRUST_MAX_PRIVACY[device.trust] ?? 'public';
  const requestRank = PRIVACY_RANK[request.privacy];
  const maxRank = PRIVACY_RANK[maxPrivacy];

  if (requestRank > maxRank) {
    eligible = false;
    reasons.push(`device trust "${device.trust}" is insufficient for "${request.privacy}" content (max: "${maxPrivacy}")`);
  } else if (request.privacy !== 'public') {
    reasons.push(`trusted sufficiently for "${request.privacy}" content`);
  }

  // Ownership: a device that is any specific person's (not the shared
  // 'household' owner, and not ownerless) can never receive another
  // person's private/sensitive content -- "shared devices must never
  // receive private information merely because they are convenient" also
  // applies in reverse (someone else's personal device isn't "shared"
  // either). Below 'private', shared/household/ownerless devices remain
  // eligible; only a clear owner MISMATCH disqualifies.
  if (request.audience && device.owner && device.owner !== request.audience && device.owner !== 'household') {
    eligible = false;
    reasons.push(`device is owned by "${device.owner}", not the requested audience "${request.audience}"`);
  } else if (requestRank >= PRIVACY_RANK.private && request.audience) {
    if (device.owner !== request.audience) {
      eligible = false;
      reasons.push(`shared device cannot receive "${request.privacy}" content (owner "${device.owner || 'none'}" != audience "${request.audience}")`);
    } else {
      reasons.push('owner match');
    }
  }

  if (request.location && device.location && device.location !== request.location) {
    reasons.push(`location "${device.location}" does not match requested "${request.location}" (not disqualifying)`);
  }

  const score = eligible ? computeScore(device, request) : 0;
  return { device: device.id, eligible, score, reasons };
}

function computeScore(device, request) {
  let score = 50;
  if (request.audience && device.owner === request.audience) score += 30;
  if (device.trust === 'trusted') score += 15;
  if (request.location && device.location === request.location) score += 10;
  return score;
}
