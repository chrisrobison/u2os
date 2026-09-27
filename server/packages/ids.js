// Stable identifiers (docs/plugin-architecture.md §2). Identity is never a
// filesystem path and never tied to an implementation language.
//
//   package:com.u2os.job-hunter   capability:web.search
//   skill:company-research        automation:job-hunter

export const PACKAGE_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){1,7}$/;
export const CAPABILITY_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*){1,4}$/;
export const LOCAL_ID = /^[a-z][a-z0-9-]{0,63}$/;

export const REF_KINDS = Object.freeze(['package', 'capability', 'skill', 'automation']);

export function ref(kind, id) {
  return `${kind}:${id}`;
}

/** "skill:score-job" -> { kind: 'skill', id: 'score-job' }, or null. */
export function parseRef(text) {
  const match = /^([a-z]+):(.+)$/.exec(String(text ?? ''));
  if (!match || !REF_KINDS.includes(match[1])) return null;
  const pattern = match[1] === 'package' ? PACKAGE_ID : match[1] === 'capability' ? CAPABILITY_ID : LOCAL_ID;
  return pattern.test(match[2]) ? { kind: match[1], id: match[2] } : null;
}
