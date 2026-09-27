import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDataDir } from '../db/connection.js';
import { getVaultDir } from '../vault/vault-dir.js';

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

const LEVEL_KEYS = new Set(['always', 'autonomous', 'confirm', 'never']);
// Marks a policy set whose vault file exists but is invalid: the engine then
// requires confirmation for every non-read action (fail closed), because a
// broken file may have been meant to be stricter than the home policy.
export const VAULT_POLICY_INVALID = Symbol('vaultPolicyInvalid');

let lastStatus = { path: null, active: false, error: null };

export function vaultPoliciesPath() {
  return path.join(getVaultDir(), 'policies.yaml');
}

/** Status of the vault policy file, for the owner-only vault API. */
export function getPolicySourceStatus() { return lastStatus; }

/** Cheap change signature for live reload of both policy files. */
export function policySignature(dataDir = getDataDir()) {
  return [policiesPath(dataDir), vaultPoliciesPath()].map((file) => {
    try { const stat = fs.lstatSync(file); return `${file}:${stat.mtimeMs}:${stat.size}:${stat.isFile()}`; } catch { return `${file}:none`; }
  }).join('|');
}

/**
 * Effective action policy: the home policy (U2OS_HOME/policies/policies.yaml)
 * overridden, per domain operation, by the owner's vault policy
 * (<vault>/policies.yaml) when present and valid (docs/policies.md, ADR 0007).
 */
export function loadPolicies(dataDir = getDataDir()) {
  const file = ensureDefaultPolicies(dataDir);
  const home = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const vaultFile = vaultPoliciesPath();
  let stat;
  try { stat = fs.lstatSync(vaultFile); } catch {
    lastStatus = { path: vaultFile, active: false, error: null };
    return home;
  }
  try {
    if (!stat.isFile()) throw new Error('policies.yaml must be a regular file');
    if (stat.size > 64 * 1024) throw new Error('policies.yaml is larger than 64 KiB');
    const vault = yaml.load(fs.readFileSync(vaultFile, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? {};
    validatePolicies(vault);
    const merged = { ...home };
    for (const [domain, operations] of Object.entries(vault)) merged[domain] = { ...(isMapping(home[domain]) ? home[domain] : {}), ...operations };
    lastStatus = { path: vaultFile, active: true, error: null };
    return merged;
  } catch (error) {
    lastStatus = { path: vaultFile, active: false, error: error.reason || error.message };
    const failClosed = { ...home };
    Object.defineProperty(failClosed, VAULT_POLICY_INVALID, { value: true });
    return failClosed;
  }
}

export function validatePolicies(policies) {
  if (!isMapping(policies)) throw new Error('policies.yaml must map domains to operations');
  for (const [domain, operations] of Object.entries(policies)) {
    if (!isMapping(operations)) throw new Error(`${domain}: must map operations to policy levels`);
    for (const [operation, rule] of Object.entries(operations)) {
      const levels = typeof rule === 'string' ? [rule] : isMapping(rule) ? Object.values(rule) : [null];
      for (const level of levels) {
        if (!LEVEL_KEYS.has(level)) throw new Error(`${domain}.${operation}: use always, autonomous, confirm or never`);
      }
    }
  }
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { DEFAULT_POLICIES_YAML };
