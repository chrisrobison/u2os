import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getDataDir } from '../db/connection.js';

// Default data-processing.yaml, written to
// <U2OS_HOME>/policies/data-processing.yaml on first run if it doesn't
// already exist. This is DELIBERATELY a separate file/policy engine from
// policies.yaml/policy-engine.js: "may calendar.reschedule execute?" (tool
// authorization) is a different question from "may this data reach this
// destination?" (data-processing privacy) -- see docs/policies.md and
// server/policy/data-processing-policy.js.
//
// local_models never leave the machine, so every classification defaults
// to `allow` there. remote_models/external_tools tighten as classification
// rises; `sensitive` data is never sent to a remote model or an external
// tool. local_ui (showing the owner their own data) is always allowed --
// there is no reason to ever hide a user's own data from themselves.
const DEFAULT_DATA_PROCESSING_YAML = `public:
  local_models: allow
  remote_models: allow
  external_tools: allow
  local_ui: allow

personal:
  local_models: allow
  remote_models: allow
  external_tools: confirm
  local_ui: allow

private:
  local_models: allow
  remote_models: confirm
  external_tools: confirm
  local_ui: allow

sensitive:
  local_models: allow
  remote_models: never
  external_tools: never
  local_ui: allow
`;

export function dataProcessingPoliciesPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'policies', 'data-processing.yaml');
}

export function ensureDefaultDataProcessingPolicies(dataDir = getDataDir()) {
  const file = dataProcessingPoliciesPath(dataDir);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, DEFAULT_DATA_PROCESSING_YAML, 'utf8');
  }
  return file;
}

export function loadDataProcessingPolicies(dataDir = getDataDir()) {
  const file = ensureDefaultDataProcessingPolicies(dataDir);
  const raw = fs.readFileSync(file, 'utf8');
  return yaml.load(raw) || {};
}

export { DEFAULT_DATA_PROCESSING_YAML };
