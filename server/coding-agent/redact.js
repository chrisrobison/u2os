// Best-effort secret redaction for coding agent output (docs/coding-agents.md).
// An agent works in a real repository and prints what it reads, so output can
// contain credentials. This catches the common shapes before anything is
// stored, emitted or shown. It is a safety net, not a guarantee: the run
// record is still owner-only data.

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi;
export const REDACTED = '[REDACTED]';

/** redact(text, { secrets }) -- `secrets` are exact values to remove (e.g. the task's own environment). */
export function redact(text, { secrets = [] } = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join(REDACTED);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(ASSIGNMENT, (_m, name, separator, quote) => `${name}${separator}${quote}${REDACTED}${quote}`);
}
