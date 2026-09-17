import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDataDir } from '../db/connection.js';

// Default policies.yaml, written to <U2OS_HOME>/policies/policies.yaml on
// first run if the file does not already exist.
//
// Reconciliation note: docs/policies.md's illustrative example includes
// `calendar.reschedule.personal: autonomous`. The vertical-slice acceptance
// test in docs/architecture.md, however, explicitly requires that
// rescheduling Sarah's ('personal' category) meeting REQUIRE confirmation.
// We resolve the discrepancy by not shipping a blanket "personal: autonomous"
// rule here -- personal reschedules fall through to `default: confirm` below,
// so the seed "Sync with Sarah" event (category 'personal') genuinely
// exercises the approval flow end to end, consistent with
// docs/architecture.md's own walkthrough of the vertical slice.
const DEFAULT_POLICIES_YAML = `email:
  read: always
  draft: always
  send:
    friends: autonomous
    business: confirm
    legal: never

calendar:
  create: autonomous
  reschedule:
    interviews: confirm
    default: confirm

contacts:
  search: always

tasks:
  create: autonomous
  complete: autonomous

notifications:
  send: autonomous

payments:
  under_50: confirm
  over_50: never
`;

export function policiesPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'policies', 'policies.yaml');
}

export function ensureDefaultPolicies(dataDir = getDataDir()) {
  const file = policiesPath(dataDir);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, DEFAULT_POLICIES_YAML, 'utf8');
  }
  return file;
}

export function loadPolicies(dataDir = getDataDir()) {
  const file = ensureDefaultPolicies(dataDir);
  const raw = fs.readFileSync(file, 'utf8');
  return yaml.load(raw) || {};
}

export { DEFAULT_POLICIES_YAML };
